# portlight-host

The native helper for the Portlight browser extension. Portlight shows which localhost
ports are in use, by which project, and which are free. A browser extension can't see
which process owns a port, so it asks this small Node.js program over
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

It needs Node.js 18 or newer and has no dependencies.

## Install

On macOS, Linux or Windows:

```sh
npx portlight-host install
```

With Homebrew on macOS or Linux:

```sh
brew install maero47/tap/portlight-host
portlight-host install
```

Then reload the Portlight extension (or reopen its popup).

The helper allows the Chrome Web Store build and the unpacked build from this
repository. For any other build (one you packed yourself, say), the popup shows the
install command with `--extension-id <id>` filled in. You can also copy the ID from
`chrome://extensions` and run:

```sh
npx portlight-host install --extension-id <id>
```

The installer copies the helper to a folder in your home directory, writes a launcher
that points at the exact `node` it was run with, and registers the helper with every
Chromium browser it finds: Chrome (stable, Beta, Dev, Canary), Chromium, Brave, Edge,
Arc and Vivaldi. It starts the installed copy once to check that it answers before
registering it anywhere. It needs no admin rights, prints every file and registry key
it writes, and is safe to run again.

On Linux, browsers installed as a Snap or Flatpak run in a sandbox that can't start
native helpers. The installer says so when it finds one and leaves it alone; use the
browser's regular package for Portlight.

| OS      | Helper files                                   | Registered in                                       |
| ------- | ---------------------------------------------- | --------------------------------------------------- |
| macOS   | `~/Library/Application Support/Portlight/host` | `NativeMessagingHosts/` in each browser's folder    |
| Linux   | `~/.local/share/portlight/host`                | `NativeMessagingHosts/` in each browser's folder    |
| Windows | `%LOCALAPPDATA%\Portlight\host`                | `HKCU\Software\<browser>\NativeMessagingHosts`      |

Run `portlight-host install` again after switching Node versions (with nvm, for example)
or after `brew upgrade`, so the launcher points at a `node` that still exists.

### Windows without Node.js

Install Node.js first, then open a new terminal and run the installer:

```powershell
winget install OpenJS.NodeJS.LTS
npx portlight-host install
```

The package also ships `install.ps1`, which checks for Node.js, offers to install it
with winget, and then runs the installer.

## Commands

```sh
portlight-host install [--extension-id <id>]... [--all-browsers]
portlight-host status            # what is installed where, and whether it answers
portlight-host uninstall         # remove everything install wrote
```

By default the helper only answers the Portlight extension. `--extension-id` allows
another build, such as one you loaded unpacked with its own key. IDs allowed by an
earlier install are kept. `--all-browsers` also registers browsers that don't look
installed yet.

`portlight-host status` exits with 0 when everything works and 1 otherwise, and lists
what it found wrong. `portlight-host status --json` gives the same information for
scripts.

## Troubleshooting

If the extension says "Specified native messaging host not found", the helper is not
registered for that browser or does not list that extension's ID. Run
`portlight-host status` to see which. "Native host has exited" usually means the `node`
in the launcher is gone; run `portlight-host install` again. To see the helper's error
output, start the browser from a terminal with `--enable-logging=stderr`.

## Privacy

The helper only reads the local socket and process tables and answers the extension IDs
listed in its manifest. Nothing it does leaves your computer, with one exception: a
share link. When you click "Share Public Link" in the popup, the helper runs
`cloudflared` (or `ngrok`, if that is what you have installed) until you stop it.

## How it works

| OS      | Listeners from                             | Process details             |
| ------- | ------------------------------------------ | --------------------------- |
| macOS   | `lsof -nP -iTCP -sTCP:LISTEN`              | `lsof -d cwd`, `ps`         |
| Linux   | `ss -ltnp` (falls back to `/proc/net/tcp`) | `/proc/<pid>/cwd`, `ps`     |
| Windows | `netstat -ano`                             | `tasklist` (no cwd/command) |

Sockets owned by other users or root are usually visible without an owner. `check`
then confirms with a bind/connect probe, so it is right even when the owner is hidden.

When a browser starts the helper it passes `chrome-extension://<id>/` (and on Windows
`--parent-window=<n>`), and the helper speaks native messaging on stdin and stdout. Run
from a terminal with a command, it is the installer CLI instead.

### Requests

Messages follow `shared/protocol.ts` in the Portlight repository.

