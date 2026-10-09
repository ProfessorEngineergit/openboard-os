// Builds the injected shell: tokens + icons + widgets + glass runtime + shell,
// wrapped in one closure. The version is a content hash, so an update replaces
// the shell in every open app without reloading the app itself.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const FONT_FAMILY = 'OpenBoard Inter';

export async function buildShell(root) {
  const read = path => readFile(resolve(root, path), 'utf8');
  const [tokens, icons, widgets, glass, shell] = await Promise.all([
    read('ui/tokens.css'), read('ui/icons.js'), read('ui/widgets.js'),
    read('vendor/liquid-glass/glass-runtime.js').catch(() => ''), read('shell/shell.js'),
  ]);
  // @font-face must live in the document; the shadow root only references it.
  const fontFaces = [...tokens.matchAll(/@font-face\{[^}]+\}/g)].map(match => match[0]
    .replace('font-family:"Inter"', `font-family:"${FONT_FAMILY}"`)
    .replaceAll('url("/ui/fonts/', 'url("http://localhost:4180/ui/fonts/')).join('');
  const tokenCss = tokens.replace(/@font-face\{[^}]+\}/g, '').replace('--ob-font:"Inter",', `--ob-font:"${FONT_FAMILY}","Inter",`);
  const body = [
    `const TOKENS_CSS=${JSON.stringify(tokenCss)};`,
    `const FONT_CSS=${JSON.stringify(fontFaces)};`,
    icons, widgets, glass, shell,
  ].join('\n');
  const version = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const source = `(() => {\nconst SHELL_VERSION=${JSON.stringify(version)};\n${body}\n})();`;
  return { source, version };
}
