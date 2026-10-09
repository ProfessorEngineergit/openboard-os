// Minimal observable UI state shared by the controller and React.
import { useSyncExternalStore } from 'react';

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const k in next) if (next[k] !== state[k]) { changed = true; break; }
      if (!changed) return;
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}

export function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.get);
}
