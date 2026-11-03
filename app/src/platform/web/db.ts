export type StoreName = 'folders' | 'sounds' | 'settings';

/** Browser storage for the web build. Values must be structured-cloneable (directory handles are). */
export interface WebDb {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  all<T>(store: StoreName): Promise<T[]>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
}

const stores: StoreName[] = ['folders', 'sounds', 'settings'];

export function indexedDb(name = 'fetch-app'): WebDb {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const store of stores) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function run<T>(store: StoreName, mode: IDBTransactionMode, action: (target: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result as T);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  return {
    get: (store, key) => run(store, 'readonly', (target) => target.get(key)),
    all: (store) => run(store, 'readonly', (target) => target.getAll()),
    put: async (store, key, value) => { await run(store, 'readwrite', (target) => target.put(value, key)); },
    delete: async (store, key) => { await run(store, 'readwrite', (target) => target.delete(key)); },
  };
}

/** Same contract in memory, for tests. Shallow copies, because test handles carry functions structuredClone rejects. */
export function memoryDb(): WebDb {
  const data = new Map(stores.map((store) => [store, new Map<string, unknown>()]));
  const copy = <T>(value: T): T => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value);
  return {
    async get(store, key) { return copy(data.get(store)!.get(key)) as never; },
    async all(store) { return [...data.get(store)!.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, value]) => copy(value)) as never; },
    async put(store, key, value) { data.get(store)!.set(key, copy(value)); },
    async delete(store, key) { data.get(store)!.delete(key); },
  };
}
