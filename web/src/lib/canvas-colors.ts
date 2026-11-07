// Colours the canvas code and the viewport need as values (not CSS), taken from public/app.js:250-251 and public/style.css:46-52 (:root tokens resolved).
export const canvasColors = {
  viewportBg: '#000',
  tipFg: '#e6e8eb', // inherits --text
  tipBg: 'rgba(10,12,15,.85)',
  tipBorder: '#262b33', // --line
  emptyFg: '#8b939e', // --muted
  emptyBg: 'transparent', // style.css gives #empty no background; the black viewport shows through
  // style.css leaves #wipe unstyled (browser default); these are chosen to match the palette: --line track, --accent thumb
  wipeTrack: '#262b33',
  wipeThumb: '#3ee6f0',
  wipeLine: '#3ee6f0', // vertical divider drawn at the wipe position (app.js:250)
  wipeLabel: '#fff', // "◀ parent" / "id ▶" labels (app.js:251)
  wipeFont: '600 14px system-ui',
  overlaySelected: [62, 230, 240] as const, // paintOverlay RGB, selected
  overlaySelectedAlpha: { edge: 255, fill: 46 },
  overlayHover: [255, 255, 255] as const, // paintOverlay RGB, hovered
  overlayHoverAlpha: { edge: 200, fill: 22 },
} as const;
