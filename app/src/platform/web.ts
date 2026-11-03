import type { ClassifyPlatform, CollectionsPlatform, Platform, SearchPlatform } from './types';
import { applyDecision, classifyLibrary, type ClassifyDecision } from '../core/classify';
import { isCollectionData, type CollectionData } from '../core/collections';
import { decisionsCsv } from '../core/files';
import { loadModel, onModelEvent } from '../model';
import { indexedDb, type WebDb } from './web/db';
import { analyseAudio } from './web/analysis';
import { createWebLibrary, type LibraryDeps, type WebLibrary } from './web/library';
import { createWebSearch } from './web/search';
import type { DirectoryHandle } from './web/fs';

export { supportedWebEnvironment } from './web/support';

function createCollections(db: WebDb): CollectionsPlatform {
  return {
    async load() {
      const saved = await db.get<CollectionData>('settings', 'collections');
      return saved && isCollectionData(saved) ? { favorites: [], ...saved } : { collections: [], searches: [], favorites: [] };
    },
    async save(data) {
      // A JSON round trip drops renderer proxies and functions IndexedDB cannot clone.
      await db.put('settings', 'collections', JSON.parse(JSON.stringify(data)));
    },
  };
}

/** The rules of src/main/classify.ts, with decisions kept in browser storage by full-file hash. */
function createClassify(db: WebDb, search: SearchPlatform): ClassifyPlatform {
  const decisions = async () => (await db.get<Record<string, ClassifyDecision>>('settings', 'decisions')) ?? {};
  return {
    async overview() {
      const sounds = (await search.loadSounds()).flatMap(({ id, root, relativePath, fullHash, embedding }) =>
        fullHash ? [{ id, folder: root ?? '', relativePath, fullHash, embedding }] : []);
      return classifyLibrary(sounds, await decisions());
    },
    async decide(fullHashes, decision) {
      const saved = await decisions();
      for (const hash of fullHashes) saved[hash] = applyDecision(saved[hash], decision);
      await db.put('settings', 'decisions', saved);
    },
    async exportCsv() {
      const name = 'decisions.csv';
      const url = URL.createObjectURL(new Blob([decisionsCsv(await decisions())], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      // Revoking at once can cancel the download before the browser reads the blob.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return name;
    },
  };
}

export function createWebPlatform(deps: Partial<LibraryDeps> & { db: WebDb }): { platform: Platform; library: WebLibrary } {
  const library = createWebLibrary({
    loadAudioModel: () => loadModel('audio'),
    onModelEvent,
    analyse: analyseAudio,
    pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
    now: Date.now,
    ...deps,
  });
  const search = createWebSearch(library);
  const platform: Platform = {
    kind: 'web',
    connections: library.connections,
    search,
    collections: createCollections(deps.db),
    classify: createClassify(deps.db, search),
    packs: { load: library.packs },
  };
  return { platform, library };
}

let created: ReturnType<typeof createWebPlatform> | undefined;
// Lazy, so importing this module (tests, Electron renderer) opens no IndexedDB.
const web = () => created ??= createWebPlatform({ db: indexedDb() });

export const webPlatform: Platform = {
  kind: 'web',
  get connections() { return web().platform.connections; },
  get search() { return web().platform.search; },
  get collections() { return web().platform.collections; },
  get classify() { return web().platform.classify; },
  get packs() { return web().platform.packs; },
};

declare global {
  interface Window {
    __proto1Platform?: Platform;
    __proto1TestConnectOpfs?: (name: string) => Promise<string>;
  }
}

// Automation only: headless Chromium has no folder picker, so OPFS stands in for a real directory handle.
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('proto1-test-opfs') === '1') {
  window.__proto1Platform = webPlatform;
  window.__proto1TestConnectOpfs = async (name) => {
    const storage = await navigator.storage.getDirectory();
    const folder = await storage.getDirectoryHandle(name);
    return web().library.connectHandle(folder as unknown as DirectoryHandle);
  };
}
