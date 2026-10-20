# Portlight Chrome extension

Manifest V3 popup that shows which localhost ports are busy (process, project, exposure, uptime) and which are free.

```sh
npm install
npm run build          # writes dist/; load it in chrome://extensions with "Load unpacked"
npm test               # unit tests (Vitest) + build + popup tests against a mocked host
npm run test:e2e:real  # ../install.sh into a temp HOME, real host, real servers (macOS/Linux)
npm run build:store    # release/portlight-<version>.zip for the Web Store (no "key"), then checks it
npm run store:shots    # ../assets/store/screenshot-*.png from the real popup
npm run perf:motion    # frame pacing and idle CPU of the popup's motion (see Motion)
npm run record:motion  # screenshots/motion/*.mp4
```

First run of the Playwright tests needs a browser: `npx playwright install chromium`.
To use Portlight from a clone, run `./install.sh` in the repository root. Everyone else installs the
helper with `npx portlight-host install` (or Homebrew), which is what the popup suggests.

## How it works

- `src/popup/` is the popup: plain TypeScript and CSS, no framework, so it paints instantly.
  The last list is cached locally and shown on open while a fresh one loads.
- `src/background.ts` keeps the toolbar badge up to date every 30 s. It counts only the groups chosen
  in settings (`badgeGroups`, default dev servers, databases and containers) and skips hidden ports.
- `src/lib/classify.ts` sorts each listener into a group: dev server, database, container, app or system
  (ControlCenter, rapportd, launchd, systemd, Windows services…).
- `src/lib/known.ts` is a small list of owners Portlight recognises: AirPlay Receiver on 5000/7000, Continuity, Remote
  Login, Docker's port proxy, containers, Homebrew services, Figma Agent… For owners that the OS restarts
  (or where quitting would stop all of Docker), Quit is replaced by an explanation and, where there is
  one, the right command (`docker stop shop-db-1`, `brew services stop postgresql@16`).
- `src/lib/view.ts` holds the hiding rules (`hideSystem`, `hiddenPorts`, `hiddenProcesses`), the badge count,
  tab-to-port mapping and idle detection. Pure functions, unit tested.
- `src/lib/tabs.ts` finds tabs open on `http://localhost`, `127.0.0.1`, `[::1]` and `*.localhost`. Clicking a port that
  already has a tab switches to it (and its window) instead of opening a duplicate; tabs whose server
  has stopped get their own section with Switch and Close. No `tabs` permission: the existing host
  permissions are what let `tabs.query` match those URLs.
- Settings come from `src/lib/settings.ts` (`chrome.storage.local`; older copies in `chrome.storage.sync` are migrated once). The popup applies them live, and
  caches them locally so the first paint already uses the right theme and hiding rules.
- `src/lib/host.ts` talks to the native host `com.portlight.host` using `shared/protocol.ts`.
  The popup holds one `connectNative` port while open (measured: `list` went from 105 to 68 ms median,
  `ping` from 52 to 1 ms, and no process spawned every 2 s); the badge worker uses one-off
  `sendNativeMessage` calls so it never keeps the service worker alive.
- `src/lib/platform.ts` has the "this Mac" or "this computer" wording, the extension IDs the installer
  knows (`EXTENSION_IDS`: the pinned dev ID, and an empty slot for the Chrome Web Store ID until it
  exists), and `installPlan()`, which builds the install commands for the popup and the options page.
  An ID the installer doesn't know, or a helper set up for another ID, gets `--extension-id <id>`.
- `src/lib/meta.ts` fetches the favicon and `<title>` of local web servers after the list paints (1.2 s timeout,
  no redirects, same-origin icons only, at most 24 KB) and caches them per port + pid in `localStorage`. The icon leads the
  row's name; a title that says more than the folder (not "Vite + React + TS") replaces the process name.
- `src/lib/phone.ts` and `src/lib/qr.ts` power "Open on Phone…": the host's LAN address (`netinfo`) as a QR code drawn by
  a small local encoder (no network, no dependency). Servers that only listen on localhost get the flag that
  exposes them instead (`--host` for Vite, `-H 0.0.0.0` for Next.js, …).
