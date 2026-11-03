import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export function savedReplies(responses) {
  const saved = new Map();
  for (const entry of Object.values(responses)) {
    const input = entry.input ?? JSON.parse(entry.body.messages[0].content);
    const plan = entry.plan ?? JSON.parse(entry.response.content
      .filter((part) => part.type === 'text').map((part) => part.text).join(''));
    saved.set(JSON.stringify(input), { status: entry.status, plan });
  }
  return saved;
}

export function requireReplies(saved, inputs) {
  for (const input of inputs) assert(saved.has(JSON.stringify(input)), 'REPLAY_MISSING_REPLY');
}

export function createReplayRelay({ replay, saved, base, record }) {
  return createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/plan');
      assert.equal(request.method, 'POST');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const body = JSON.stringify(input);
      const key = createHash('sha256').update(body).digest('hex');
      let result = saved.get(body);
      let live = false;
      if (!result) {
        assert(!replay, 'REPLAY_MISSING_REPLY');
        const upstream = await fetch(new URL('/plan', base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body, signal: AbortSignal.timeout(65_000),
        });
        result = { status: upstream.status, plan: await upstream.json() };
        saved.set(body, result);
        live = true;
      }
      await record({ key, input, ...result, live });
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.plan));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error && error.message === 'REPLAY_MISSING_REPLY'
        ? 'REPLAY_MISSING_REPLY' : 'TEST_RELAY_FAILED' }));
    }
  });
}
