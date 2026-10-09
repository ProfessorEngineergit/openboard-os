// Curated palette. Colors are stored in "light paper" space (Excalidraw convention);
// on dark paper Excalidraw renders the canvas through `invert(93%) hue-rotate(180deg)`.
// displayColor() applies the same transform so swatches and the ink layer match the
// rendered result exactly.
export const SWATCHES = [
  { id: 'ink', label: 'Tinte', color: '#1e1e1e' },
  { id: 'blue', label: 'Blau', color: '#1971c2' },
  { id: 'red', label: 'Rot', color: '#e03131' },
  { id: 'green', label: 'Grün', color: '#2f9e44' },
  { id: 'orange', label: 'Orange', color: '#f08c00' },
  { id: 'violet', label: 'Violett', color: '#7048e8' },
  { id: 'teal', label: 'Türkis', color: '#0c8599' },
  { id: 'yellow', label: 'Gelb', color: '#fcc419' },
];

export const STICKY_COLORS = { fill: '#ffec99', stroke: '#f2c94c' };

// Pen widths (Excalidraw strokeWidth; rendered diameter ≈ 6 × strokeWidth at medium pressure).
export const PEN_WIDTHS = [
  { id: 's', label: 'Fein', stroke: 0.6, shape: 1 },
  { id: 'm', label: 'Mittel', stroke: 1.2, shape: 2 },
  { id: 'l', label: 'Dick', stroke: 2.6, shape: 4 },
];
export const HIGHLIGHTER = { stroke: 4.5, opacity: 38 };

// Paper follows the system theme unless config.board.paper forces light/dark.
export function paperTheme(systemTheme, paper = 'auto') {
  if (paper === 'light' || paper === 'dark') return paper;
  return systemTheme === 'light' ? 'light' : 'dark';
}
export const PAPER_BACKGROUND = '#ffffff';

function parse(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value.slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
}
const toHex = rgb => '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

// CSS filter math (Filter Effects spec, sRGB): invert(0.93) then hue-rotate(180deg).
export function darkFilter(hex) {
  if (!/^#[0-9a-f]{3,8}$/i.test(hex || '')) return hex;
  const [r, g, b] = parse(hex).map(c => 0.93 - 0.86 * c);
  return toHex([
    -0.574 * r + 1.43 * g + 0.144 * b,
    0.426 * r + 0.43 * g + 0.144 * b,
    0.426 * r + 1.43 * g - 0.856 * b,
  ]);
}

export function displayColor(hex, theme) {
  return theme === 'dark' ? darkFilter(hex) : hex;
}