- `src/lib/tunnels.ts` runs "Share Public Link…". The popup asks the background worker, which owns the tunnel so it
  survives the popup closing. The worker keeps one `connectNative` port open only while a link runs (that also
  keeps the worker alive) and polls it every 5 s; when the last link stops, the helper exits. Rows with a live
  link show "Public". Without cloudflared/ngrok the panel shows the one-line install.
- Idle cleanup: dev servers running longer than `idleAfterHours` with no tab (not hidden, not shared, not
  containers or OS services) are offered as "Quit N Idle…" in the footer; one confirm quits them with their child
  processes.
- `src/lib/probe.ts` is the fallback when the host is missing. The popup switches to it by itself, so
  it is useful without the helper. It probes common dev ports, the user's
  `extraProbePorts` and any port open in a tab over HTTP. Results are labelled "HTTP only"; databases and
  other non-HTTP services are invisible this way. AirPlay Receiver is recognised by its `Server: AirTunes`
  header and treated as a system port.
- `scripts/finalize.mjs` writes `dist/manifest.json` and copies icons from `../assets/icons`.
- `scripts/extension-id.mjs` and `scripts/keygen.mjs` handle the manifest `key`, which pins the
  extension ID (see the root README).

### Without the helper

When the helper is missing, or installed for another extension ID, the popup shows the HTTP list and
opens a sheet over it. The sheet says what the helper is for, gives the command for this OS with a
copy button (npm or Homebrew on macOS and Linux; npx on Windows, with `winget` for Node.js), and has
Check Again. While it is open the popup asks for the helper every 2.5 s and when its window regains
focus, and the HTTP rescan (every 8 s) asks too. Once the helper answers, the sheet shows a short
"Helper connected" and closes, and the full list comes in.

Not now, the close button, Esc and a click outside all put the sheet away. That choice is saved in
`chrome.storage.local` (`src/lib/onboard.ts`), and from then on a one line banner above the list
reopens it. The sheet opens by itself again after 14 days, or when the failure changes (missing to
installed for another ID). An extension update alone does not bring it back, because store updates
arrive silently and a sheet appearing then would have no visible cause. A working helper clears the
saved choice. When the HTTP scan was picked from the error screen (the helper is installed but not
answering), the banner offers Try Again instead of the installer.

The sheet is a modal dialog: the list underneath is inert, Tab stays inside, and focus goes back to
where it was. It rises on the `SETTLE` spring and leaves on the exit curve; with reduced motion it only
fades.

### Chrome Local Network Access

The HTTP fallback fetches `http://localhost:PORT` from the extension page. Checked on Chromium 156 with
LNA as shipped and with `--enable-features=LocalNetworkAccessChecks:LocalNetworkAccessChecksWarn/false`:
the requests go through with no prompt, because the manifest's `http://localhost/*` and
`http://127.0.0.1/*` host permissions cover them. No new permission is needed.
`tests/e2e/lna.spec.ts` keeps checking it (fallback scan, direct fetch, tab linking) in both modes.

## Motion

The popup should feel like a macOS menu-bar extra. Things respond on the frame you act, move like
physical objects, can be interrupted at any point, and never ask for attention.
`src/lib/motion.ts` holds the shared pieces; both stylesheets carry the same tokens.

### Springs

Every spring uses Apple's damping ratio and response, sampled into CSS `linear()`
(`springEasing()` computes the same curves for script-driven motion).

| Token | Damping / response | Duration | Used for |
| --- | --- | --- | --- |
| `--spring` / `SETTLE` | 1.0 / 0.35 s | 420 ms | rows moving, panels opening, entrances |
| `QUICK` | 1.0 / 0.25 s | 300 ms | the row menu, small glyph swaps |
| `--spring-pop` / `POP` | 0.72 / 0.38 s (~4 % overshoot) | 560 ms | completions only: copy check, QR code, a badge appearing |
| `EXIT` | `cubic-bezier(.32,.72,0,1)` | 160 to 220 ms | anything leaving; exits are quicker than entrances and never bounce |

### What moves, and why

