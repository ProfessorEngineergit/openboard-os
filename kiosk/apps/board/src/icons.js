// Board-specific icons in the OBIcons style (24×24, 1.7 px stroke, round caps).
// Shared icons come from the global OBIcons (/ui/icons.js).
const own = {
  pen: '<path d="M4 20l1.2-4.6L15.6 5a2.1 2.1 0 0 1 3 0l.4.4a2.1 2.1 0 0 1 0 3L8.6 18.8 4 20Z"/><path d="M13.8 6.8l3.4 3.4"/>',
  highlighter: '<path d="M8.5 15.5 5 19h5l1.5-1.5"/><path d="m8.5 15.5 3 3 8.3-8.3a2 2 0 0 0 0-2.8l-.2-.2a2 2 0 0 0-2.8 0L8.5 15.5Z"/><path d="M3 21.5h8" opacity=".55"/>',
  eraser: '<path d="M8.5 20H20"/><path d="m4.7 14.3 9.6-9.6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 18.0a3.4 3.4 0 0 1-4.8 0l-1.5-1.5a1.6 1.6 0 0 1 0-2.2Z"/><path d="m9.2 9.8 5 5"/>',
  select: '<path d="M5 4l13 5.2-5.6 1.8L10.6 17 5 4Z"/><path d="m13 12 5 5"/>',
  lasso: '<path d="M7 16.5C4.6 15.4 3 13.4 3 11.2 3 7.2 7 4 12 4s9 3.2 9 7.2-4 7.2-9 7.2c-.9 0-1.8-.1-2.6-.3"/><circle cx="7.5" cy="17.5" r="1.6"/><path d="M7.6 19.1c.2 1.2-.3 2-1.3 2.4"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="2.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  line: '<path d="M5 19 19 5"/>',
  shapes: '<rect x="3.5" y="10.5" width="9" height="9" rx="2"/><circle cx="15.5" cy="8.5" r="5"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5"/>',
  sticky: '<path d="M5 4h14a1 1 0 0 1 1 1v9.5L14.5 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M14.5 20v-4.5a1 1 0 0 1 1-1H20"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
  collapse: '<path d="m6 15 6-6 6 6"/>',
  expand: '<path d="m6 9 6 6 6-6"/>',
  timemachine: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3 4v4.5h4.5"/><path d="M12 7.5V12l3 2"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5-5 4 4 2.5-2.5L20 19"/>',
  file: '<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5"/>',
  vector: '<path d="M6 18c2-8 10-4 12-12"/><rect x="3.5" y="15.5" width="5" height="5" rx="1"/><rect x="15.5" y="3.5" width="5" height="5" rx="1"/>',
  clear: '<path d="M4 20h16"/><path d="m6 16 9.5-9.5 3 3L9 19H6v-3Z" opacity=".5"/><path d="M14 3l1.2 2.4L17.6 6.6 15.2 7.8 14 10.2 12.8 7.8 10.4 6.6 12.8 5.4Z"/>',
  duplicate: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  boards: '<rect x="3" y="5" width="13" height="10" rx="2"/><path d="M8 19h11a2 2 0 0 0 2-2V9"/>',
};

export function icon(name) {
  const path = own[name] ?? globalThis.OBIcons?.paths?.[name] ?? '';
  return `<svg class="ob-icon" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}
