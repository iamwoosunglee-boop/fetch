import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from './ucs-data.generated';
import { categoryFilter } from './filter';
import { applyDecision, classifyLibrary, numberGroupKey, readUcsName, scoreCategories, type ClassifySound } from './index';

const oneHot = (...categories: string[]) => CATEGORIES.map((name) => (categories.includes(name) ? 1 : 0));
const model = { scale: 18.661176681518555, vector: (category: string) => oneHot(category) };
let nextId = 0;
const sound = (relativePath: string, embedding?: number[], folder = '/lib'): ClassifySound => {
  const id = String(++nextId);
  return { id, folder, relativePath, fullHash: id.padStart(64, '0'), embedding };
};

function wavNames(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? wavNames(join(directory, entry.name))
    : entry.name.endsWith('.wav') ? [entry.name] : []);
}

describe('UCS name reading', () => {
  it('reads the text before the first underscore and first hyphen', () => {
    expect(readUcsName('AMBForst_ForestBirds_OS_01.wav')).toBe('AMBIENCE');
    expect(readUcsName('AMBDsgn-LOOP_Ambience Cello_GNOMO_OOTM.wav')).toBe('AMBIENCE');
  });

  it('ignores case for ordinary CatIDs', () => {
    expect(readUcsName('ambforst_birds.wav')).toBe('AMBIENCE');
  });

  it('needs an underscore', () => {
    expect(readUcsName('AMBForst.wav')).toBeUndefined();
    expect(readUcsName('AMBForst-birds.wav')).toBeUndefined();
  });

  it.each(['test_01.wav', 'mix_final.wav', 'rain_01.wav', 'Wind_gust.wav', 'hail_1.wav', 'Storm_2.wav', 'raw_a.wav', 'ref_a.wav', 'prod_a.wav', 'asset_a.wav'])(
    'does not read the ordinary word in %s', (name) => expect(readUcsName(name)).toBeUndefined());

  it('accepts generic word codes in their exact case', () => {
    expect(readUcsName('RAIN_light.wav')).toBe('RAIN');
    expect(readUcsName('WIND_gust.wav')).toBe('WIND');
    expect(readUcsName('STORM_far.wav')).toBe('WEATHER');
  });

  it('reads all 654 UCS samples', () => {
    const names = wavNames('../_experiments/ucs_samples');
    expect(names).toHaveLength(654);
    expect(names.filter((name) => readUcsName(name) === undefined)).toEqual([]);
  });
});

describe('scores', () => {
  it('multiplies cosine by the scale and applies softmax inside the candidate list', () => {
    const scores = scoreCategories([1, 0], ['A', 'B'], { scale: 1, vector: (name) => (name === 'A' ? [1, 0] : [0, 1]) });
    expect(scores[0].category).toBe('A');
    expect(scores[0].probability).toBeCloseTo(0.7310586, 6);
    expect(scores[1].probability).toBeCloseTo(0.2689414, 6);
  });

  it('changes when the candidate list changes', () => {
    const vectors: Record<string, number[]> = { A: [1, 0], B: [0, 1], C: [1, 0] };
    const scores = scoreCategories([1, 0], ['A', 'B', 'C'], { scale: 1, vector: (name) => vectors[name] });
    expect(scores[0].probability).toBeCloseTo(0.4223188, 6);
  });
});

describe('UCS name sounds', () => {
  it('keeps the name when the model agrees', () => {
    const item = sound('AMBForst_birds.wav', oneHot('AMBIENCE'));
    const { sounds, cards } = classifyLibrary([item], {}, model);
    expect(sounds[0]).toMatchObject({ state: 'name', category: 'AMBIENCE' });
    expect(cards).toEqual([]);
  });

  it('adds a name category outside the 18 to the candidates', () => {
    const { sounds } = classifyLibrary([sound('VOXMale_hello.wav', oneHot('VOICES'))], {}, model);
    expect(sounds[0]).toMatchObject({ state: 'name', category: 'VOICES' });
  });

  it('sends the sound to a card when another category reaches 0.95, with the name category first', () => {
    const { sounds, cards } = classifyLibrary([sound('AMBForst_birds.wav', oneHot('METAL'))], {}, model);
    expect(sounds[0]).toMatchObject({ state: 'card', category: 'AMBIENCE' });
    expect(cards).toHaveLength(1);
    expect(cards[0].nameCategory).toBe('AMBIENCE');
    expect(cards[0].candidates).toHaveLength(3);
    expect(cards[0].candidates.slice(0, 2)).toEqual(['AMBIENCE', 'METAL']);
  });

  it('stays with the name while no model score reaches 0.95', () => {
    const { sounds } = classifyLibrary([sound('AMBForst_birds.wav', oneHot('METAL', 'WOOD'))], {}, model);
    expect(sounds[0].state).toBe('name');
  });

  it('reads the name before analysis finishes', () => {
    expect(classifyLibrary([sound('AMBForst_birds.wav')], {}, model).sounds[0].state).toBe('name');
  });
});

