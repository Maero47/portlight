# Portlight privacy policy

Effective date: 2026-10-20

Portlight is a Chrome extension with an optional helper program that runs on your own computer. It shows which localhost ports are in use, by what, and which are free. This policy explains what it touches and where that information goes.

## What Portlight collects

Portlight does not collect personal data. There is no account to create, no analytics or tracking, and no Portlight server. Nothing about you or your computer is sent to the developer or to anyone else.

## What the helper reads

The helper is a small program you install yourself with `npx portlight-host install`. It reads your computer's local socket and process tables to find which ports are listening and which process owns each one. It sends that list to the Portlight extension through Chrome's native messaging and to nothing else. Its native messaging manifest lists only Portlight's extension IDs, so other extensions and websites cannot talk to it.

When you choose to quit a process from Portlight, you are asked to confirm first. The helper refuses to stop a process that isn't yours or isn't holding a listening port, and it never touches the browser itself.

## What the extension reads

The extension can only make web requests to local addresses: `http://localhost`, `http://127.0.0.1`, `http://[::1]` and `http://*.localhost`. It uses them to check which common ports answer when the helper is not installed, to link open tabs to the servers they show, and to load each local server's favicon and page title. It has no permission to reach any other website.

Links in the extension, such as the one to the project README, open as ordinary browser tabs when you click them.

## Where your settings are kept

Your settings (theme, hidden ports and processes, refresh rate, preferred editor and similar choices) are stored in `chrome.storage.local` on your computer. They are not synced to your Google account and are removed when you uninstall the extension.

## Share Public Link

Share Public Link is the one feature that sends traffic off your computer, and only when you start it. It runs cloudflared (or ngrok, if you pick it) to give one local server a public address. While the link is active, anyone who has it can reach that server, and its traffic passes through Cloudflare or ngrok under their own privacy policies. The link stops when you stop it, when the server stops, or when the browser quits. Portlight does not start a share on its own.

## Changes to this policy

If Portlight's handling of data changes, this file will be updated and the effective date above will change with it.

## Contact

Questions about privacy can be raised as an issue at https://github.com/Maero47/portlight/issues.
