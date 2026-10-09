// Build the OpenBoard whiteboard into dist/ (committed; the kiosk has no build step).
//   npm install && npm run build
// Output: dist/board.js (+ lazily loaded chunks), dist/board.css, dist/fonts/<Latin families>.
import { build } from 'esbuild';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const excalidrawDist = join(here, 'node_modules/@excalidraw/excalidraw/dist/prod');

// Latin font families only. Xiaolai (CJK, 13 MB) is left out on purpose.
const FONT_FAMILIES = ['Assistant', 'Cascadia', 'ComicShanns', 'Excalifont', 'Liberation', 'Lilita', 'Nunito', 'Virgil'];
// Locales shipped with the bundle; every other locale chunk is replaced by an empty module.
const LOCALES = /\/locales\/(de-DE|en)-[A-Z0-9]+\.js$/;

const excalidrawPatches = {
  name: 'excalidraw-offline',
  setup(b) {
    // Unused locales: stub instead of ~1.7 MB of chunks.
    b.onResolve({ filter: /\/locales\/[a-zA-Z-]+-[A-Z0-9]+\.js$/ }, args => {
      if (!args.importer.includes('@excalidraw/excalidraw') || LOCALES.test(args.path)) return undefined;
      return { path: args.path, namespace: 'empty-locale' };
    });
    b.onLoad({ filter: /.*/, namespace: 'empty-locale' }, () => ({ contents: 'export default {};', loader: 'js' }));
    // Fonts referenced from Excalidraw's CSS are copied to dist/fonts/ below.
    b.onResolve({ filter: /\.woff2$/ }, args => ({ path: args.path, external: true }));
    // 1) never fall back to esm.sh for fonts (CSP connect-src 'self'; the kiosk is offline-first)
    // 2) CJK font faces (Xiaolai) are not shipped: give them no URL so nothing is ever fetched.
    b.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, async args => {
      const { readFile } = await import('node:fs/promises');
      let code = await readFile(args.path, 'utf8');
      if (code.includes('ASSETS_FALLBACK_URL')) {
        const before = code;
        code = code.replace(/(\w+)\.push\(new URL\((\w+),(\w+)\.ASSETS_FALLBACK_URL\)\)/g, 'void 0');
        if (code === before) throw new Error('excalidraw-offline: font fallback pattern not found (package changed?)');
        code = code.replace(/"\.\/fonts\/Xiaolai\/Xiaolai-Regular-[0-9a-f]+\.woff2"/g, '"local:"');
      }
      return { contents: code, loader: 'js' };
    });
  },
};

await rm(dist, { recursive: true, force: true });
const result = await build({
  entryPoints: { board: join(here, 'src/main.jsx') },
  outdir: dist,
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  target: ['chrome110', 'firefox115'],
  jsx: 'automatic',
  conditions: ['production'],
  define: { 'process.env.NODE_ENV': '"production"' },
  external: ['/ui/*'],
  chunkNames: 'chunks/[name]-[hash]',
  loader: { '.js': 'jsx' },
  metafile: true,
  logLevel: 'warning',
  plugins: [excalidrawPatches],
});

for (const family of FONT_FAMILIES) {
  await mkdir(join(dist, 'fonts', family), { recursive: true });
  await cp(join(excalidrawDist, 'fonts', family), join(dist, 'fonts', family), { recursive: true });
}

async function size(dir) {
  let total = 0, files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { const sub = await size(path); total += sub.total; files += sub.files; }
    else { total += (await stat(path)).size; files++; }
  }
  return { total, files };
}
const outputs = Object.entries(result.metafile.outputs).map(([file, info]) => [relative(here, file), info.bytes]).sort((a, b) => b[1] - a[1]);
for (const [file, bytes] of outputs.slice(0, 8)) console.log(`${(bytes / 1024).toFixed(0).padStart(7)} KB  ${file}`);
const { total, files } = await size(dist);
console.log(`dist: ${files} files, ${(total / 1024 / 1024).toFixed(2)} MB`);