describe('sounds without a code', () => {
  it('stay unclassified until analysed', () => {
    expect(classifyLibrary([sound('hit.wav')], {}, model).sounds[0]).toMatchObject({ state: 'unclassified' });
  });

  it('never get a confirmed category from the model', () => {
    const result = classifyLibrary([sound('hit.wav', oneHot('METAL'))], {}, model);
    expect(result.sounds[0].state).toBe('card');
    expect(result.sounds[0].category).toBeUndefined();
  });

  it('go to cards with the top 3 candidates even when the model is sure', () => {
    const items = [sound('a.wav', oneHot('METAL')), sound('b.wav', oneHot('WOOD'))];
    const { cards } = classifyLibrary(items, {}, model);
    expect(cards.map((card) => [card.soundIds, card.candidates[0], card.candidates.length])).toEqual([
      [[items[0].id], 'METAL', 3], [[items[1].id], 'WOOD', 3],
    ]);
  });

  it('go to a card when the model prefers a category outside the 18 defaults', () => {
    const result = classifyLibrary([sound('hit.wav', oneHot('VOICES'))], {}, model);
    expect(result.sounds[0].state).toBe('card');
  });

  it('go to a card below 0.95', () => {
    const result = classifyLibrary([sound('hit.wav', oneHot('METAL', 'WOOD'))], {}, model);
    expect(result.sounds[0].state).toBe('card');
    expect(result.cards[0].candidates).toHaveLength(3);
    expect(result.cards[0].candidates.slice(0, 2).sort()).toEqual(['METAL', 'WOOD']);
  });

  it('read a removal saved by the old AI batches as no decision', () => {
    const item = sound('hit.wav', oneHot('METAL'));
    const result = classifyLibrary([item], { [item.fullHash]: { excluded: true } } as never, model);
    expect(result.sounds[0].state).toBe('card');
    expect(result.cards[0].soundIds).toEqual([item.id]);
  });
});

describe('number groups', () => {
  const low = oneHot('METAL', 'WOOD');

  it('put files that differ only by number in one card', () => {
    const items = [sound('steps/step_01.wav', low), sound('steps/step_02.wav', low), sound('steps/step_10.wav', low)];
    expect(classifyLibrary(items, {}, model).cards.map((card) => card.soundIds)).toEqual([items.map((item) => item.id)]);
  });

  it('keep different folders and different words apart', () => {
    const items = [sound('a/hit1.wav', low), sound('b/hit2.wav', low), sound('a/kick1.wav', low), sound('c/hit1.wav', low, '/other')];
    expect(classifyLibrary(items, {}, model).cards).toHaveLength(4);
  });

  it('never group number-only names', () => {
    const items = [sound('1.wav', low), sound('2.wav', low), sound('10_20.wav', low), sound('11_21.wav', low)];
    expect(classifyLibrary(items, {}, model).cards).toHaveLength(4);
    expect(numberGroupKey('/lib', '001.wav')).toBeUndefined();
    expect(numberGroupKey('/lib', 'no number.wav')).toBeUndefined();
  });
});

describe('human decisions', () => {
  it('win over the name and the model on every analysis', () => {
    const item = sound('AMBForst_birds.wav', oneHot('METAL'));
    const decisions = { [item.fullHash]: { category: 'WOOD' } };
    for (let run = 0; run < 2; run++) {
      const result = classifyLibrary([item], decisions, model);
      expect(result.sounds[0]).toMatchObject({ state: 'human', category: 'WOOD' });
      expect(result.cards).toEqual([]);
    }
  });

  it('are not replaced by a later decision', () => {
    expect(applyDecision({ category: 'WOOD' }, { category: 'METAL' })).toEqual({ category: 'WOOD' });
    expect(applyDecision({ excluded: true } as never, { category: 'METAL' })).toEqual({ category: 'METAL' });
    expect(applyDecision(undefined, { category: 'METAL' })).toEqual({ category: 'METAL' });
  });
});

describe('category filter', () => {
  it('includes only name and human sounds and counts what is left out', () => {
    const named = sound('AMBForst_birds.wav', oneHot('AMBIENCE'));
    const human = sound('hit.wav', oneHot('METAL'));
    const noCode = sound('other.wav', oneHot('AMBIENCE'));
    const conflict = sound('AMBForst_metal.wav', oneHot('METAL'));
    const waiting = sound('waiting.wav');
    const overview = classifyLibrary([named, human, noCode, conflict, waiting], { [human.fullHash]: { category: 'AMBIENCE' } }, model);
    const filter = categoryFilter(overview, 'AMBIENCE');
    expect([...filter.ids].sort()).toEqual([named.id, human.id].sort());
    expect(filter.leftOut).toBe(3);
  });
});
