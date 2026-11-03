import { expect, it } from 'vitest';
import { parsePlan, parsePlanRequest } from './plan';
const examplePlan = { english_queries: ['metal impact'], name_keywords: [], min_duration_seconds: null, max_duration_seconds: null, explanation: '금속 소리를 가져왔어요.' };
const request = { text: '금속', has_reference: false, reference_duration_seconds: null, previous_plan: null };
  it('parses v4 optional fields and strips automatic fields from previous plans', () => {
    // Given a v4 reply.
    const reply = { ...examplePlan, file_words: ['metal', 'impact'], typical_max_seconds: 2 };
    // When it is parsed as a reply and as previous context.
    const parsed = parsePlan(reply);
    const context = parsePlanRequest({ ...request, previous_plan: reply });
    // Then only the reply retains automatic fields.
    expect(parsed).toEqual(reply);
    expect(context.previous_plan).toEqual(examplePlan);
  });

  it('cleans soft hints instead of rejecting the whole answer', () => {
    // Given hints Haiku really returns, such as a hyphenated word, and hints out of range.
    const hints = (fields: object) => parsePlan({ ...examplePlan, ...fields });
    // When they are parsed, then the plan survives with only usable hints.
    expect(hints({ file_words: ['Sci-Fi', 'laser', 'laser', 'two words'] }).file_words)
      .toEqual(['sci', 'fi', 'laser', 'two', 'words']);
    expect(hints({ file_words: ['a', 'b', 'c', 'd', 'e', 'f'] }).file_words).toHaveLength(5);
    expect(hints({ file_words: 'metal' }).file_words).toBeUndefined();
    expect(hints({ typical_max_seconds: 0 }).typical_max_seconds).toBeNull();
    expect(hints({ typical_max_seconds: 31 }).typical_max_seconds).toBeNull();
  });
