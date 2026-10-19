# Portlight native host

A small Node.js program the Portlight extension talks to over
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
It asks the OS which TCP ports are listening (and by which process), checks
whether ports are free, suggests free ones, and can stop a dev server you own.
Messages follow [`shared/protocol.ts`](../shared/protocol.ts).

Requires Node.js 18+. No npm dependencies.

| OS      | Listeners from                   | Process details             |
| ------- | -------------------------------- | --------------------------- |
| macOS   | `lsof -nP -iTCP -sTCP:LISTEN`    | `lsof -d cwd`, `ps`         |
| Linux   | `ss -ltnp` (falls back to `/proc/net/tcp`) | `/proc/<pid>/cwd`, `ps` |
| Windows | `netstat -ano`                   | `tasklist` (no cwd/command) |

Sockets owned by other users or root are usually visible without an owner. `check`
then confirms with a bind/connect probe, so it is right even when the owner is hidden.

## Install

Find the extension ID on `chrome://extensions` (enable Developer mode), then:

```sh
cd host
./install.sh <extension-id>            # several IDs allowed
./install.sh <extension-id> --all-browsers   # also browsers that don't look installed
```

This copies the host to `~/Library/Application Support/Portlight/host` (macOS) or
`~/.local/share/portlight/host` (Linux), writes a launcher that pins the current
`node` binary, and writes `com.portlight.host.json` into the `NativeMessagingHosts`
folder of each installed browser: Chrome (stable/Beta/Dev/Canary), Chromium, Brave,
Edge, Arc (macOS) and Vivaldi. It is safe to re-run and prints every file it touches.

Re-run it after switching Node versions (e.g. with nvm), since the launcher points
at a specific `node`.

Windows: `powershell -ExecutionPolicy Bypass -File install.ps1 <extension-id>`.

## Uninstall

```sh
./uninstall.sh                  # macOS / Linux
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall   # Windows
```

## Debug

Talk to the host directly; `scripts/frame.js` does the length-prefix framing:

```sh
node scripts/frame.js '{"id":"1","type":"list"}' | node src/main.js | node scripts/frame.js --decode
node scripts/frame.js '{"id":"2","type":"check","ports":[3000,5173]}' \
                      '{"id":"3","type":"suggest","near":3000,"count":3}' \
  | node src/main.js | node scripts/frame.js --decode
```

Test the installed copy the same way by replacing `node src/main.js` with the
launcher path printed by `install.sh`.

If the extension reports "Specified native messaging host not found", the manifest
is missing for that browser or the extension ID in `allowed_origins` is wrong.
"Native host has exited" usually means the `node` path in the launcher no longer
exists: re-run `install.sh`. To see the host's stderr, start Chrome from a terminal
with `--enable-logging=stderr`.

## Requests

| type      | does                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| `ping`    | protocol version, platform, host version                                             |
| `list`    | every TCP listener with pid, process, command line, cwd, user, start time            |
| `check`   | `free` per port (max 1000), with the owning listener when known                      |
| `suggest` | `count` (default 5, max 50) free ports nearest `near` (default 3000), ≥ 1024, skipping Chrome's blocked ports and common service ports (Postgres, Redis, AirPlay 5000/7000, …) |
| `kill`    | sends TERM (default) or KILL, only to a pid that owns a listening port right now and runs as the current user (same uid on macOS/Linux, `tasklist /V` owner on Windows). Refuses the host itself and every process above it (launcher shell, browser) |

## Tests

```sh
npm test
```

Parsers are tested against captured `lsof`/`ss`/`/proc`/`netstat`/`tasklist` output in
`test/fixtures`. The integration tests start a real TCP server and a real host
process (macOS/Linux), and run the installer against a temporary `HOME`.
