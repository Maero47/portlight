# Portlight artwork

An open harbor doubles as a port socket; a separate amber light signals visibility
into local activity. The ivory body, graphite edge and shallow enamel finish give
it a quiet utility character. The amber light is a brand element, not a live
busy/free indicator.

Three directions were explored in `concepts/`: the lighthouse was recognizable but
too detailed at toolbar size; the port slot was direct but too wide; the harbor
made the best use of a square and retained a clear opening. The refined harbor
replaces its dark face with ivory for contrast on dark toolbars.

| Color | Hex | Use |
| --- | --- | --- |
| Graphite | `#28332F` | Outlines, store background |
| Ivory | `#F3F2E9` | Enamel face, wordmark |
| Amber | `#E7A343` | Signal light |
| Amber edge | `#986523` | Small-icon light outline |
| Paper | `#F7F7F2` | Light preview background |

The three concepts and refined master were produced with the built-in image
generation tool. Original RGBA artwork is retained in `concepts/`. Pillow removes
isolated background specks and exports the 1024, 128 and 48 px icons with genuine
transparency. The 16 and 32 px versions are separately drawn optical reductions:
flat fills, stronger edges, a larger light and wider gaps, with coordinates chosen
for each pixel grid. They are not downscales of the master.

Store images composite the same approved artwork on graphite. "Portlight" is
typeset in Helvetica Neue, then sampled from 2x for crisp edges; no generated text
is used. Store PNGs are opaque RGB. `concepts/preview.png` shows all shipping icon
sizes at 1:1 on light and dark backgrounds, plus nearest-neighbor detail views.

Rebuild on macOS with Pillow installed:

```sh
python3 assets/build_assets.py
python3 assets/verify_assets.py
```

Elsewhere, pass `--font /path/to/a/licensed/font.ttf` (typography may differ).
Font software is not included. The five icon filenames state their square pixel
size; store filenames state their exact width and height.

Research: [Apple app icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
informed simplicity and restrained depth;
[Raycast](https://www.raycast.com/press) informed a focused accent;
[Linear](https://linear.app/brand) informed spacing;
[Things](https://culturedcode.com/things/blog/) informed a familiar object reduced
to a clear silhouette. These are design references, not source artwork.
[Chrome's image guidance](https://developer.chrome.com/docs/webstore/images/)
informed the store dimensions and dark promotional background.

`video/portlight-launch.mp4` is the launch video (1920×1080, 34 s, with music).
`video/portlight-demo.gif` is an 18-second silent cut of its demo section for the
main README. The popup in the video is rebuilt from the extension's own styles and
icons and animated frame by frame, so every label matches the real interface.
