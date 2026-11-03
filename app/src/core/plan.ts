export interface SearchPlan {
  english_queries: string[];
  name_keywords: string[];
  file_words?: string[];
  typical_max_seconds?: number | null;
  min_duration_seconds: number | null;
  max_duration_seconds: number | null;
  explanation: string;
  /** Present only when the person stated how many results they want; 1 to 10. */
  result_count?: number;
}

export interface PlanRequest {
  text: string;
  has_reference: boolean;
  reference_duration_seconds: number | null;
  previous_plan: SearchPlan | null;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 3
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function duration(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

export function parsePlan(value: unknown): SearchPlan {
  if (!value || typeof value !== 'object') throw new Error('INVALID_PLAN');
  const p = value as Record<string, unknown>;
  if (!strings(p.english_queries) || !strings(p.name_keywords)
    || !duration(p.min_duration_seconds) || !duration(p.max_duration_seconds)
    || (p.min_duration_seconds !== null && p.max_duration_seconds !== null
      && p.min_duration_seconds > p.max_duration_seconds)
    || typeof p.explanation !== 'string' || !p.explanation.trim()
    || /[\r\n]/u.test(p.explanation)) throw new Error('INVALID_PLAN');
  const count = p.result_count;
  // Both are soft hints, so a bad value drops the hint and never costs the person the whole answer.
  const words = Array.isArray(p.file_words)
    ? [...new Set(p.file_words.flatMap((word) => (typeof word === 'string' ? word.toLowerCase().match(/[a-z]+/g) ?? [] : [])))].slice(0, 5)
    : undefined;
  const rawTypical = p.typical_max_seconds;
  const typical = rawTypical === undefined ? undefined
    : typeof rawTypical === 'number' && Number.isFinite(rawTypical) && rawTypical > 0 && rawTypical <= 30 ? rawTypical : null;
  if (count !== undefined && count !== null
    && (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10)) throw new Error('INVALID_PLAN');
  return {
    english_queries: [...p.english_queries],
    name_keywords: [...p.name_keywords],
    ...(words === undefined ? {} : { file_words: [...words] }),
    ...(typical === undefined ? {} : { typical_max_seconds: typical }),
    min_duration_seconds: p.min_duration_seconds,
    max_duration_seconds: p.max_duration_seconds,
    explanation: p.explanation,
    ...(typeof count === 'number' ? { result_count: count } : {}),
  };
}

export function parsePlanRequest(value: unknown): PlanRequest {
  if (!value || typeof value !== 'object') throw new Error('INVALID_REQUEST');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some((key) => !['text', 'has_reference', 'reference_duration_seconds', 'previous_plan'].includes(key))
    || typeof p.text !== 'string' || !p.text.trim()
    || typeof p.has_reference !== 'boolean'
    || !duration(p.reference_duration_seconds)
    || (!p.has_reference && p.reference_duration_seconds !== null)) throw new Error('INVALID_REQUEST');
  try {
    // A result count belongs to one request only, so it never travels with the previous plan.
    const previous = p.previous_plan === null ? null : parsePlan(p.previous_plan);
    if (previous) {
      delete previous.result_count;
      delete previous.file_words;
      delete previous.typical_max_seconds;
    }
    return {
      text: p.text, has_reference: p.has_reference,
      reference_duration_seconds: p.reference_duration_seconds,
      previous_plan: previous,
    };
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}

export async function requestPlan(endpoint: string, request: PlanRequest): Promise<SearchPlan> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65_000);
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch {
      throw new Error(controller.signal.aborted ? 'TIMEOUT' : 'OFFLINE');
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(controller.signal.aborted ? 'TIMEOUT' : 'INVALID_PLAN');
    }
    if (!response.ok) {
      const code = value && typeof value === 'object' && 'error' in value ? value.error : null;
      const allowed = [
        'INPUT_TOO_LONG', 'INVALID_JSON', 'INVALID_REQUEST', 'NOT_FOUND', 'METHOD_NOT_ALLOWED',
        'RATE_LIMITED', 'BUSY', 'DAILY_LIMIT', 'TIMEOUT', 'KEY_UNAVAILABLE', 'UPSTREAM_ERROR', 'INVALID_PLAN',
      ];
      throw new Error(typeof code === 'string' && allowed.includes(code) ? code : 'UPSTREAM_ERROR');
    }
    return parsePlan(value);
  } finally {
    clearTimeout(timer);
  }
}
