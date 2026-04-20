import type { LoadedFile } from '../analyzer/types';

const DB_NAME = 'cid-session';
const DB_VERSION = 2; // v2: multi-app support with appId-keyed files
const STORE_NAME = 'files';
const APP_META_KEY = 'cid_app_groups';

export const EXTERNAL_APP_ID = '__external__';

export interface AppMeta {
  id: string;
  name: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // Drop old store on schema upgrade (v1 → v2 changes key format)
      if (req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.deleteObjectStore(STORE_NAME);
      }
      req.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function saveAppMeta(apps: AppMeta[]): void {
  localStorage.setItem(APP_META_KEY, JSON.stringify(apps));
}

export function loadAppMeta(): AppMeta[] | null {
  try {
    const raw = localStorage.getItem(APP_META_KEY);
    return raw ? (JSON.parse(raw) as AppMeta[]) : null;
  } catch {
    return null;
  }
}

export function clearAppMeta(): void {
  localStorage.removeItem(APP_META_KEY);
}

/** Save all app files and external files in one transaction (clears previous session). */
export async function saveSession(
  apps: { id: string; files: LoadedFile[] }[],
  externalFiles: LoadedFile[]
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const app of apps) {
      for (const file of app.files) {
        store.put({ key: `${app.id}::${file.zone}::${file.filename}`, appId: app.id, ...file });
      }
    }
    for (const file of externalFiles) {
      store.put({ key: `${EXTERNAL_APP_ID}::${file.zone}::${file.filename}`, appId: EXTERNAL_APP_ID, ...file });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load all files, grouped by appId. External files use appId === EXTERNAL_APP_ID. */
export async function loadSession(): Promise<{
  filesPerApp: Map<string, LoadedFile[]>;
  externalFiles: LoadedFile[];
}> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const filesPerApp = new Map<string, LoadedFile[]>();
      const externalFiles: LoadedFile[] = [];
      for (const { key: _key, appId, ...file } of req.result as ({ key: string; appId: string } & LoadedFile)[]) {
        if (appId === EXTERNAL_APP_ID) {
          externalFiles.push(file);
        } else {
          if (!filesPerApp.has(appId)) filesPerApp.set(appId, []);
          filesPerApp.get(appId)!.push(file);
        }
      }
      resolve({ filesPerApp, externalFiles });
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearSession(): Promise<void> {
  clearAppMeta();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
