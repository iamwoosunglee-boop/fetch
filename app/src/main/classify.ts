import { ipcMain, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import { applyDecision, classifyLibrary, isClassifyDecision, type ClassifyDecision, type ClassifySound } from '../core/classify';
import { CATEGORIES } from '../core/classify/ucs-data.generated';
import type { Store } from './store';

export function registerClassify(window: BrowserWindow, store: Store): void {
  const decisions = () => Object.fromEntries(Object.entries(store.loadDecisions().data)
    .filter((entry): entry is [string, ClassifyDecision] => isClassifyDecision(entry[1])));
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== window.webContents) throw new Error('허용되지 않은 요청입니다.');
      return fn(...args);
    });
  handle('classify:overview', () => {
    const sounds: ClassifySound[] = store.loadItems().data.flatMap((item) => item.paths.map((entry) => ({
      id: item.id, folder: entry.folderId, fullHash: item.fullSha256,
      relativePath: path.relative(entry.folderId, entry.path),
      embedding: store.getEmbedding(item.id),
    })));
    return classifyLibrary(sounds, decisions());
  });
  handle('classify:export', () => {
    const file = store.exportDecisionsCsv();
    // A Finder window would take over the tester's screen, so automated runs only save the file.
    if (process.env.PROTO1_HIDDEN !== '1') shell.showItemInFolder(file);
    return file;
  });
  handle('classify:decide', (hashes: unknown, decision: unknown) => {
    if (!Array.isArray(hashes) || !isClassifyDecision(decision) || !CATEGORIES.includes(decision.category)) {
      throw new Error('올바른 분류 결과가 필요합니다.');
    }
    const existing = decisions();
    for (const hash of hashes) store.saveDecision(hash, applyDecision(existing[hash], decision));
  });
}
