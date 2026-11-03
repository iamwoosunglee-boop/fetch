/** Unselected coefficients stay zero. Thresholds are upper cuts on the best raw score; rankResults says what null means. */
export interface SearchTuning {
  readonly lambda: number;
  readonly beta: number;
  readonly gamma: number;
  readonly thresholds: Readonly<Record<'text' | 'reference' | 'both', number | null>>;
}

// beta and gamma are interim until the listening judgments choose the final values; lambda stays off.
// The text and both cuts come from 8 no-match requests and may change after the listening judgments.
export const SEARCH_TUNING: SearchTuning = {
  lambda: 0, beta: 0.1, gamma: 0.1,
  thresholds: { text: 0.394, reference: null, both: 0.394 },
};

export interface ScoreInput {
  readonly sentenceScores: readonly number[];
  readonly referenceScore?: number;
  readonly commonScore?: number;
  readonly matchingWords: number;
  readonly duration: number;
  readonly typicalMaxSeconds?: number | null;
  readonly explicitLength: boolean;
}

export function scoreSound(input: ScoreInput, tuning: SearchTuning = SEARCH_TUNING) {
  const text = input.sentenceScores.length ? Math.max(...input.sentenceScores) : undefined;
  const rawScore = text === undefined ? input.referenceScore ?? 0
    : input.referenceScore === undefined ? text : (text + input.referenceScore) / 2;
  const textScore = text === undefined ? undefined : text - tuning.lambda * (input.commonScore ?? 0);
  const base = textScore === undefined ? input.referenceScore ?? 0
    : input.referenceScore === undefined ? textScore : (textScore + input.referenceScore) / 2;
  const nameBonus = tuning.beta * Math.min(input.matchingWords, 2);
  const typical = input.typicalMaxSeconds;
  const lengthPenalty = !input.explicitLength && typical && input.duration > typical
    ? tuning.gamma * Math.min(1, (input.duration - typical) / typical) : 0;
  return { rawScore, textScore, nameBonus, lengthPenalty, score: base + nameBonus - lengthPenalty };
}