- Harbor light (ambient): three soft lights (blue, a hint of violet or amber, teal) drift behind
  the header on unrelated 31 / 43 / 53 s periods, so the pattern never visibly repeats; the options
  page has the same lights at page scale. Each is a pre-painted gradient that only moves by
  `transform`, stepped at 2 updates/s (eased by its keyframe stops): at ~5 px/s on a soft gradient the
  steps can't be seen, and the compositor draws twice a second instead of sixty times.
- Heartbeat: the live dot breathes one ring when a fresh list has actually arrived, at most every
  ~6 s. It means "live", and nothing runs between beats. The options page beats once on connect.
- Busy: while looking or scanning, a thin accent light sweeps along the header's bottom edge;
  skeleton rows carry a sheen, row after row.
- Open: the first list of the session cascades in (8 px rise + fade, 24 ms apart, at most ten
  steps, done in ~0.65 s); the footer fades in behind it; the lights fade up over 1.4 s. Rows are
  clickable from the first frame: only opacity and transform animate. The options page settles its
  hero and then each section, 35 ms apart.
- Live list: on a refresh that adds, removes or reorders rows, every row slides from where it was
  on screen to its new place (FLIP, `SETTLE`). A row that goes is lifted out of the flow where it is
  and fades (`EXIT`); one that comes in rises 6 px, waiting 90 ms if it takes a leaving row's place.
  A refresh that changes nothing reads no layout at all.
- Numbers: the port count, the free-port suggestion, uptimes (minutes and up, since a seconds count
  would roll every refresh) and the options stepper roll like an odometer: up when the number
  grows, down when it shrinks, low digits a beat later. The outgoing digit is drawn by CSS from
  `data-old`, so the element's text is always just the new value.
- Interaction: buttons scale to 0.97 (icons 0.92) on press. The row menu grows out of the ⋯ button
  or the pointer (`QUICK`, from 0.94) and, on close, a copy fades out with the picked item still lit.
  Inline panels (Quit, explanations, phone, share, idle cleanup, options reset) open by growing their
  row with `--spring` while the content slides 6 px into place; when a panel's content changes while
  open (from finding the address to the QR code), its height springs to the new size and the content
  cross-fades. Badges that appear on a visible row (Public, tabs, Idle, Network) pop in. Errors
  shake once, decaying. Copy turns into a check with `POP` and back with a fade.

### Interruptions

CSS transitions retarget from their current value; FLIP measures where rows are
on screen mid-slide, so a second change never jumps; a menu reopened while its last copy fades
starts fresh; a panel resize starts from the current height.

### Reduced motion

`settings.motion` "system" follows `prefers-reduced-motion`, "full" ignores it,
"reduced" forces it. Reduced: every loop stops (the lights stay, still), no heartbeat, no FLIP,
rolls or cascades; panels and rows only fade. Loops also pause while the page is hidden.

### Cost

`npm run perf:motion` measures frame pacing on open and on a refresh with rows changing,
and CPU while the popup sits open for 10 s; `npm run record:motion` records the clips (needs ffmpeg) in
`screenshots/motion/`. Screenshot tests run with Reduce Motion and transitions settled, so they
never catch a frame mid-animation.

## Keyboard

| Key | Action |
| --- | --- |
| `⌘K` or `/` | Focus search |
| `↑` `↓` | Move between ports |
| `↩` | Switch to the tab showing that port, or open `http://localhost:PORT` |
| `⌘C` | Copy URL of the focused port |
| `⌘⌫` / `Delete` | Quit the focused process (asks first), or explain why it can't be quit |
| `⇧F10`, menu key or right-click | Row menu: Open on Phone, Share Public Link, Reveal in Finder, Open in editor, Hide port / app, Quit |
| `Esc` | Cancel, clear search, then close |

Typing a number in search checks that port and suggests the nearest free one.

## Screenshots

`screenshots/` is regenerated by `npm run test:e2e` against a mocked host, in light and dark.
Store screenshots in `../assets/store/` come from `npm run store:shots`, which runs the real
host against staged dev servers and keeps only those processes in the picture.
