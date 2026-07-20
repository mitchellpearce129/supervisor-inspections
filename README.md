# Supervisor Inspections App

A fast, reliable replacement for the ClickHome iPad inspection UI. Supervisors
capture inspection responses + **unlimited** photos offline, review, sign, and
commit — and **nothing is ever silently lost**: files stay on the device until
the server confirms receipt.

## The core idea

We do **not** write ClickHome's inspection data model (`tblInspResults`, the
two-phase area fan-out, S3 file-configs, the SOAP iPad sync). Inspection data
only exists to produce a report + email — so instead the app:

1. Captures answers/photos/comments/signatures against a template,
2. Generates the finished inspection document (`.odt` + `.pdf`) **on device**,
3. Uploads that document + photos as **files** via the ClickHome **V2 REST API**,
   tagged with an `ExtRef` = the inspection template,
4. ClickHome-side, a hook (`prcCustomFileInsert`) or an agent closes the
   inspection out. (This backend piece is the tail of the project.)

The app-generated document is therefore the record of truth.

## Flow

Login → Job list → Inspection types → Template → Capture → Review → Finalise
(sign) → Commit (generate docs + upload with retry).

## Architecture

- **Vanilla JS PWA** (no framework, no build step), installable, offline-capable.
  Same delivery model as REWMitch; hosts fine on GitHub Pages.
- **Auth**: `POST {api}/V2/Login` with `{username,password}`; the session token
  comes back in the **`ClickHomeApiToken` response header**. Confirmed
  2026-07-16 that the API reflects arbitrary origins into `Allow-Origin` and
  lists `ClickHomeApiToken` in `Access-Control-Expose-Headers`, so a browser
  PWA can read it — **no native wrapper required**.
- **Reads** use the custom `SEARCH` verb + a JSON selection tree, `Accept:
  application/json` (WCF defaults to XML otherwise).
- **No local database.** Optional local JSON cache of template config + job
  list, each refreshable.
- **Reliability**: captured files persist locally and are only moved to a
  "synced" state once the upload returns an `idFile`. Unconfirmed uploads are
  retried. The only expected failure modes are bad credentials or connectivity.

## Environments

Configured in `js/config.js`. Defaults to **TEST**; override with `?env=PROD`.

| Env  | API base |
|------|----------|
| TEST | `https://clickhome.homegroup.com.au/ClickHome3WebServiceMetroTest` |
| PROD | `https://clickhome.homegroup.com.au/ClickHome3WebserviceMetro` |

## Running locally

The app needs a **secure context** (service worker + camera), so serve over
`http://localhost` (or HTTPS) — `file://` will not work. From this folder:

```
npx serve .
# or
python -m http.server 8080
```

then open `http://localhost:8080/`.

## Status

- [x] Project scaffold, PWA shell, offline service worker
- [x] Login → reads `ClickHomeApiToken`, shows CurrentUserModel
- [ ] Job list (needs captured supervisor-scoped `Contracts/List` call)
- [ ] Inspection types for a contract (+ ad-hoc)
- [ ] Template config → capture form
- [ ] Review + signature
- [ ] On-device `.odt` / `.pdf` generation
- [ ] File upload with retry + synced-state tracking
- [ ] ClickHome-side close-out (`prcCustomFileInsert` / agent)

## Reference

- API: `Knowledge/Databases/ClickHome/ClickHome V2 Web Service API.md`