| type           | does |
| -------------- | ---- |
| `ping`         | protocol version, platform, host version |
| `list`         | every TCP listener with pid, process, command line, cwd, user, start time |
| `check`        | `free` per port (max 1000), with the owning listener when known |
| `suggest`      | `count` (default 5, max 50) free ports nearest `near` (default 3000), at or above 1024, skipping Chrome's blocked ports and common service ports (Postgres, Redis, AirPlay 5000/7000 and others) |
| `kill`         | sends TERM (default) or KILL, only to a pid that owns a listening port right now and runs as the current user (same uid on macOS and Linux, `tasklist /V` owner on Windows). Refuses the host itself and every process above it (launcher shell, browser), and container engine forwarders. With `tree: true` it also signals the pid's descendants (parent first; same user, never protected pids) and returns every pid it signalled in `killed` |
| `reveal`       | opens the listener's working directory in Finder (`open`), the file manager (`xdg-open`) or Explorer. Same ownership rules as `kill` |
| `openEditor`   | opens the working directory in `vscode`, `cursor`, `zed`, `webstorm` or `sublime` (fixed list). macOS uses the app bundle (`open -a`), otherwise the editor's CLI; Windows only real `.exe` files. `not_found` when the editor isn't installed |
| `netinfo`      | hostname and non-loopback addresses, best first (physical IPv4, then IPv6, then VPN, VM and container bridges; no link-local), for "Open on Phone" |
| `openSettings` | macOS only: opens one of a fixed set of System Settings panes (`airdrop-handoff`, `sharing`) with `open x-apple.systempreferences:…`. `not_found` elsewhere |
| `tunnelStatus` | which tunnel tools are installed (`cloudflared`, `ngrok`) and the share links running |
| `tunnelStart`  | public URL for `port` via a cloudflared quick tunnel (preferred, no account) or ngrok. Only for a port that listens right now and belongs to the current user (or is published by your container engine). Forwards to the loopback address the server listens on, rewrites the Host header so dev servers accept it, and waits up to 25 s for the URL. At most 4 at a time |
| `tunnelStop`   | stops the share link on `port` |

### Share links

Tunnels are child processes of the host, started with `spawn` and a fixed argument list
(never a shell), from a binary named exactly `cloudflared` or `ngrok` on PATH or in the
usual Homebrew locations. A start registers its port as `starting` before the port check
runs, so `tunnelStop` cancels it at any point: before the binary is spawned (nothing
starts), after (the process is killed), or as the URL arrives (it is never returned); the
start then fails with `cancelled`. A tunnel stops when asked, when its port stops
listening (checked every 5 s, two misses in a row), and when the host exits (stdin
closed, SIGTERM, SIGINT, SIGHUP or a normal exit). A normal stop sends SIGTERM
(cloudflared runs with `--grace-period 1s`) and SIGKILL 2 s later. On host exit every
tunnel child, including ones still shutting down, gets SIGKILL synchronously, since no
timer survives the exit. If the host is killed with SIGKILL its tunnel can outlive it,
since macOS has no "die with parent". The extension runs share links from its background
worker, which keeps one host connection open only while a tunnel runs.

### Containers

When a port is published by a running container (Docker Desktop, OrbStack, Colima/Lima,
Podman, Linux `docker-proxy`), `list` and `check` add `container` (id, name, image,
compose `project`, `containerPort`, compose `workingDir`) to that listener. The host asks
`docker ps` or `podman ps` (found on PATH or in the Homebrew, Docker, OrbStack and Rancher
locations, since browsers start hosts with a minimal PATH) with a 1 s timeout, caches the
answer for 3 s (15 s after a failure), and never fails a scan because of it. Published
ports with no visible listener (root-owned or iptables-only) still show up, without an
owner, when a probe confirms they answer. The forwarder's own `cwd` is reported as
`null`, since it is not a project.

## Development

In the repository, `./install.sh` at the root builds the extension and runs this
installer for you. To work on the helper alone:

```sh
cd host
npm test
node src/main.js install           # same as npx portlight-host install, from this checkout
./install.sh                       # the same, as a shell wrapper (macOS, Linux)
./uninstall.sh
```

Talk to the helper directly; `scripts/frame.js` does the length-prefix framing:

```sh
node scripts/frame.js '{"id":"1","type":"list"}' | node src/main.js | node scripts/frame.js --decode
node scripts/frame.js '{"id":"2","type":"check","ports":[3000,5173]}' \
                      '{"id":"3","type":"suggest","near":3000,"count":3}' \
  | node src/main.js | node scripts/frame.js --decode
```

Replace `node src/main.js` with the launcher path `portlight-host status` prints to test
the installed copy.

The extension IDs the installer allows by default live in `src/ids.js`: the pinned ID of
the unpacked build and the Chrome Web Store ID.

Parsers are tested against captured `lsof`, `ss`, `/proc`, `netstat`, `tasklist`,
`docker ps` and `podman ps` output in `test/fixtures`. The installer tests run every
platform against a temporary home folder: macOS and Linux for real, including a ping of
the installed copy, and Windows with a stand-in for `reg.exe`. The integration tests
start a real TCP server and a real host process, and drive the full tunnel lifecycle with
a fake `cloudflared` on PATH.
