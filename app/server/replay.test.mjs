import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplayRelay, requireReplies, savedReplies } from './replay.mjs';

test('missing saved reply fails before any live call', async () => {
  // Given no saved reply and a live endpoint that must never be contacted.
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('LIVE_CALL_FORBIDDEN'); };
  try {
    // When preflighting missing replay data.
    assert.throws(() => requireReplies(new Map(), [{ text: '금속' }]), /REPLAY_MISSING_REPLY/);
    // Then no fetch, key file or fallback is used.
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('replay returns saved replies without a key or upstream connection', async () => {
  // Given a saved API response and no API key.
  const input = { text: '금속', has_reference: false, reference_duration_seconds: null, previous_plan: null };
  const plan = { english_queries: ['metal impact'] };
  const saved = savedReplies({ old: { body: { messages: [{ content: JSON.stringify(input) }] },
    status: 200, response: { content: [{ type: 'text', text: JSON.stringify(plan) }] } } });
  const recorded = [];
  const server = createReplayRelay({ replay: true, saved, base: 'http://127.0.0.1:1', record: (call) => recorded.push(call) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    // When replaying a saved input, then an absent input.
    const url = `http://127.0.0.1:${server.address().port}/plan`;
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(input) });
    // Then the saved plan is returned.
    assert.deepEqual(await response.json(), plan);
    assert.equal(recorded[0].live, false);
    const missing = await fetch(url, { method: 'POST', body: '{"text":"missing"}' });
    assert.equal(missing.status, 500);
    assert.deepEqual(await missing.json(), { error: 'REPLAY_MISSING_REPLY' });
    assert.equal(recorded.length, 1);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
