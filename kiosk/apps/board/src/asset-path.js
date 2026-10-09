// Must run before Excalidraw registers its fonts: they are served from dist/fonts/.
// Excalidraw's esm.sh fallback is removed at build time (see build.mjs).
const script = document.querySelector('script[type="module"][src*="board.js"]');
window.EXCALIDRAW_ASSET_PATH = new URL('./', script?.src || new URL('dist/board.js', location.href)).href;
