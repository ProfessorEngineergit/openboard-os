// Safe Markdown subset → DOM. Never uses innerHTML: every piece of text becomes a text node.
// Supports headings, paragraphs, (nested) lists, block quotes, fenced code, inline code,
// bold, italic, strikethrough, horizontal rules, simple tables and links (rendered as text).
import { h } from './util.js';

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = line => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-');
const isBlockStart = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || HR.test(lines[i]) || QUOTE.test(lines[i]) || LIST.test(lines[i]) || isTableStart(lines, i);

export function renderMarkdown(source, { className = 'md' } = {}) {
  const root = h('div', { class: className });
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  root.append(...parseBlocks(lines));
  return root;
}

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = FENCE.exec(line);
    if (m) {
      const close = m[1][0], body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}\\${close}{${m[1].length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(h('pre', { class: 'md-pre' }, h('code', { 'data-lang': m[2] || null }, body.join('\n'))));
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const level = m[1].length;
      out.push(h(`h${Math.min(6, level + 2)}`, { class: `md-h md-h${Math.min(level, 4)}` }, inline(m[2])));
      i++; continue;
    }
    if (HR.test(line)) { out.push(h('hr', { class: 'md-hr' })); i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      out.push(h('blockquote', { class: 'md-quote' }, parseBlocks(body)));
      continue;
    }
    if (isTableStart(lines, i)) {
      const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const head = cells(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(h('div', { class: 'md-table-wrap' }, h('table', { class: 'md-table' },
        h('thead', null, h('tr', null, head.map(cell => h('th', null, inline(cell))))),
        h('tbody', null, rows.map(row => h('tr', null, head.map((_, c) => h('td', null, inline(row[c] ?? '')))))))));
      continue;
    }
    if (LIST.test(line)) {
      const [list, next] = parseList(lines, i, indentOf(line));
      out.push(list); i = next; continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines, i))) para.push(lines[i++].trim());
    const p = h('p', { class: 'md-p' });
    para.forEach((text, index) => {
      if (index) p.append(/ {2}$|\\$/.test(para[index - 1]) ? h('br') : ' ');
      p.append(inline(text.replace(/\\$/, '')));
    });
    out.push(p);
  }
  return out;
}

function parseList(lines, start, indent) {
  const first = LIST.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const list = h(ordered ? 'ol' : 'ul', { class: 'md-list' });
  if (ordered) { const n = parseInt(first[2], 10); if (n !== 1) list.setAttribute('start', String(n)); }
  let i = start, item = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && indentOf(lines[j]) >= indent && (LIST.test(lines[j]) ? true : indentOf(lines[j]) > indent)) { i = j; continue; }
      break;
    }
    const m = LIST.exec(line), ind = indentOf(line);
    if (m && ind < indent) break;
    if (m && ind <= indent + 1) {
      if (/\d/.test(m[2]) !== ordered) break;
      item = h('li');
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[3]);
      if (task) item.append(h('span', { class: `md-task${task[1] === ' ' ? '' : ' done'}` }), inline(task[2]));
      else item.append(inline(m[3]));
      list.append(item); i++; continue;
    }
    if (m && item) { const [sub, next] = parseList(lines, i, ind); item.append(sub); i = next; continue; }
    if (!m && item && (ind > indent || !isBlockStart(lines, i))) { item.append(' ', inline(line.trim())); i++; continue; }
    break;
  }
  return [list, i];
}

// Backslash escapes are mapped to private-use code points before parsing and restored in text.
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!|~>])/g;
const protect = text => text.replace(ESCAPE, (_, c) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const restore = text => text.replace(/[-]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xe000));

const INLINE = new RegExp([
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source,                 // 1,2 code
  /\*\*(?=\S)([\s\S]*?\S)\*\*/.source,                           // 3 bold
  /(?<![\w])__(?=\S)([\s\S]*?\S)__(?![\w])/.source,              // 4 bold
  /~~(?=\S)([\s\S]*?\S)~~/.source,                               // 5 strike
  /\*(?=[^\s*])([\s\S]*?[^\s*])\*/.source,                       // 6 italic
  /(?<![\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/.source,        // 7 italic
  /(!?)\[([^\]\n]*)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))*)>?(?:\s+["'][^"'\n]*["'])?\s*\)/.source, // 8,9,10 link / image
  /(https?:\/\/[^\s<]*[^\s<.,;:!?)"'\]])/.source,                // 11 bare URL
].join('|'), 'g');

export function inline(text) {
  return inlineNodes(protect(String(text ?? '')));
}

function inlineNodes(text) {
  const frag = document.createDocumentFragment();
  let last = 0, m;
  const re = new RegExp(INLINE.source, 'g');
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(restore(text.slice(last, m.index)));
    if (m[2] !== undefined) frag.append(h('code', { class: 'md-code' }, restore(m[2].replace(/^ (.*) $/, '$1'))));
    else if (m[3] !== undefined || m[4] !== undefined) frag.append(h('strong', null, inlineNodes(m[3] ?? m[4])));
    else if (m[5] !== undefined) frag.append(h('s', null, inlineNodes(m[5])));
    else if (m[6] !== undefined || m[7] !== undefined) frag.append(h('em', null, inlineNodes(m[6] ?? m[7])));
    else if (m[9] !== undefined) {
      // Links never navigate: the label is shown as styled text. Images show their alt text.
      const label = m[9] || m[10];
      frag.append(m[8] ? h('span', { class: 'md-img-alt' }, `[${restore(label)}]`) : h('span', { class: 'md-link' }, inlineNodes(label)));
    } else if (m[11] !== undefined) frag.append(h('span', { class: 'md-link' }, restore(m[11].replace(/^https?:\/\/(www\.)?/, ''))));
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(restore(text.slice(last)));
  return frag;
}

// Plain text version (for collapsed history rows).
export function markdownToText(source) {
  return String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>|]+/g, '')
    .replace(/^\s*([-+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
