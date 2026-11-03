import { expect, it } from 'vitest';
import { scoreSound, SEARCH_TUNING } from './scoring';
it('applies corrections only to their PRD terms and preserves raw cosine', () => {
  // Given a mixed request, two matching words and a sound twice its typical duration.
  const input = { sentenceScores: [0.6, 0.4], referenceScore: 0.8, commonScore: 0.2,
    matchingWords: 3, duration: 4, typicalMaxSeconds: 2, explicitLength: false };
  // When corrections are enabled.
  const result = scoreSound(input, { ...SEARCH_TUNING, lambda: 0.5, beta: 0.1, gamma: 0.15 });
  // Then raw score stays untouched while text, name and length corrections affect ranking.
  expect(result.rawScore).toBeCloseTo(0.7);
  expect(result.score).toBeCloseTo(0.7);
  expect(result.textScore).toBeCloseTo(0.5);
  expect(result.nameBonus).toBeCloseTo(0.2);
  expect(result.lengthPenalty).toBeCloseTo(0.15);
  expect(scoreSound({ ...input, explicitLength: true }, { ...SEARCH_TUNING, gamma: 1 }).lengthPenalty).toBe(0);
});
