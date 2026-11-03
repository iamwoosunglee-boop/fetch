import { describe, expect, it } from 'vitest';
import { checkPhrase, fallbackPhrase, parsePhraseFacts } from '../phrase';
import { facts as fixtureFacts } from './fixtures';

const facts = { ...fixtureFacts, packs: [{ name: 'Impact', count: 3 }] };

describe('phrase facts boundary', () => {
  it.each([
    null, {}, { ...facts, unexpected: true }, { ...facts, count: '3' }, { ...facts, count: 0 },
    { ...facts, requested_count: 11 }, { ...facts, packs: [{ name: 'x', count: 1, extra: true }] },
    { ...facts, packs: [{ name: 'x'.repeat(81), count: 1 }] }, { ...facts, packs: [{ name: 'x', count: 1.5 }] },
    { ...facts, main_pack: 'x'.repeat(81) }, { ...facts, length_range: 'x'.repeat(41) },
    { ...facts, length_condition: false }, { ...facts, first_file: 'x'.repeat(81) },
    { ...facts, is_low_score: 0 }, { ...facts, changed: 'unknown' }, { ...facts, removed_by_length: -1 },
  ])('rejects invalid public facts %#', (value) => {
    expect(() => parsePhraseFacts(value)).toThrow('INVALID_PHRASE');
  });

  it('preserves valid facts without adding the original request', () => {
    expect(parsePhraseFacts(facts)).toEqual(facts);
  });
});

describe('phrase content check', () => {
  const accepted = fallbackPhrase(facts, 'search');
  it('does not read a digit in a pack name as a claim', () => {
    const named = { ...facts, packs: [{ name: 'Serum 2 Pads', count: 3 }], main_pack: 'Serum 2 Pads' };
    expect(checkPhrase(`Serum 2 Pads 팩을 중심으로 ${named.count}개를 가져왔어요.`, named)).toBe(true);
    expect(checkPhrase(`Serum 2 Pads 팩을 중심으로 ${named.count + 4}개를 가져왔어요.`, named)).toBe(false);
  });
  it('counts neither the length nor the periods of a pack name', () => {
    const name = 'Gamemaster Audio Pro Sound Collection Deluxe Vol. 2 Extended Edition With Extras';
    const named = { ...facts, packs: [{ name, count: 3 }] };
    expect(checkPhrase(`${name} 팩에서 3개를 가져왔어요. 맨 위 소리는 ${facts.first_file}예요.`, named)).toBe(true);
    expect(checkPhrase(`${name} 팩에서 3개를 가져왔어요. 소리예요. 파일이에요.`, named)).toBe(false);
  });

  it.each([['3초 이상', '3초 이상으로 좁혀'], ['0.5초 이하', '0.5초 이하로 좁혀'], ['1-2초', '1-2초로 좁혀']])('joins %s with the right ending', (condition, joined) => {
    const limited = { ...facts, length_condition: condition, length_range: null };
    expect(fallbackPhrase(limited, 'search').startsWith(joined)).toBe(true);
    expect(checkPhrase(fallbackPhrase(limited, 'search'), limited)).toBe(true);
  });

  it('gives a new request the normal sentence, and says what changed only for a shorter or longer one', () => {
    expect(fallbackPhrase({ ...facts, is_refinement: true }, 'search')).toBe(fallbackPhrase(facts, 'search'));
    expect(fallbackPhrase({ ...facts, is_refinement: true, changed: 'shorter' }, 'search')).not.toBe(fallbackPhrase(facts, 'search'));
  });

  it('accepts facts-based lines including decimal ranges and exact filenames', () => {
    expect(checkPhrase(accepted, facts)).toBe(true);
    expect(checkPhrase(fallbackPhrase({ ...facts, has_reference: true }, 'referenceOnly'), facts)).toBe(true);
  });

  it.each([
    '4개를 가져왔어요.',
    '3개를 가져왔어요. 길이는 9.00초예요.',
    '3개를 가져왔어요. 맨 위 소리는 other.wav예요.',
    '3개를 가져왔어요. 맨 위 소리는 evillaser_shot0.wav예요.',
    'Alien 팩에서 3개를 가져왔어요.',
    '3개를 가져왔어요. 없는 소리예요.',
    '묵직한 3개를 가져왔어요.',
    '점수로 3개를 골랐어요.',
    '0.5초 이하로 좁혀 3개를 가져왔어요.',
    '앞 결과보다 3개를 가져왔어요.',
    '다른 팩에서 3개를 가져왔어요.',
    '가장 가까운 3개를 골랐어요.',
    '3개를 찾아볼게요.',
    '3개를 가져오겠어요.',
    '3개를 가져왔어요. 🇰🇷',
    '3개를 가져왔어요!\n',
    '3개를 가져왔어요. 소리예요. 파일이에요.',
    '3개를 가져왔어요. 들어 보세요.',
  ])('rejects an unsupported claim or invalid format: %s', (line) => {
    expect(checkPhrase(line, facts)).toBe(false);
  });

  it('requires the low-score qualification and rejects a confident verb', () => {
    const low = { ...facts, is_low_score: true };
    expect(checkPhrase(fallbackPhrase(low, 'search'), low)).toBe(true);
    expect(checkPhrase(accepted, low)).toBe(false);
  });

  it.each([{ max: '0.5초 이하' }, { max: '3초 이상' }, { max: '1-2초' }])('keeps an explicit length separate from ranges: $max', ({ max }) => {
    const limited = { ...facts, length_condition: max, length_range: null };
    expect(checkPhrase(fallbackPhrase(limited, 'search'), limited)).toBe(true);
    expect(checkPhrase(fallbackPhrase({ ...limited, is_low_score: true }, 'search'), { ...limited, is_low_score: true })).toBe(true);
  });
});
