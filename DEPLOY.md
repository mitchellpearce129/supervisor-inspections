# Deploying the Supervisor Inspections App

This is a **static PWA** — no build step, no bundler. The whole folder *is* the
deployable. Paths are all relative, so it works from a domain root **or** a
GitHub Pages subpath (`/<repo>/`), and moving from public Pages to an internal
HTTPS host later is a zero-code change.

> **Must be served over HTTPS** (or `localhost`). The live camera and the
> service worker both require a secure context — a plain `http://` host (other
> than localhost) will silently disable them.

---

## Current plan

- **Now — public GitHub Pages**, for on-device testing ("does it work on a real iPad?").
- **Later — internal HTTPS host** (IIS on an SBG box the iPads reach). Same files;
  just point the internal host at this folder. See *Moving to internal HTTPS* below.

---

## Option A — GitHub Pages (public, for testing)

1. **Create a new, empty GitHub repo** (e.g. `supervisor-inspections`). It must be
   its own repo — this app is gitignored inside `SBG-SQL-Server` and can't ship from there.
2. **Copy this folder's contents to the repo root** (everything except `tools/` and
   the docs are runtime; copying them too is harmless). The repo root should contain
   `index.html`, `manifest.json`, `sw.js`, `.nojekyll`, `css/`, `js/`, `assets/`, `icons/`, `data/`.
3. From the repo root:
   ```bash
   git init
   git add .
   git commit -m "Supervisor Inspections App — initial deploy"
   git branch -M main
   git remote add origin https://github.com/<you>/supervisor-inspections.git
   git push -u origin main
   ```
4. **Enable Pages:** repo → Settings → Pages → Source = `Deploy from a branch`,
   Branch = `main`, folder = `/ (root)` → Save.
5. Wait ~1 min. URL will be `https://<you>.github.io/supervisor-inspections/`.
6. On the iPad, open that URL in **Safari**. To install as an app: Share →
   **Add to Home Screen** (optional — testing in a Safari tab works too).

`.nojekyll` (already in this folder) tells Pages to serve every file verbatim
instead of running Jekyll, which would otherwise mangle/skip some paths.

## Redeploying a change

1. **Bump the service-worker cache version** in [`sw.js`](sw.js) — e.g.
   `supervisor-inspections-v2` → `-v3`. Without this, devices keep serving the old
   cached code and won't see your change.
2. Commit + push. Pages redeploys automatically.

## Refreshing the report logos

The report logos are bundled under `assets/` (they can't be fetched cross-origin at
runtime — the image hosts send no CORS header). To refresh them from source:
```bash
node tools/refresh-logos.js
```
Then redeploy (and bump the SW cache version).

---

## Moving to internal HTTPS (later)

1. Copy the same folder to the internal web server's root (IIS site / virtual dir).
2. Ensure the site has a **valid HTTPS cert** and the iPads can resolve + reach it.
3. No code changes needed — relative paths and the SW just work under the new origin.
4. Confirm the ClickHome API hosts are reachable from wherever the app is served
   (they already send permissive CORS, so a browser client can call them).

---

## ⚠️ Security note — public deployment

This is a client-side PWA, so **anything in the source is readable by anyone who can
load the page** — including the `agent` account password hard-wired in
[`js/config.js`](js/config.js). While it's on public Pages:

- Keep that account **least-privilege** and **TEST-only**.
- **Rotate the `claude.agent` and `jacka` TEST passwords** — they've been shared in
  development transcripts.
- Don't point the public build at any PROD ClickHome system.

Moving to the internal HTTPS host removes the public-exposure problem (but a
determined internal user can still read client-side source — the least-privilege
rule stands).
