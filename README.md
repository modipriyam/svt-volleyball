# 🏐 Suhradam Volleyball Scoring System

A self-contained scoring system for a local volleyball tournament. One small
server runs on a laptop and powers three views over the local WiFi — **no
internet required at the venue**:

| View | URL | Who |
|------|-----|-----|
| **Admin / Umpire** | `/admin` | You (laptop) and the scorekeeper (phone) |
| **OBS Overlay** | `/overlay` | OBS Browser Source on the streaming PC |
| **Fan Live Page** | `/fan` | Fans on their phones (via QR or `.local` name) |

---

## Quick start (any machine)

You only need **Node.js 18+** installed once (https://nodejs.org — get the LTS).

### macOS
Double-click **`start.command`** (or run `./start.command` in Terminal).

> First time: if macOS blocks it, right-click → **Open**, or run
> `chmod +x start.command` once.

### Windows
Double-click **`start.bat`**.

### Any OS (manual)
```bash
npm install      # first run only (needs internet)
npm start
```

The launcher checks Node, installs dependencies on first run, then starts the
server. Leave the window open; **Ctrl+C** stops it.

On startup it prints every URL you need, e.g.:

```
Admin / Scorer:  http://localhost:3000/admin   |  http://192.168.1.42:3000/admin
OBS Overlay:     http://localhost:3000/overlay
Fan Live Page:   http://SuhradamVollyball.local:3000/fan  |  http://192.168.1.42:3000/fan
```

---

## How fans connect (no typing an IP)

1. **QR code** — the admin page shows a QR for the fan page. Display it on a
   screen or print it for a sign; fans scan it with their phone camera. Most
   reliable across all phones.
2. **Friendly name** — fans can type `http://SuhradamVollyball.local:3000/fan`.
   Works best on iPhone/Mac; Android support varies, so prefer the QR there.

Everyone (phones, OBS PC) must be on the **same WiFi/hotspot** as the laptop.

---

## Go live on the internet (off-site viewing + scoring)

The laptop stays the server; a free **Cloudflare tunnel** publishes a public
link anyone, anywhere can open — no router setup needed.

1. One-time install: `brew install cloudflared`
2. Keep **start.command** running (the server).
3. Double-click **share.command**. After ~10s it prints a public link like
   `https://random-words.trycloudflare.com` and a QR.
   - Fan page: `…trycloudflare.com/fan`  (share with everyone)
   - Admin/scoring: `…trycloudflare.com/admin`
   - The link + QR also appear on **Admin → Settings → Public Link**.
4. Keep the share.command window open to stay live; close it / Ctrl+C to stop.

Notes:
- The public link is **temporary** and **changes every time** you run
  share.command. Share the current one.
- ⚠️ There is **no password** — anyone with the link can also open `/admin` and
  change the score. Keep the admin link private; only post the `/fan` link
  publicly. (Ask to add a password if you want admin protected.)

## OBS setup

Add a **Browser Source** → set the URL to `http://localhost:3000/overlay`,
width `1920`, height `1080`. The background is transparent, so the scoreboard
sits over your video. Drag/scale it in the bottom-left as you like.

---

## Using it (umpire flow)

1. **Schedule** — add fixtures (Team A vs Team B).
2. **▶ Start** a fixture → it becomes live, the timer starts.
3. Score with **+1 / −1**, set the serving team, adjust sets.
   - Tap any number to **type an exact value** (fix mistakes).
   - **↶ Undo** reverts the last action.
   - **Pause/Resume** freezes the match clock.
   - **Next Set ▸** records the set score and starts the next set.
   - **End Game** freezes the final result onto the fixture.
4. **Announcement** pushes a banner to the fan page.
5. **YouTube link** (optional) embeds a live stream on the fan page.

---

## Data & files

- All state lives in **`data/state.json`** — your single source of truth. It
  survives restarts and can be inspected/backed up by copying the file.
- To start a fresh event, stop the server and delete `data/state.json` (or just
  use **Reset Match** / delete fixtures from the admin page).

## Tech

Node.js + Express, vanilla HTML/JS frontends, JSON file storage, mDNS
(`bonjour-service`) for the `.local` name, and `qrcode` for the fan QR. No
database, no build step.
