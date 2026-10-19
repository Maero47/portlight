# Portlight

A Chrome extension that shows which localhost ports are in use (and by what) and which are free.

- `extension/` — Manifest V3 extension (popup UI)
- `host/` — native messaging host that reads real TCP listeners from the OS
- `shared/protocol.ts` — message contract between the two
- `assets/` — icons and store artwork
