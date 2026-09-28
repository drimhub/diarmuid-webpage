# diarmuid-webpage

Diarmuid's personal website — a static site with a couple of small backend pieces, deployed on Cloudflare.

## Structure

```
index.html                   Homepage (static HTML/CSS/JS, no build step)
bookclub/index.html          /bookclub page (placeholder, "under construction")
assets/                      Images and audio used by the homepage
version.json                 { "version": ... } read by the homepage to force a reload on deploy
_headers                     Cloudflare Pages header rules (disables caching)
location-worker/             Cloudflare Worker + D1 backing the "Locations" map on the homepage
tools/                       Local scratch/tooling (not part of the deployed site)
```

## Homepage (`index.html`)

Single static page, no build tooling — just open it or deploy the folder as-is. It includes:

- **Heat of the Month** — an audio player for `assets/HOTW 1.mp3`.
- **Top Songs (last 7 days)** — fetched client-side from the Last.fm API for user `diarmuidcoffey`.
- **Locations** — a Leaflet map plotting points fetched from the `location-worker` API (see below).
- **Comments** — a simple guestbook backed directly by Firebase Firestore from the client.
- **Version check** — polls `version.json` and reloads the page when the version changes, to bust caching.
- A bouncing "NEW: bookclub" banner linking to `/bookclub`.

The Last.fm API key and Firebase config are embedded client-side by design (they're public-facing keys, not secrets).

## `location-worker/`

A Cloudflare Worker exposing `GET/POST /api/location`, backed by a Cloudflare D1 database.

- `POST /api/location` — appends a `{ lat, long }` point. Requires header `X-Auth-Token` matching the `LOCATION_SECRET` secret.
- `GET /api/location?limit=N` — returns up to `N` (default 500, max 2000) recent points, oldest first.

### Setup

```
cd location-worker
npm install -g wrangler   # if not already installed
wrangler d1 execute diarmuid-locations --file=migrations/0001_create_locations.sql
wrangler secret put LOCATION_SECRET
```

### Local development

```
cd location-worker
wrangler dev
```

`.dev.vars` in this folder holds the local `LOCATION_SECRET` value and is git-ignored.

### Deploy

```
cd location-worker
wrangler deploy
```

The homepage auto-detects `localhost`/`127.0.0.1` and points at `http://localhost:8787/api/location` in that case; otherwise it calls the deployed worker at `https://diarmuid-location-api.diarmuidcoffey99.workers.dev/api/location`.

## Deployment

The site itself is deployed via Cloudflare Pages (static hosting of the repo root); `_headers` disables caching so the version-check reload logic always sees fresh content. The Worker in `location-worker/` is deployed separately via `wrangler deploy`.
