import type { SearchSound } from '../../core/search';
import { dragPicture } from './drag-image';
import { app, logSound, platform, soundById, state, web } from './state';

const SOUND_TYPE = 'application/x-proto1-sound';
const PICTURE_HANDLE = 32;
const prepared = new Map<string, 'preparing' | 'ready' | 'error'>();

export const dragStatus = (sound: SearchSound) => prepared.get(sound.id);

export function prepareDrag(sound: SearchSound): void {
  const service = platform.search;
  if (!service?.prepareDrag || sound.blockedReason || prepared.has(sound.id)) return;
  prepared.set(sound.id, 'preparing');
  app.refreshList();
  service.prepareDrag(sound).then(() => { prepared.set(sound.id, 'ready'); app.refreshList(); }, (error) => {
    prepared.set(sound.id, 'error');
    app.refreshList();
    app.showError(error instanceof Error ? error.message : String(error));
  });
}

export function startDrag(event: DragEvent, sound: SearchSound): void {
  const picture = dragPicture(state.packs.get(sound.packId));
  if (web || !platform.search?.drag) {
    event.dataTransfer?.setData(SOUND_TYPE, sound.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setDragImage(picture, PICTURE_HANDLE, PICTURE_HANDLE);
    }
    return;
  }
  event.preventDefault();
  if (prepared.get(sound.id) !== 'ready') {
    if (prepared.get(sound.id) === 'error') prepared.delete(sound.id);
    prepareDrag(sound);
    app.showError('소리를 준비하고 있습니다. 잠시 뒤 다시 끌어다 놓아 주세요.');
    return;
  }
  logSound('drag', sound);
  void platform.search.drag(sound, picture.toDataURL('image/png')).catch(() => app.showError('아직 끌어다 놓을 수 없습니다. 소리를 선택한 뒤 다시 시도해 주세요.'));
}

/** Resolves what was dropped: a library sound (app rows, Finder files inside the library) or an outside file. */
export async function droppedSound(event: DragEvent): Promise<SearchSound | File | undefined> {
  const id = event.dataTransfer?.getData(SOUND_TYPE);
  if (id) return soundById(id);
  const file = event.dataTransfer?.files[0];
  if (!file) return undefined;
  const mapped = await platform.search?.soundIdForFile?.(file).catch(() => undefined);
  return (mapped && soundById(mapped)) || file;
}

export const carriesSound = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes(SOUND_TYPE) || event.dataTransfer?.types.includes('Files'));
