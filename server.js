'use strict';

/*
 * Suhradam Volleyball Scoring — single-server backend.
 *
 * Serves three pages (admin/umpire, OBS overlay, fan) and a small JSON API.
 * State lives in data/state.json (the single source of truth) and is held in
 * memory while running. Clients stay in sync by polling /api/state.
 *
 * No internet required at the venue — everything runs on the local WiFi.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const { Bonjour } = require('bonjour-service');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const HOSTNAME = 'SuhradamVollyball'; // advertised over mDNS -> SuhradamVollyball.local
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

// ---------------------------------------------------------------------------
// State: load / save / defaults
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    fixtures: [],
    youtubeUrl: '',
    showWatch: false,     // whether the "Watch Live" button shows on the fan page
    showServe: false,     // whether serve tracking (buttons + indicator) is enabled
    champion: '',         // tournament champion team name ('' = none)
    runnerUp: '',         // tournament runner-up team name ('' = none)
    announcement: '',
    publicUrl: '',        // public tunnel URL (set by share.command), shown as a QR in admin
    shortUrl: '',         // shortened fan link (via is.gd) for easy sharing
    games: [],            // up to 2 concurrent live games: { slot:1|2, fixtureId, live }
  };
}

const MAX_GAMES = 2;
const SHORT_ALIAS = process.env.SHORT_ALIAS || 'svt-live';  // custom TinyURL alias for the fan link
const TINYURL_TOKEN = process.env.TINYURL_TOKEN || '';      // set this to keep the alias CONSTANT across tunnel restarts

function blankLive() {
  return {
    pointsA: 0,
    pointsB: 0,
    setsA: 0,
    setsB: 0,
    currentSet: 1,
    totalSets: 3,     // best-of N (number of set dots shown)
    serving: 'A',
    setHistory: [],
    pointLog: [],     // chronological record of every point scored this game
    paused: false,
    startedAt: null,
    elapsedMs: 0,
    // internal: wall-clock time the timer last resumed; used to compute live elapsed.
    _lastResumeAt: null,
  };
}

// Storage: Upstash Redis when configured (cloud hosting), else local JSON files (dev).
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useRedis = !!(REDIS_URL && REDIS_TOKEN);
const SKEY = 'svt:state', VKEY = 'svt:vapid', SUBKEY = 'svt:subs';

async function redisCmd(args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  return j.result;
}
const kvGet = (k) => redisCmd(['GET', k]).catch(() => null);
const kvSet = (k, v) => redisCmd(['SET', k, v]).catch(() => {});

let state;

function normalizeState() {
  if (!Array.isArray(state.games)) state.games = [];
  state.games.forEach((g) => { g.live = Object.assign(blankLive(), g.live || {}); });
  delete state.activeMatchId; delete state.live;  // migrate old single-game saves
}

async function loadState() {
  if (useRedis) {
    try {
      const raw = await kvGet(SKEY);
      if (raw) { state = Object.assign(defaultState(), JSON.parse(raw)); normalizeState(); return; }
    } catch (err) { console.error('⚠️  Redis load failed:', err.message); }
    state = defaultState(); persistNow();
    return;
  }
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      state = Object.assign(defaultState(), JSON.parse(raw)); normalizeState(); return;
    }
  } catch (err) {
    console.error('⚠️  Could not read state.json, starting fresh:', err.message);
  }
  state = defaultState(); persistNow();
}

let saveTimer = null;
function persistNow() {
  const raw = JSON.stringify(state);
  if (useRedis) { kvSet(SKEY, raw); return; }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { console.error('⚠️  Failed to write state:', err.message); }
}
function saveState() {  // debounced
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 150);
}

// ---------------------------------------------------------------------------
// Undo: snapshot stack (in-memory only, cleared on restart)
// ---------------------------------------------------------------------------

const UNDO_LIMIT = 20;
const undoStack = [];

function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
  if (undoStack.length === 0) return false;
  state = JSON.parse(undoStack.pop());
  saveState();
  return true;
}

// ---------------------------------------------------------------------------
// Timer helpers (elapsed time accrues only while not paused)
// ---------------------------------------------------------------------------

// Returns elapsedMs including the currently-running segment (if not paused).
function computedElapsed(live) {
  let ms = live.elapsedMs || 0;
  if (!live.paused && live._lastResumeAt) {
    ms += Date.now() - live._lastResumeAt;
  }
  return ms;
}

// Folds the running segment back into elapsedMs and stops the running clock.
function freezeElapsed(live) {
  live.elapsedMs = computedElapsed(live);
  live._lastResumeAt = null;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function genId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function findFixture(id) {
  return state.fixtures.find((f) => f.id === id);
}

// --- Multi-game helpers ---
function findGame(fixtureId) {
  return state.games.find((g) => g.fixtureId === fixtureId);
}
function freeSlot() {
  for (let s = 1; s <= MAX_GAMES; s++) if (!state.games.some((g) => g.slot === s)) return s;
  return null;
}
// Resolve which game an endpoint targets: explicit `game` (fixtureId) in the
// body, else the only running game if there's exactly one.
function gameFromReq(req) {
  const id = req.body && (req.body.game || req.body.fixtureId);
  if (id) return findGame(id);
  return state.games.length === 1 ? state.games[0] : null;
}

// Public view of one game (resolved team info + computed elapsed).
function publicGame(g) {
  const f = findFixture(g.fixtureId) || {};
  const live = Object.assign({}, g.live);
  live.elapsedMs = computedElapsed(g.live);
  delete live._lastResumeAt;
  return { slot: g.slot, fixtureId: g.fixtureId, teamA: f.teamA, teamB: f.teamB,
    captainA: f.captainA || '', captainB: f.captainB || '', live };
}

// The state we send to clients.
function publicState() {
  return {
    fixtures: state.fixtures,
    youtubeUrl: state.youtubeUrl,
    showWatch: state.showWatch,
    showServe: state.showServe,
    champion: state.champion || '',
    runnerUp: state.runnerUp || '',
    announcement: state.announcement,
    publicUrl: state.publicUrl || '',
    shortUrl: state.shortUrl || '',
    games: state.games.map(publicGame).sort((a, b) => a.slot - b.slot),
  };
}

// --- Server-Sent Events: push state to clients instantly on every change ----

const sseClients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

// ---------------------------------------------------------------------------
// Web Push (Android + iOS-PWA notifications)
// ---------------------------------------------------------------------------

let PUBLIC_VAPID = '';
let subscriptions = [];

async function initPush() {
  let vapid = null;
  if (useRedis) {
    try { const raw = await kvGet(VKEY); if (raw) vapid = JSON.parse(raw); } catch (e) {}
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch (e) {}
  }
  if (!vapid || !vapid.publicKey || !vapid.privateKey) {
    vapid = webpush.generateVAPIDKeys();
    if (useRedis) await kvSet(VKEY, JSON.stringify(vapid));
    else fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2));
  }
  PUBLIC_VAPID = vapid.publicKey;
  // Apple's push service rejects VAPID tokens whose subject isn't a real
  // mailto:/https: (e.g. a .local domain -> 403 BadJwtToken), so use a real one.
  webpush.setVapidDetails('mailto:gondalia.h@northeastern.edu', vapid.publicKey, vapid.privateKey);
  if (useRedis) { try { const raw = await kvGet(SUBKEY); subscriptions = raw ? JSON.parse(raw) : []; } catch (e) { subscriptions = []; } }
  else { try { subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) || []; } catch (e) { subscriptions = []; } }
}

function saveSubs() {
  const raw = JSON.stringify(subscriptions);
  if (useRedis) { kvSet(SUBKEY, raw); return; }
  try { fs.writeFileSync(SUBS_FILE, raw); } catch (e) {}
}

// Fire-and-forget push to every subscriber; prune expired subscriptions.
function sendPush(payload) {
  const data = JSON.stringify(payload);
  subscriptions.slice().forEach((sub) => {
    webpush.sendNotification(sub, data).catch((err) => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        subscriptions = subscriptions.filter((s) => s.endpoint !== sub.endpoint);
        saveSubs();
      }
    });
  });
}

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// Clamp helper for numeric inputs.
function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Wrap a mutating handler so it snapshots for undo, then returns fresh state.
function mutate(handler) {
  return (req, res) => {
    snapshot();
    try {
      const result = handler(req, res);
      if (res.headersSent) return;
      if (result && result.error) {
        undoStack.pop(); // nothing changed; discard the snapshot
        return res.status(result.status || 400).json({ error: result.error });
      }
      saveState();
      broadcast();
      res.json(publicState());
    } catch (err) {
      undoStack.pop();
      console.error('Handler error:', err);
      res.status(500).json({ error: 'server error' });
    }
  };
}

// --- Read -------------------------------------------------------------------

app.get('/api/state', (req, res) => res.json(publicState()));

// Live push stream. Clients (overlay/fan/admin) get the full state immediately
// and again on every change — no polling lag.
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  sseClients.add(res);
  // Heartbeat keeps the connection alive through proxies/idle timeouts.
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// --- Fixtures ---------------------------------------------------------------

app.post('/api/fixtures', mutate((req) => {
  const { teamA, teamB, captainA, captainB } = req.body || {};
  if (!teamA || !teamB) return { error: 'teamA and teamB are required' };
  state.fixtures.push({
    id: genId(),
    teamA: String(teamA).trim(),
    teamB: String(teamB).trim(),
    captainA: String(captainA || '').trim(),
    captainB: String(captainB || '').trim(),
    status: 'upcoming',
  });
}));

app.put('/api/fixtures/:id', mutate((req) => {
  const f = findFixture(req.params.id);
  if (!f) return { error: 'fixture not found', status: 404 };
  const { teamA, teamB, captainA, captainB, status } = req.body || {};
  if (teamA !== undefined) f.teamA = String(teamA).trim();
  if (teamB !== undefined) f.teamB = String(teamB).trim();
  if (captainA !== undefined) f.captainA = String(captainA).trim();
  if (captainB !== undefined) f.captainB = String(captainB).trim();
  if (status && ['upcoming', 'live', 'done'].includes(status)) f.status = status;
}));

app.delete('/api/fixtures/:id', mutate((req) => {
  const idx = state.fixtures.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return { error: 'fixture not found', status: 404 };
  const [removed] = state.fixtures.splice(idx, 1);
  // If it was a live game, drop it.
  state.games = state.games.filter((g) => g.fixtureId !== removed.id);
}));

// --- Game lifecycle ---------------------------------------------------------

app.post('/api/fixtures/:id/start', mutate((req) => {
  const f = findFixture(req.params.id);
  if (!f) return { error: 'fixture not found', status: 404 };
  if (findGame(f.id)) return { error: 'this match is already live' };
  let slot = req.body && parseInt(req.body.slot, 10);
  if (slot === 1 || slot === 2) {
    if (state.games.some((g) => g.slot === slot)) return { error: `Court ${slot} is already in use.` };
  } else {
    slot = freeSlot();
  }
  if (!slot) return { error: 'Both courts are in use — end a game first.' };
  f.status = 'live';
  const live = blankLive();
  const sets = req.body && parseInt(req.body.sets, 10);
  if (Number.isFinite(sets) && sets >= 1 && sets <= 15) live.totalSets = sets;
  live.startedAt = new Date().toISOString();
  live._lastResumeAt = Date.now();
  state.games.push({ slot, fixtureId: f.id, live });
  sendPush({ title: '🏐 Match Starting', body: `${f.teamA} vs ${f.teamB} — live now!`, tag: 'match-' + f.id, url: '/fan' });
}));

app.post('/api/game/pause', mutate((req) => {
  const g = gameFromReq(req); if (!g) return { error: 'game not found' };
  const paused = !!(req.body && req.body.paused);
  if (paused && !g.live.paused) { freezeElapsed(g.live); g.live.paused = true; }
  else if (!paused && g.live.paused) { g.live.paused = false; g.live._lastResumeAt = Date.now(); }
}));

app.post('/api/game/next-set', mutate((req) => {
  const g = gameFromReq(req); if (!g) return { error: 'game not found' };
  const l = g.live;
  if (l.setsA + l.setsB >= l.totalSets) return { error: `All ${l.totalSets} sets have been played — End the game.` };
  if (l.pointsA === l.pointsB) return { error: 'Set is tied — a set needs a winner before moving on.' };
  l.setHistory.push([l.pointsA, l.pointsB]);
  if (l.pointsA > l.pointsB) l.setsA += 1; else l.setsB += 1;
  l.pointsA = 0;
  l.pointsB = 0;
  l.currentSet = Math.min(l.setsA + l.setsB + 1, l.totalSets);   // set being played, capped at total
}));

app.post('/api/game/end', mutate((req) => {
  const g = gameFromReq(req); if (!g) return { error: 'game not found' };
  const f = findFixture(g.fixtureId);
  const l = g.live;
  freezeElapsed(l);
  const sets = l.setHistory.slice();
  if (l.pointsA > 0 || l.pointsB > 0) sets.push([l.pointsA, l.pointsB]);
  if (f) {
    const winner = l.setsA === l.setsB ? null : l.setsA > l.setsB ? 'A' : 'B';
    f.status = 'done';
    f.result = { winner, setsA: l.setsA, setsB: l.setsB, sets, elapsedMs: l.elapsedMs, pointLog: l.pointLog || [] };
    const wName = winner ? (winner === 'A' ? f.teamA : f.teamB) : null;
    sendPush({
      title: '🏁 Full Time — ' + f.teamA + ' vs ' + f.teamB,
      body: `${f.teamA} ${l.setsA}–${l.setsB} ${f.teamB}` + (wName ? ` · 🏆 ${wName} win!` : ''),
      tag: 'result-' + f.id, url: '/fan',
    });
  }
  state.games = state.games.filter((x) => x !== g);
}));

// --- Scoring ----------------------------------------------------------------

function applyDeltaOrValue(current, body) {
  if (body && body.value !== undefined) return Math.max(0, toInt(body.value, current));
  if (body && body.delta !== undefined) return Math.max(0, current + toInt(body.delta, 0));
  return current;
}

app.post('/api/score', mutate((req) => {
  const g = gameFromReq(req); if (!g) return { error: 'game not found' };
  const team = req.body && req.body.team;
  if (team !== 'A' && team !== 'B') return { error: 'team must be A or B' };
  const live = g.live;
  const key = team === 'A' ? 'pointsA' : 'pointsB';
  const old = live[key];
  live[key] = applyDeltaOrValue(live[key], req.body);
  const diff = live[key] - old;
  if (!live.pointLog) live.pointLog = [];
  const log = live.pointLog;
  if (diff > 0) {
    for (let i = 0; i < diff; i++) {
      log.push({ t: Date.now(), team, a: live.pointsA, b: live.pointsB, set: live.currentSet });
    }
  } else if (diff < 0) {
    let rm = -diff;
    for (let i = log.length - 1; i >= 0 && rm > 0; i--) {
      if (log[i].team === team) { log.splice(i, 1); rm--; }
    }
  }
}));

app.post('/api/sets', mutate((req) => {
  const g = gameFromReq(req); if (!g) return { error: 'game not found' };
  const team = req.body && req.body.team;
  if (team !== 'A' && team !== 'B') return { error: 'team must be A or B' };
  const key = team === 'A' ? 'setsA' : 'setsB';
  g.live[key] = applyDeltaOrValue(g.live[key], req.body);
}));

app.post('/api/serve', mutate((req) => {
  const g = gameFromReq(req); if (!g) return { error: 'game not found' };
  const team = req.body && req.body.team;
  if (team !== 'A' && team !== 'B') return { error: 'team must be A or B' };
  g.live.serving = team;
}));

app.post('/api/set-number', mutate((req) => {
  const g = gameFromReq(req); if (!g) return { error: 'game not found' };
  g.live.currentSet = Math.max(1, applyDeltaOrValue(g.live.currentSet, req.body));
}));

app.post('/api/match', mutate((req) => {
  if (req.body && req.body.youtubeUrl !== undefined) {
    state.youtubeUrl = String(req.body.youtubeUrl).trim();
  }
  if (req.body && req.body.showWatch !== undefined) {
    state.showWatch = !!req.body.showWatch;
  }
  if (req.body && req.body.showServe !== undefined) {
    state.showServe = !!req.body.showServe;
  }
  if (req.body && req.body.champion !== undefined) {
    state.champion = String(req.body.champion).trim();
    if (state.champion) sendPush({ title: '🏆 Champions!', body: state.champion + ' win Suhradam Volleyball Season 2!', tag: 'champion' });
  }
  if (req.body && req.body.runnerUp !== undefined) {
    state.runnerUp = String(req.body.runnerUp).trim();
  }
}));

app.post('/api/announcement', mutate((req) => {
  state.announcement = String((req.body && req.body.text) || '').trim();
  if (state.announcement) sendPush({ title: '📢 SVT', body: state.announcement, tag: 'announce' });
}));

app.post('/api/reset', mutate((req) => {
  const g = gameFromReq(req); if (!g) return { error: 'game not found' };
  const type = req.body && req.body.type;
  if (type === 'set') {
    g.live.pointsA = 0;
    g.live.pointsB = 0;
  } else if (type === 'match') {
    const startedAt = g.live.startedAt;
    g.live = blankLive();
    g.live.startedAt = startedAt;
    g.live._lastResumeAt = Date.now();
  } else {
    return { error: 'type must be "set" or "match"' };
  }
}));

// --- Web Push subscription endpoints ---
app.get('/api/push/key', (req, res) => res.json({ key: PUBLIC_VAPID }));

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
  if (!subscriptions.find((s) => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    saveSubs();
  }
  res.json({ ok: true, count: subscriptions.length });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const ep = req.body && req.body.endpoint;
  subscriptions = subscriptions.filter((s) => s.endpoint !== ep);
  saveSubs();
  res.json({ ok: true });
});

// Sets the public URL (from share.command for a tunnel, or auto from the cloud
// host) and refreshes the short link. Surfaced as a QR in admin.
function setPublicUrl(url) {
  state.publicUrl = String(url || '').trim();
  state.shortUrl = '';
  saveState();
  broadcast();
  if (!state.publicUrl) return;
  const target = state.publicUrl.replace(/\/+$/, '') + '/fan';
  const setShort = (u) => { if (u) { state.shortUrl = u; saveState(); broadcast(); } };
  if (TINYURL_TOKEN) {
    // Token mode: keep a CONSTANT alias, updating it to the current link each time.
    const headers = { Authorization: 'Bearer ' + TINYURL_TOKEN, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ domain: 'tinyurl.com', alias: SHORT_ALIAS, url: target });
    fetch('https://api.tinyurl.com/change', { method: 'PATCH', headers, body })           // update existing alias
      .then((r) => (r.ok ? r : fetch('https://api.tinyurl.com/create', { method: 'POST', headers, body }))) // else create it
      .then((r) => { if (r.ok) setShort('https://tinyurl.com/' + SHORT_ALIAS); })
      .catch(() => {});
  } else {
    const enc = encodeURIComponent(target);
    const get = (u) => fetch(u).then((r) => r.text()).then((t) => { t = (t || '').trim(); return t.startsWith('http') ? t : null; });
    get('https://tinyurl.com/api-create.php?alias=' + encodeURIComponent(SHORT_ALIAS) + '&url=' + enc)
      .then((u) => u || get('https://tinyurl.com/api-create.php?url=' + enc))
      .then(setShort).catch(() => {});
  }
}

app.post('/api/public-url', (req, res) => {
  setPublicUrl((req.body && req.body.url) || '');
  res.json({ ok: true, publicUrl: state.publicUrl });
});

app.post('/api/undo', (req, res) => {
  const ok = undo();
  if (!ok) return res.status(400).json({ error: 'nothing to undo' });
  broadcast();
  res.json(publicState());
});

// --- QR code ----------------------------------------------------------------

app.get('/api/qr', async (req, res) => {
  let url;
  if (req.query.url) {
    url = String(req.query.url);
  } else {
    const ip = getLanIp() || 'localhost';
    const targetPath = req.query.path || '/fan';
    url = `http://${ip}:${PORT}${targetPath}`;
  }
  try {
    res.type('png');
    const buf = await QRCode.toBuffer(url, { width: 300, margin: 2 });
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'qr failed' });
  }
});

// --- Pages ------------------------------------------------------------------

app.get('/', (req, res) => res.redirect('/umpire'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/umpire', (req, res) => res.sendFile(path.join(__dirname, 'public', 'umpire.html')));
app.get('/overlay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/fan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'fan.html')));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

(async () => {
  await loadState();
  await initPush();
  // On a cloud host, the app's own URL is the public link — auto-register it
  // so the fan QR + short link point at it (and stay shareable in advance).
  const cloudUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (cloudUrl) setPublicUrl(cloudUrl);
  startServer();
})();

function startServer() {
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLanIp();
  const line = '─'.repeat(60);
  console.log('\n' + line);
  console.log('  🏐  Suhradam Volleyball Scoring — server running');
  console.log(line);
  console.log('  Admin / Scorer (this laptop):');
  console.log(`     http://localhost:${PORT}/admin`);
  if (ip) console.log(`     http://${ip}:${PORT}/admin   (phone on same WiFi)`);
  console.log('');
  console.log('  OBS Overlay (Browser Source):');
  console.log(`     http://localhost:${PORT}/overlay`);
  console.log('');
  console.log('  Fan Live Page (share this with fans):');
  console.log(`     http://${HOSTNAME}.local:${PORT}/fan`);
  if (ip) console.log(`     http://${ip}:${PORT}/fan`);
  console.log(`     QR code shown on the admin page → scan to open`);
  console.log(line);
  console.log('  Press Ctrl+C to stop.\n');

  // Advertise a friendly .local hostname via mDNS so fans can type
  // http://SuhradamVollyball.local:PORT/fan (works best on iPhone/macOS).
  //
  // IMPORTANT: we advertise a DEDICATED host (`SuhradamVollyball.local`) mapped
  // to this machine's LAN IP. We must NOT let the responder defend the OS
  // hostname (its default), because that collides with macOS's own
  // mDNSResponder and makes macOS rename the computer (e.g. MacBook-Pro-2.local).
  // Passing an explicit `host` keeps our responder scoped to our own name only.
  //
  // Set DISABLE_MDNS=1 to skip this entirely (QR + IP URL still work fine).
  if (process.env.DISABLE_MDNS !== '1') {
    try {
      const bonjour = new Bonjour();
      const opts = { name: HOSTNAME, type: 'http', port: PORT, host: `${HOSTNAME}.local` };
      if (ip) opts.txt = { ip };
      bonjour.publish(opts);
      console.log(`  (mDNS: advertising ${HOSTNAME}.local — set DISABLE_MDNS=1 to turn off)\n`);
    } catch (err) {
      console.warn('  mDNS advertising unavailable (QR/IP still work):', err.message);
    }
  }
});
}
