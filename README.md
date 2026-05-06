# Art Display

A minimal slideshow webapp for an unattended Chromebook/projector. Cycles
through every image and video in `media/`, one every 20 minutes, with a
1.5-second crossfade. Designed to be deployed to Vercel and left running.

## How it works

```
media/  ──[npm run build]──>  media.json  ──[fetch]──>  app.js  ──[render]──>  <img>/<video>
                                  │
                                  └──[poll every 5 min]──>  picks up new files without reload
```

- `index.html` boots the app and shows the **Start** button (browsers require a
  user gesture before fullscreen + autoplaying video).
- `app.js` (367 lines) drives playback: shuffles the list with Fisher–Yates,
  preloads each item into an off-screen layer, swaps via opacity transition,
  recovers from involuntary fullscreen exits (ChromeOS notifications, sleep),
  and re-acquires the screen Wake Lock on tab visibility changes.
- `media.json` is the canonical playlist the frontend consumes.
- `scripts/generate-media-json.js` is the source of truth: it scans `media/`,
  filters by extension allowlist, and writes `media.json`. Vercel runs this
  on every deploy via `vercel.json`'s `buildCommand`.
- `sync-media.ps1` (Windows) is the convenience wrapper: scan → regenerate →
  stage → commit → push, with garbage detection.

## Day-to-day workflow

1. Drop new images into `media/`.
2. Run **`npm run sync`** (or `npm run sync:dry` to preview).
3. Confirm at the prompt.
4. Vercel rebuilds within ~2 minutes; already-loaded browsers update on their
   next 5-minute poll.

The PowerShell script refuses to commit non-media files (e.g., `.exe`
installers that wandered into `media/`). Run with `-Force` to override.

```powershell
# Preview without touching git
.\sync-media.ps1 -DryRun

# Sync interactively
.\sync-media.ps1

# Non-interactive (CI / scheduled task)
.\sync-media.ps1 -Yes -Message "Add winter art batch"
```

## Supported file types

| Kind  | Extensions                                  |
| ----- | ------------------------------------------- |
| Image | `jpg`, `jpeg`, `png`, `webp`, `gif`, `bmp`, `avif` |
| Video | `mp4`, `webm`                                |

The list is mirrored in three places (build script, sync script, and
`app.js`). If you add a new format, update all three plus `media/.gitignore`.

## Deployment

Hosted on Vercel. `vercel.json` sets:

- `buildCommand: "npm run build"` — regenerates `media.json` server-side.
- A locked-down Content-Security-Policy (`default-src 'self'`).
- `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

No backend, no database, no third-party media — everything is same-origin.

## Files in this repo

| Path                              | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| `index.html`                      | Bootstraps `app.js`, defines start UI    |
| `style.css`                       | Layer + button styles                    |
| `app.js`                          | Playback engine, polling, wake lock      |
| `media.json`                      | Generated playlist                       |
| `scripts/generate-media-json.js`  | Build-time scanner                       |
| `sync-media.ps1`                  | Local sync + push helper (Windows)       |
| `vercel.json`                     | Deploy config + security headers         |
| `package.json`                    | npm scripts                              |
| `media/.gitignore`                | Blocks non-media files from being staged |

## Why two scripts?

`generate-media-json.js` is what Vercel runs on the server during deploy.
It must work in a clean, unauthenticated CI environment with no git access —
just file scan → JSON.

`sync-media.ps1` is what you run locally to *get* the new files into the
repo so Vercel sees them in the first place. It calls the build script,
then handles the git-side mechanics (staging adds + deletes, refusing
garbage, committing, pushing).
