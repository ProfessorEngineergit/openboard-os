// Tiny IndexedDB wrapper. Every call degrades to a no-op when IndexedDB is unavailable
// (private window, blocked storage); the server stays the source of truth.
const NAME = 'openboard-board';
const STORES = ['scenes', 'outbox', 'files'];
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      try {
        const request = indexedDB.open(NAME, 1);
        request.onupgradeneeded = () => { for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(store, mode);
      const request = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

export const idb = {
  get: (store, key) => run(store, 'readonly', s => s.get(key)),
  put: (store, key, value) => run(store, 'readwrite', s => s.put(value, key)),
  delete: (store, key) => run(store, 'readwrite', s => s.delete(key)),
};
