import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPlanServer } = require(path.join(process.env.RELAY_DIST, 'server/index.js'));
const plan = { english_queries: ['metal impact'], name_keywords: [], min_duration_seconds: null,
  max_duration_seconds: null, explanation: '금속 소리예요.' };

test('API accepts 1000 Unicode characters and rejects 1001 before an upstream call', async () => {
  // Given the default API backend with a test key and a wire response.
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-api-'));
  const keyFile = path.join(directory, 'key');
  await writeFile(keyFile, 'test-key');
  const calls = [];
  const server = createPlanServer({ keyFile, logCount: () => {}, fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json({ content: [{ type: 'text', text: JSON.stringify(plan) }] });
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/plan`;
    const body = JSON.stringify({ text: '🔊', has_reference: false, reference_duration_seconds: null, previous_plan: null });
    const exactly = body + ' '.repeat(1000 - [...body].length);
    // When submitting at and beyond the whole-request boundary.
    const accepted = await fetch(url, { method: 'POST', body: exactly });
    const rejected = await fetch(url, { method: 'POST', body: `${exactly} ` });
    // Then only the valid request reaches the API, without the model's rejected temperature setting.
    assert.equal(accepted.status, 200);
    assert.equal(rejected.status, 413);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].temperature, undefined);
    assert.equal(calls[0].model, 'claude-haiku-5-5');
    assert.equal(calls[0].max_tokens, 300);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
