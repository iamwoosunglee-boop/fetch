// API live regression, or offline saved plan replay with --replay.
// SAVED_REPLIES points to a previous relay-regression.json. Missing replies fail before any calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const appDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const experiments = path.resolve(appDir, '../_experiments');
const out = path.resolve(appDir, '../../.omo/evidence/v3-relay');
await fs.mkdir(out, { recursive: true });
const replay = process.argv.includes('--replay');
const base = process.env.RELAY_URL ?? 'http://127.0.0.1:8787';

const judged = JSON.parse(await fs.readFile(path.join(experiments, 'cls_test/r7_test1/api_haiku55.json'), 'utf8')).map((row) => row.request);
const fresh = JSON.parse(await fs.readFile(path.join(experiments, 'listen_test3/new_requests.json'), 'utf8'));
const counted = [['레이저 발사 소리 5개 찾아줘', 5], ['짧은 버튼 클릭 소리 2개만 보여줘', 2], ['폭발하는 소리 찾아줘', undefined]];
const requests = [
  ...judged.map((text) => ({ group: 'judged', text, count: undefined })),
  ...fresh.map((text) => ({ group: 'new', text, count: undefined })),
  ...counted.map(([text, count]) => ({ group: 'count', text, count })),
];

const saved = replay ? new Map(JSON.parse(await fs.readFile(
  process.env.SAVED_REPLIES ?? path.join(out, 'relay-regression.json'), 'utf8',
)).rows.map((row) => [row.text, row])) : new Map();
if (replay) for (const request of requests) assert(saved.has(request.text), 'REPLAY_MISSING_REPLY');
const rows = [];
  for (const request of requests) {
    const began = performance.now();
    const response = replay ? new Response(JSON.stringify(saved.get(request.text).plan), { status: saved.get(request.text).status }) : await fetch(new URL('/plan', base), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(65_000),
      body: JSON.stringify({ text: request.text, has_reference: false, reference_duration_seconds: null, previous_plan: null }),
    });
    const body = await response.json();
    rows.push({
      ...request, status: response.status, ms: Math.round(performance.now() - began), plan: body,
      haeyo: typeof body.explanation === 'string' && /요[.!?]?$/.test(body.explanation.trim()),
      countOk: request.count === undefined ? body.result_count === undefined : body.result_count === request.count,
    });
    console.log(`${response.status} ${request.group} "${request.text}" -> ${body.explanation ?? body.error} count=${body.result_count ?? '-'} ${rows.at(-1).ms}ms`);
  }
const median = (values) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const summary = {
  requests: rows.length,
  ok: rows.filter((row) => row.status === 200).length,
  haeyo: rows.filter((row) => row.haeyo).length,
  countOk: rows.filter((row) => row.countOk).length,
  medianInputTokens: median(rows.map((row) => row.inputTokens)),
  medianOutputTokens: median(rows.map((row) => row.outputTokens)),
  medianMs: median(rows.map((row) => row.ms)),
  maxMs: Math.max(...rows.map((row) => row.ms)),
};
await fs.writeFile(path.join(out, replay ? 'relay-regression-replay.json' : 'relay-regression.json'), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
