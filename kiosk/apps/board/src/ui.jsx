// Liquid-glass toolbar, popovers and sheets. German labels, ≥56 px targets.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from './store.js';
import { icon } from './icons.js';
import { SWATCHES, PEN_WIDTHS, displayColor } from './colors.js';

const Icon = ({ name }) => <span className="ic" dangerouslySetInnerHTML={{ __html: icon(name) }} />;

const STATUS = {
  idle: 'Lädt …', saved: 'Gespeichert', saving: 'Speichert …',
  offline: 'Offline – lokal gesichert', error: 'Speichern fehlgeschlagen',
};

const SHAPE_ITEMS = [
  { id: 'rect', label: 'Rechteck', icon: 'rect' },
  { id: 'ellipse', label: 'Ellipse', icon: 'ellipse' },
  { id: 'arrow', label: 'Pfeil', icon: 'arrow' },
  { id: 'line', label: 'Linie', icon: 'line' },
];

function Tool({ name, label, pressed, onClick, disabled, children, id }) {
  return (
    <button type="button" className="tb-btn" data-id={id} aria-label={label} title={label}
      aria-pressed={pressed === undefined ? undefined : !!pressed} disabled={disabled} onClick={onClick}>
      {children || <Icon name={name} />}
    </button>
  );
}

function relTime(ms) {
  if (!ms) return '';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.round(diff / 60)} Min.`;
  const d = new Date(ms), today = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `heute, ${time}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `gestern, ${time}`;
  return `${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}, ${time}`;
}

const count = n => `${n} ${n === 1 ? 'Element' : 'Elemente'}`;

function clock(ms) {
  const d = new Date(ms), today = new Date();
  const time = `${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
  if (d.toDateString() === today.toDateString()) return `Heute, ${time}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Gestern, ${time}`;
  return `${d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

function Popover({ anchor, children, wide }) {
  const ref = useRef(null);
  const [left, setLeft] = useState(null);
  useLayoutEffect(() => {
    const button = document.querySelector(`.tb [data-id="${anchor}"]`);
    const bar = document.querySelector('.tb');
    if (!button || !bar || !ref.current) return;
    const b = button.getBoundingClientRect(), t = bar.getBoundingClientRect();
    const w = ref.current.offsetWidth;
    const center = b.left + b.width / 2;
    const x = Math.min(Math.max(center - w / 2, 16), innerWidth - w - 16);
    setLeft(x - t.left);
  }, [anchor]);
  return (
    <div ref={ref} className={`tb-pop ob-glass strong${wide ? ' wide' : ''}`} style={{ left: left ?? 0, opacity: left === null ? 0 : 1 }} role="dialog">
      {children}
    </div>
  );
}

function ColorPanel({ c, s }) {
  const highlighter = s.tool === 'highlighter';
  const current = highlighter ? s.hlColor : s.penColor;
  return (
    <Popover anchor="color">
      <div className="pop-label">{highlighter ? 'Textmarker' : 'Farbe'}</div>
      <div className="swatches">
        {SWATCHES.map(sw => (
          <button key={sw.id} type="button" className="swatch" aria-label={sw.label} title={sw.label}
            aria-pressed={current === sw.color} onClick={() => c.setColor(sw.color)}>
            <i style={{ background: displayColor(sw.color, s.paper) }} />
          </button>
        ))}
      </div>
      <div className="pop-label">Strichstärke</div>
      <div className="widths">
        {PEN_WIDTHS.map(w => (
          <button key={w.id} type="button" className="width" aria-label={w.label} title={w.label}
            aria-pressed={!highlighter && s.width === w.id} onClick={() => c.setWidth(w.id)}>
            <b><i style={{ width: 6 + w.stroke * 5, height: 6 + w.stroke * 5, background: displayColor(s.penColor, s.paper) }} /></b>
            <span>{w.label}</span>
          </button>
        ))}
      </div>
    </Popover>
  );
}

function MenuItem({ name, label, onClick, danger, hint }) {
  return (
    <button type="button" className={`menu-item${danger ? ' danger' : ''}`} onClick={onClick}>
      <Icon name={name} /><span>{label}</span>{hint && <small>{hint}</small>}
    </button>
  );
}

function Sheet({ title, onClose, children, footer }) {
  return (
    <div className="sheet ob-glass strong" role="dialog" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <button type="button" className="tb-btn" aria-label="Schließen" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="sheet-body ob-scroll">{children}</div>
      {footer && <footer>{footer}</footer>}
    </div>
  );
}

function BoardRow({ c, board, active }) {
  const [mode, setMode] = useState(null);
  const [name, setName] = useState(board.name);
  const input = useRef(null);
  useEffect(() => { if (mode === 'rename') input.current?.focus(); }, [mode]);
  if (mode === 'rename') {
    const save = async () => { if (name.trim()) await c.renameBoard(board.id, name.trim()); setMode(null); };
    return (
      <div className="row editing">
        <input ref={input} className="ob-input" value={name} maxLength={80} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setMode(null); }} aria-label="Name" />
        <button type="button" className="tb-btn" aria-label="Abbrechen" onClick={() => { setName(board.name); setMode(null); }}><Icon name="close" /></button>
        <button type="button" className="tb-btn accent" aria-label="Speichern" onClick={save}><Icon name="check" /></button>
      </div>
    );
  }
  if (mode === 'delete') {
    return (
      <div className="row confirm">
        <div className="row-main"><strong>„{board.name}“ löschen?</strong><small>Das Board wandert in den Papierkorb.</small></div>
        <button type="button" className="pill" onClick={() => setMode(null)}>Abbrechen</button>
        <button type="button" className="pill danger" onClick={() => c.deleteBoard(board.id)}>Löschen</button>
      </div>
    );
  }
  return (
    <div className={`row${active ? ' active' : ''}`}>
      <button type="button" className="row-main" onClick={() => { c.openBoard(board.id); c.store.set({ sheet: null }); }}>
        <strong>{board.name}</strong>
        <small>{[relTime(board.updated), Number.isFinite(board.elements) ? count(board.elements) : null].filter(Boolean).join(' · ')}</small>
      </button>
      {active && <span className="row-check"><Icon name="check" /></span>}
      <button type="button" className="tb-btn" aria-label="Umbenennen" onClick={() => setMode('rename')}><Icon name="edit" /></button>
      <button type="button" className="tb-btn" aria-label="Löschen" onClick={() => setMode('delete')}><Icon name="trash" /></button>
    </div>
  );
}

