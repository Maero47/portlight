// Extension IDs the host answers by default. This is the single source of truth:
// `portlight-host install` always allows these, plus any --extension-id given now or before.

/** Unpacked builds: pinned by the public `key` in extension/src/manifest.json. */
export const DEV_EXTENSION_ID = "mfnkpeccejhabclngfmkadokknojffeo";

/** Chrome Web Store build (the ID the store assigned on the first upload). */
export const STORE_EXTENSION_ID = "khdojfoihgghehobdalaonjocjmolfjk";

export const DEFAULT_EXTENSION_IDS = [DEV_EXTENSION_ID, STORE_EXTENSION_ID].filter(Boolean);

export const isExtensionId = (s) => typeof s === "string" && /^[a-p]{32}$/.test(s);

export const originOf = (id) => `chrome-extension://${id}/`;

/** "chrome-extension://<id>/" -> "<id>", or null for anything else. */
export function idOfOrigin(origin) {
  const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(String(origin));
  return m ? m[1] : null;
}
