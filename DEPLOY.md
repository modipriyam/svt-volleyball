# Deploy to the cloud (free, always-on, shareable in advance)

This puts the scoring app on **Render** (free, no credit card) with **Upstash
Redis** (free, no card) so scores **persist** across restarts. You get a
permanent URL like `https://svt-volleyball.onrender.com` that works before,
during, and after the event — and your short link `tinyurl.com/svtliveboston`
auto-points to it.

> Note: with cloud hosting, the umpire scoring and OBS overlay run over the
> internet, so the venue needs reliable connectivity. (Scoring is no longer
> local to the laptop.)

## 1. Create a free Upstash Redis database (stores the scores)
1. Go to **https://upstash.com** → sign up (free, no card) → **Create Database**
   (Redis, any region near you).
2. On the database page, open the **REST API** section and copy:
   - **UPSTASH_REDIS_REST_URL**  (looks like `https://xxxx.upstash.io`)
   - **UPSTASH_REDIS_REST_TOKEN** (a long token)

## 2. Put this project on GitHub
From this folder:
```
git init
git add .
git commit -m "Suhradam Volleyball scoring app"
```
Create a new repo on github.com, then:
```
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```
(`data/` and `node_modules/` are git-ignored — local scores/keys aren't pushed.)

## 3. Deploy on Render
1. Go to **https://render.com** → sign up (free, no card).
2. **New → Blueprint** → connect your GitHub repo. Render reads `render.yaml`
   and creates the web service. (Or **New → Web Service**: Build `npm install`,
   Start `node server.js`, Plan **Free**.)
3. In the service’s **Environment**, set these variables:
   | Key | Value |
   |-----|-------|
   | `UPSTASH_REDIS_REST_URL` | (from Upstash) |
   | `UPSTASH_REDIS_REST_TOKEN` | (from Upstash) |
   | `TINYURL_TOKEN` | your TinyURL API token |
   | `SHORT_ALIAS` | `svtliveboston` |
   | `DISABLE_MDNS` | `1` |
   (Render sets `PORT` and `RENDER_EXTERNAL_URL` automatically.)
4. **Deploy.** When it’s live you get `https://<name>.onrender.com`.

## 4. Done — your permanent links
- Fan: `https://<name>.onrender.com/fan`
- Umpire: `…/umpire` · Admin: `…/admin` · Overlays: `…/overlay?game=1` & `?game=2`
- Short link (auto-pointed on boot): **`https://tinyurl.com/svtliveboston`** → fan page

Share `tinyurl.com/svtliveboston` in advance. Scores are saved in Upstash, so a
restart/redeploy won’t lose them.

### Notes
- **Free tier sleeps after ~15 min idle** → the first visit after a quiet spell
  takes ~30–50s to wake (cold start). During an active event with traffic it
  stays awake. To avoid cold starts entirely, a paid Render instance ($7/mo)
  stays always-on — optional.
- Local use is unchanged: without the Upstash env vars, the app uses local JSON
  files and the laptop + tunnel flow exactly as before.
