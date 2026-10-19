// Inline glyphs drawn on a 20×20 grid in the spirit of SF Symbols:
// 1.6 stroke, round caps and joins, optically centred, currentColor.

const wrap = (body: string, size = 16, extra = "") =>
  `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

export const icon = {
  search: (s?: number) => wrap(`<circle cx="8.75" cy="8.75" r="5.25"/><path d="M12.6 12.6 16.5 16.5"/>`, s),
  copy: (s?: number) =>
    wrap(`<rect x="6.75" y="6.75" width="9.5" height="9.5" rx="2.25"/><path d="M13.25 4.6v-.1A1.75 1.75 0 0 0 11.5 2.75H5.5A1.75 1.75 0 0 0 3.75 4.5v6A1.75 1.75 0 0 0 5.5 12.25h.1"/>`, s),
  check: (s?: number) => wrap(`<path d="M4.5 10.4 8.2 14 15.5 6.25"/>`, s),
  open: (s?: number) => wrap(`<path d="M7 13 14 6"/><path d="M8 5.75h6.25V12"/>`, s),
  stop: (s?: number) => wrap(`<circle cx="10" cy="10" r="6.75"/><rect x="7.6" y="7.6" width="4.8" height="4.8" rx="0.9" fill="currentColor" stroke="none"/>`, s),
  lock: (s?: number) =>
    wrap(`<rect x="4.75" y="8.75" width="10.5" height="7.5" rx="2"/><path d="M7.25 8.75V6.5a2.75 2.75 0 0 1 5.5 0v2.25"/>`, s),
  network: (s?: number) =>
    wrap(`<circle cx="10" cy="10" r="6.75"/><path d="M3.4 10h13.2"/><path d="M10 3.25c1.8 1.9 2.7 4.15 2.7 6.75s-.9 4.85-2.7 6.75c-1.8-1.9-2.7-4.15-2.7-6.75S8.2 5.15 10 3.25Z"/>`, s),
  clock: (s?: number) => wrap(`<circle cx="10" cy="10" r="6.75"/><path d="M10 6.25V10l2.5 1.6"/>`, s),
  retry: (s?: number) => wrap(`<path d="M15.6 10a5.6 5.6 0 1 1-1.64-3.96"/><path d="M14.25 3.5v3.1h-3.1"/>`, s),
  warning: (s?: number) =>
    wrap(`<path d="M8.6 3.9a1.6 1.6 0 0 1 2.8 0l5.55 9.85A1.6 1.6 0 0 1 15.55 16.1H4.45a1.6 1.6 0 0 1-1.4-2.35Z"/><path d="M10 8v3.2"/><circle cx="10" cy="13.6" r=".55" fill="currentColor"/>`, s),
  plug: (s?: number) =>
    wrap(`<path d="M7.25 2.75v3.5M12.75 2.75v3.5"/><path d="M5 6.25h10v2.5a5 5 0 0 1-10 0Z"/><path d="M10 13.75v3.5"/>`, s),
  terminal: (s?: number) =>
    wrap(`<rect x="2.75" y="4" width="14.5" height="12" rx="2.5"/><path d="m6.25 8.25 2.25 1.9-2.25 1.9M10.5 12.25h3.25"/>`, s),
  bolt: (s?: number) => wrap(`<path d="M11 2.75 4.75 11h4.5L8.75 17.25 15.25 9h-4.5Z"/>`, s),
  waves: (s?: number) =>
    wrap(`<circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><path d="M6.6 6.6a4.8 4.8 0 0 0 0 6.8M13.4 6.6a4.8 4.8 0 0 1 0 6.8"/><path d="M4.1 4.1a8.35 8.35 0 0 0 0 11.8M15.9 4.1a8.35 8.35 0 0 1 0 11.8"/>`, s),
  chevron: (s?: number) => wrap(`<path d="m8 5.5 4.5 4.5L8 14.5"/>`, s),
  back: (s?: number) => wrap(`<path d="M12 5.5 7.5 10l4.5 4.5"/>`, s),
  gear: (s?: number) => wrap(`<path d="M15.20 8.21 L16.92 8.40 L16.92 11.60 L15.20 11.79 L14.94 12.41 L16.02 13.76 L13.76 16.02 L12.41 14.94 L11.79 15.20 L11.60 16.92 L8.40 16.92 L8.21 15.20 L7.59 14.94 L6.24 16.02 L3.98 13.76 L5.06 12.41 L4.80 11.79 L3.08 11.60 L3.08 8.40 L4.80 8.21 L5.06 7.59 L3.98 6.24 L6.24 3.98 L7.59 5.06 L8.21 4.80 L8.40 3.08 L11.60 3.08 L11.79 4.80 L12.41 5.06 L13.76 3.98 L16.02 6.24 L14.94 7.59Z"/><circle cx="10" cy="10" r="2.25"/>`, s),
  more: (s?: number) =>
    wrap(`<circle cx="5.25" cy="10" r="1.15" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.75" cy="10" r="1.15" fill="currentColor" stroke="none"/>`, s),
  info: (s?: number) =>
    wrap(`<circle cx="10" cy="10" r="6.75"/><path d="M10 9.25v4.25"/><circle cx="10" cy="6.6" r=".6" fill="currentColor"/>`, s),
  tab: (s?: number) => wrap(`<rect x="3" y="4.75" width="14" height="10.5" rx="2.25"/><path d="M3 8.25h14M6 4.75v3.5"/>`, s),
  xmark: (s?: number) => wrap(`<path d="M6 6l8 8M14 6l-8 8"/>`, s),
};