function BoardsSheet({ c, s }) {
  useEffect(() => { c.refreshBoards(); }, [c]);
  return (
    <Sheet title="Boards" onClose={() => c.store.set({ sheet: null })}
      footer={<button type="button" className="pill primary" onClick={() => c.createBoard(nextName(s.boards))}><Icon name="plus" />Neues Board</button>}>
      {s.boards.map(b => <BoardRow key={b.id + b.name} c={c} board={b} active={b.id === s.boardId} />)}
    </Sheet>
  );
}

function nextName(boards) {
  const names = new Set(boards.map(b => b.name));
  for (let i = 1; ; i++) { const name = i === 1 ? 'Neues Board' : `Neues Board ${i}`; if (!names.has(name)) return name; }
}

function SnapshotSheet({ c, s }) {
  const [confirm, setConfirm] = useState(null);
  useEffect(() => { c.loadSnapshots(); }, [c, s.boardId]);
  const list = s.snapshots;
  return (
    <Sheet title="Zeitmaschine" onClose={() => c.store.set({ sheet: null })}>
      <p className="sheet-hint">Stündliche Stände der letzten 14 Tage. Vor dem Wiederherstellen wird der aktuelle Stand gesichert.</p>
      {list === null && <div className="empty">Lädt …</div>}
      {list && !list.length && <div className="empty">Noch keine Stände. Der erste entsteht nach einer Stunde Arbeit.</div>}
      {list && list.map(snap => (
        <div key={snap.id} className={`row${confirm === snap.id ? ' confirm' : ''}`}>
          <div className="row-main static">
            <strong>{clock(snap.created)}</strong>
            <small>{count(snap.elements)}{snap.reason === 'pre-restore' ? ' · vor einer Wiederherstellung' : ''} · {relTime(snap.created)}</small>
          </div>
          {confirm === snap.id ? (
            <>
              <button type="button" className="pill" onClick={() => setConfirm(null)}>Abbrechen</button>
              <button type="button" className="pill primary" onClick={() => c.restoreSnapshot(snap.id)}>Wiederherstellen</button>
            </>
          ) : (
            <button type="button" className="pill" onClick={() => setConfirm(snap.id)}><Icon name="timemachine" />Zurückholen</button>
          )}
        </div>
      ))}
    </Sheet>
  );
}

