import type { ClassifyOverview } from './index';

export function categoryFilter(overview: ClassifyOverview, category: string): { ids: Set<string>; leftOut: number } {
  const confirmed = overview.sounds.filter(({ state }) => state === 'name' || state === 'human');
  return {
    ids: new Set(confirmed.filter((sound) => sound.category === category).map(({ id }) => id)),
    leftOut: overview.sounds.length - confirmed.length,
  };
}
