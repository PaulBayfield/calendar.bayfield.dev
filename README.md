# Calendar

A lightweight Google Calendar client with a Notion Calendar–style UI. It runs as a Tauri 2 desktop
app (uses the system WebView2 instead of bundling Chromium) and as a web app served by a small
Node + SQLite server, which also powers scheduling links.

- 1–14 day views, Shift + scroll to move day by day
- Create events by dragging; move and resize them; edit everything in the side panel
  (time, recurrence, guests, Google Meet, location, description, calendar, color, busy/free, visibility)
- **Planifier:** drag the slots you're free, get a link, and the other person picks a time.
  The server checks your free/busy live and creates the event with them invited
- Themes: System, Light, Dark, Rosé Pine, Rosé Pine Dawn. UI in French or English

## Run it locally

```sh
npm install && npm --prefix server install
npm run dev          # web UI, http://localhost:1420  (add ?demo for sample data, no Google needed)
npm run server       # scheduling server on :8787 (Vite proxies /api to it); needs server/.env
npm run tauri dev    # desktop app
npm run tauri build  # desktop installer → src-tauri/target/release/bundle/
```

The desktop build needs Rust and the MSVC C++ build tools: see <https://tauri.app/start/prerequisites/>.

## Google setup (one-time)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the
   **Google Calendar API** and the **People API** (used to suggest guest emails from your contacts).
2. **Google Auth Platform → Branding:** set an app name. **Audience:** *External*, then **Publish app**
   (in *Testing*, Google expires sign-ins every 7 days; personal use doesn't need verification, you'll just
   click past an "unverified app" warning). **Data access:** add `https://www.googleapis.com/auth/calendar`,
   `https://www.googleapis.com/auth/contacts.readonly` and `https://www.googleapis.com/auth/contacts.other.readonly`
   (the last two are read-only and only used for guest autocompletion; without them, suggestions come
   from people already in your events).
3. **Clients → Web application.**
   - Authorized JavaScript origins: `http://localhost:1420`, `https://calendar.bayfield.dev`
   - Authorized redirect URIs: `https://calendar.bayfield.dev/api/google/callback`
     (plus `http://localhost:8787/api/google/callback` if you run the server locally)
   - Copy the client ID **and** secret (the secret is only used by the server).
4. **Clients → Desktop app.** Copy the client ID and secret.
5. `cp .env.example .env.local` (app) and `cp server/.env.example server/.env` (server), then fill them in.
6. *Optional, for Google Maps place suggestions:* enable **Places API (New)**, create an API key restricted to
   that API and to the referrers `http://localhost:1420/*`, `https://calendar.bayfield.dev/*` and
   `http://tauri.localhost/*`, and set `VITE_GOOGLE_MAPS_API_KEY`. Without a key, places come from
   OpenStreetMap (free) plus the places you've already used.

If you signed in before the contacts permissions were added, sign out and back in once so Google asks for them.

## Deploy (Docker)

One container serves the web app, the booking pages (`/book/<id>`) and the API. SQLite lives in `/data`.

```sh
# server/.env holds PUBLIC_URL, OWNER_EMAIL, GOOGLE_CLIENT_ID/SECRET, GOOGLE_DESKTOP_CLIENT_ID…
VITE_GOOGLE_WEB_CLIENT_ID=xxx.apps.googleusercontent.com docker compose up -d --build
```

Pushing to `main` builds and publishes the image to `ghcr.io/paulbayfield/calendar.bayfield.dev` (tagged
`latest` and the `package.json` version). Set the repository **variables** `VITE_GOOGLE_WEB_CLIENT_ID` and,
optionally, `VITE_GOOGLE_MAPS_API_KEY` (Settings → Secrets and variables → Actions → Variables); they end up in
the public JS bundle, so they don't need to be secrets.

Put it behind your reverse proxy at `https://calendar.bayfield.dev` → `localhost:8787`. Then in the app open
**Settings → Scheduling server** and click **Connect Google** once. That gives the server its own
refresh token so bookings work while your laptop is off. Only `OWNER_EMAIL` can create links or connect.

## How sign-in works

- **Desktop:** OAuth in your browser (loopback redirect + PKCE) in `src-tauri/src/lib.rs`. The refresh
  token is kept in Windows Credential Manager.
- **Web:** Google Identity Services. Tokens last an hour; after that the app asks you to reconnect.
- **Server:** owner requests carry the app's Google access token, which the server verifies with Google.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+K` or `/` | Search events, places, people |
| `T` | Today |
| `J` / `→` · `K` / `←` | Next / previous |
| `Shift` + scroll | Move day by day |
| `1`–`9`, `0` · `W` | 1–10 day view · week |
| `C` | New event |
| `Del` | Delete selected event (with undo) |
| `Ctrl+B` (or `\`) · `.` | Toggle sidebar · side panel |
| `,` | Settings |
| `Esc` | Close / cancel |