export function Toolbar({ c }) {
  const s = useStore(c.store);
  const toggle = name => c.store.set({ popover: s.popover === name ? null : name });
  const color = displayColor(s.tool === 'highlighter' ? s.hlColor : s.penColor, s.paper);
  const shapeIcon = SHAPE_ITEMS.find(x => x.id === s.shape)?.icon || 'shapes';
  const currentIcon = s.tool === 'shape' ? shapeIcon : s.tool === 'select' && s.selectMode === 'lasso' ? 'lasso' : s.tool;
  const status = s.notice || STATUS[s.status] || '';

  if (s.collapsed) {
    return (
      <div className="tb-wrap" data-ob-theme={s.paper}>
        <div className="tb collapsed ob-glass" onClick={() => c.store.set({ collapsed: false })}>
          <Tool name={currentIcon} label="Werkzeugleiste einblenden" />
          <span className="dot" style={{ background: color }} />
          <span className={`status-dot ${s.status}`} />
          <Tool name="expand" label="Werkzeugleiste einblenden" />
        </div>
      </div>
    );
  }

  const pick = tool => {
    if (s.tool === tool && (tool === 'pen' || tool === 'highlighter')) toggle('color');
    else c.setTool(tool);
  };

  return (
    <div className="tb-wrap" data-ob-theme={s.paper}>
      <div className="tb ob-glass">
        <button type="button" className="tb-board" data-id="boards" onClick={() => c.store.set({ sheet: s.sheet === 'boards' ? null : 'boards', popover: null })}
          aria-label="Boards">
          <Icon name="boards" />
          <span className="tb-board-text">
            <strong>{s.boardName || 'Whiteboard'}</strong>
            <small className={`st ${s.notice ? 'notice' : s.status}`}><i className={`status-dot ${s.status}`} />{status}</small>
          </span>
        </button>
        <span className="tb-sep" />
        <Tool id="pen" name="pen" label="Stift" pressed={s.tool === 'pen'} onClick={() => pick('pen')} />
        <Tool id="highlighter" name="highlighter" label="Textmarker" pressed={s.tool === 'highlighter'} onClick={() => pick('highlighter')} />
        <Tool id="eraser" name="eraser" label="Radierer" pressed={s.tool === 'eraser'} onClick={() => c.setTool('eraser')} />
        <Tool id="select" name={s.selectMode === 'lasso' ? 'lasso' : 'select'} label="Auswählen" pressed={s.tool === 'select' || s.tool === 'lasso'}
          onClick={() => (s.tool === 'select' || s.tool === 'lasso' ? toggle('select') : c.setTool(s.selectMode === 'lasso' ? 'lasso' : 'select'))} />
        <Tool id="shape" name={shapeIcon} label="Formen" pressed={s.tool === 'shape'}
          onClick={() => (s.tool === 'shape' ? toggle('shape') : c.setTool('shape', { popover: 'shape' }))} />
        <Tool id="text" name="text" label="Text" pressed={s.tool === 'text'} onClick={() => c.setTool('text')} />
        <Tool id="sticky" name="sticky" label="Notiz" pressed={s.tool === 'sticky'} onClick={() => c.setTool('sticky')} />
        <span className="tb-sep" />
        <Tool id="color" label="Farbe und Stärke" pressed={s.popover === 'color'} onClick={() => toggle('color')}>
          <span className="color-dot" style={{ background: color }} />
        </Tool>
        <span className="tb-sep" />
        <Tool id="undo" name="undo" label="Rückgängig" disabled={!s.canUndo} onClick={() => c.history('undo')} />
        <Tool id="redo" name="redo" label="Wiederholen" disabled={!s.canRedo} onClick={() => c.history('redo')} />
        <Tool id="more" name="more" label="Mehr" pressed={s.popover === 'more'} onClick={() => toggle('more')} />
        <Tool id="collapse" name="collapse" label="Werkzeugleiste ausblenden" onClick={() => c.store.set({ collapsed: true, popover: null, sheet: null })} />
      </div>

      {s.popover === 'color' && <ColorPanel c={c} s={s} />}
      {s.popover === 'shape' && (
        <Popover anchor="shape">
          <div className="seg-row">
            {SHAPE_ITEMS.map(item => (
              <Tool key={item.id} name={item.icon} label={item.label} pressed={s.shape === item.id}
                onClick={() => c.setTool('shape', { shape: item.id })} />
            ))}
          </div>
        </Popover>
      )}
      {s.popover === 'select' && (
        <Popover anchor="select">
          <div className="menu">
            <MenuItem name="select" label="Auswählen" hint="Tippen oder Rahmen ziehen" onClick={() => c.setTool('select', { selectMode: 'select' })} />
            <MenuItem name="lasso" label="Lasso" hint="Freie Form umfahren" onClick={() => c.setTool('lasso', { selectMode: 'lasso' })} />
          </div>
        </Popover>
      )}
      {s.popover === 'more' && (
        <Popover anchor="more" wide>
          <div className="menu">
            <MenuItem name="timemachine" label="Zeitmaschine" hint="Frühere Stände" onClick={() => c.store.set({ sheet: 'snapshots', popover: null })} />
            <MenuItem name="grid" label="Alles zeigen" onClick={() => c.zoomToFit()} />
            <div className="menu-sep" />
            <MenuItem name="image" label="Als PNG exportieren" onClick={() => c.export('png')} />
            <MenuItem name="vector" label="Als SVG exportieren" onClick={() => c.export('svg')} />
            <MenuItem name="file" label="Als .excalidraw sichern" onClick={() => c.export('excalidraw')} />
            <div className="menu-sep" />
            <MenuItem name="clear" label="Tafel leeren" hint="Rückgängig möglich" danger onClick={() => c.clear()} />
          </div>
        </Popover>
      )}
      {s.sheet === 'boards' && <BoardsSheet c={c} s={s} />}
      {s.sheet === 'snapshots' && <SnapshotSheet c={c} s={s} />}
    </div>
  );
}
