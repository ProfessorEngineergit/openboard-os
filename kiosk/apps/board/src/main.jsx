// OpenBoard Whiteboard entry point.
import './asset-path.js';
import { useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, FONT_FAMILY } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './styles.css';
import { BoardController } from './controller.js';
import { Toolbar } from './ui.jsx';
import { useStore } from './store.js';
import { PAPER_BACKGROUND } from './colors.js';

const controller = new BoardController();
window.__openboardBoard = controller.pageApi();

const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false,
    saveToActiveFile: false, toggleTheme: false, saveAsImage: false,
  },
  tools: { image: false },
};

const INITIAL = {
  appState: {
    viewBackgroundColor: PAPER_BACKGROUND,
    currentItemRoughness: 0,
    currentItemFontFamily: FONT_FAMILY.Nunito,
    currentItemFontSize: 28,
    currentItemStrokeWidth: 2,
    currentItemRoundness: 'round',
    currentItemArrowType: 'round',
    activeTool: { type: 'freedraw', customType: null, locked: false, lastActiveTool: null },
  },
};

function App() {
  const s = useStore(controller.store);
  const onApi = useCallback(api => controller.attach(api), []);
  const onChange = useCallback((elements, appState, files) => controller.onChange(elements, appState, files), []);
  const inkRef = useRef(null);
  const setInk = useCallback(canvas => { inkRef.current = canvas; controller.attachInk(canvas); }, []);
  return (
    <div className={`board-root paper-${s.paper}`} data-tool={s.tool}>
      <div className="board-canvas">
        <Excalidraw
          excalidrawAPI={onApi}
          initialData={INITIAL}
          onChange={onChange}
          theme={s.paper}
          langCode="de-DE"
          zenModeEnabled
          gridModeEnabled={false}
          handleKeyboardGlobally={false}
          autoFocus
          UIOptions={UI_OPTIONS}
          aiEnabled={false}
        />
      </div>
      <canvas ref={setInk} className="ink-layer" aria-hidden="true" />
      <Toolbar c={controller} />
    </div>
  );
}

createRoot(document.getElementById('app')).render(<App />);
