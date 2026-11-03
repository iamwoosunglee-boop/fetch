import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { parsePlan, parsePlanRequest, requestPlan, type PlanRequest } from './plan';
import { createPlanServer } from '../../server/index';

export const examplePlan = {
  english_queries: ['A metallic impact rings out'],
  name_keywords: [],
  min_duration_seconds: null,
  max_duration_seconds: null,
  explanation: '금속이 부딪히는 소리를 찾습니다.',
};

describe('plan contract', () => {
  it('returns only validated plan fields and rejects malformed plans', () => {
    expect(parsePlan({ ...examplePlan, extra: 'discard' })).toEqual(examplePlan);
    for (const value of [
      null, {}, { ...examplePlan, english_queries: ['a', 'b', 'c', 'd'] },
      { ...examplePlan, name_keywords: [3] },
      { ...examplePlan, name_keywords: ['a', 'b', 'c', 'd'] },
      { ...examplePlan, english_queries: [''] },
      { ...examplePlan, min_duration_seconds: -1 },
      { ...examplePlan, max_duration_seconds: Infinity },
      { ...examplePlan, min_duration_seconds: 3, max_duration_seconds: 2 },
      { ...examplePlan, explanation: 'two\nlines' },
    ]) expect(() => parsePlan(value)).toThrow('INVALID_PLAN');
    expect(parsePlan({ ...examplePlan, english_queries: [] }).english_queries).toEqual([]);
  });

  it('accepts an optional integer result_count from 1 to 10', () => {
    expect(parsePlan({ ...examplePlan, result_count: 5 })).toEqual({ ...examplePlan, result_count: 5 });
    expect(parsePlan({ ...examplePlan, result_count: 1 }).result_count).toBe(1);
    expect(parsePlan({ ...examplePlan, result_count: 10 }).result_count).toBe(10);
    expect(parsePlan({ ...examplePlan, result_count: null })).toEqual(examplePlan);
    for (const result_count of [0, 11, 2.5, '3', -1, NaN]) {
      expect(() => parsePlan({ ...examplePlan, result_count })).toThrow('INVALID_PLAN');
    }
  });

  it('never carries result_count in previous_plan', () => {
    const parsed = parsePlanRequest({ ...request, previous_plan: { ...examplePlan, result_count: 4 } });
    expect(parsed.previous_plan).toEqual(examplePlan);
    expect(() => parsePlanRequest({ ...request, previous_plan: { ...examplePlan, result_count: 40 } })).toThrow('INVALID_REQUEST');
  });
});

const request: PlanRequest = {
  text: '금속 부딪히는 소리', has_reference: false,
  reference_duration_seconds: null, previous_plan: null,
};
let directory: string;
let server: Server;
let url: string;
const upstream = vi.fn<typeof fetch>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'proto1-server-test-'));
  await writeFile(join(directory, 'key'), 'test-only-key');
  upstream.mockReset();
  upstream.mockImplementation(async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(examplePlan) }],
  })));
});

afterEach(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function start(options: Parameters<typeof createPlanServer>[0] = {}) {
  server = createPlanServer({ keyFile: join(directory, 'key'), fetch: upstream, logCount: () => {}, ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  url = `http://127.0.0.1:${address.port}/plan`;
}

describe('plan server', () => {
  it('returns a validated plan through the client using fixed API settings', async () => {
    await start();
    expect(await requestPlan(url, request)).toEqual(examplePlan);
    const [endpoint, init] = upstream.mock.calls[0];
    expect(endpoint).toBe('https://api.anthropic.com/v1/messages');
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, max_tokens: 300,
      messages: [{ role: 'user', content: JSON.stringify(request) }],
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('rejects an entire input over 1,000 characters before contacting the API', async () => {
    await start();
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(request).padEnd(1001) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'INPUT_TOO_LONG' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('accepts exactly 1,000 Unicode characters and bounds oversized byte streams', async () => {
    await start();
    const body = JSON.stringify({ ...request, text: '🔊' });
    expect((await fetch(url, {
      method: 'POST', body: body + ' '.repeat(1000 - [...body].length),
    })).status).toBe(200);
    const oversized = await fetch(url, { method: 'POST', body: 'x'.repeat(2001) });
    expect([oversized.status, await oversized.json()]).toEqual([413, { error: 'INPUT_TOO_LONG' }]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('opens only POST /plan and rejects caller-controlled settings', async () => {
    await start();
    for (const [path, method, body, status, error] of [
      ['/other', 'POST', JSON.stringify(request), 404, 'NOT_FOUND'],
      ['/plan', 'PUT', JSON.stringify(request), 405, 'METHOD_NOT_ALLOWED'],
      ['/plan', 'POST', '{', 400, 'INVALID_JSON'],
      ['/plan', 'POST', JSON.stringify({ ...request, model: 'other' }), 400, 'INVALID_REQUEST'],
      ['/plan', 'POST', JSON.stringify({ ...request, text: '' }), 400, 'INVALID_REQUEST'],
      ['/plan', 'POST', JSON.stringify({ ...request, has_reference: 'yes' }), 400, 'INVALID_REQUEST'],
      ['/plan', 'POST', JSON.stringify({ ...request, reference_duration_seconds: -1 }), 400, 'INVALID_REQUEST'],
      ['/plan', 'POST', JSON.stringify({ ...request, previous_plan: {} }), 400, 'INVALID_REQUEST'],
    ] as const) {
      const response = await fetch(new URL(path, url), { method, body });
      expect([response.status, await response.json()]).toEqual([status, { error }]);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('reports sanitized upstream and key-file failures through the client', async () => {
    await start();
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(examplePlan) }],
    }), { status: 503 }));
    await expect(requestPlan(url, request)).rejects.toThrow('UPSTREAM_ERROR');
    upstream.mockResolvedValueOnce(new Response('not json'));
    await expect(requestPlan(url, request)).rejects.toThrow('INVALID_PLAN');
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: '{}' }],
    })));
    await expect(requestPlan(url, request)).rejects.toThrow('INVALID_PLAN');
    upstream.mockRejectedValueOnce(new Error('sensitive upstream diagnostic'));
    await expect(requestPlan(url, request)).rejects.toThrow('UPSTREAM_ERROR');
    await rm(join(directory, 'key'));
    await expect(requestPlan(url, request)).rejects.toThrow('KEY_UNAVAILABLE');
  });

  it('limits the 121st request per IP for one hour and ignores forged proxy headers', async () => {
    let time = Date.UTC(2026, 9, 30);
    await start({ now: () => time });
    for (let i = 0; i < 120; i++) {
      const response = await fetch(url, {
        method: 'POST', body: '{}', headers: { 'CF-Connecting-IP': `192.0.2.${i + 1}` },
      });
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    const limited = await fetch(url, { method: 'POST', body: '{}' });
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'RATE_LIMITED' }]);
    time += 3_600_000;
    expect(await requestPlan(url, request)).toEqual(examplePlan);
  });

  it('trusts an IP header only from a configured immediate proxy and limits the whole UTC day', async () => {
    let time = Date.UTC(2026, 9, 30);
    await start({
      now: () => time,
      trustedProxy: { address: '127.0.0.1', header: 'cf-connecting-ip' },
    });
    for (let i = 0; i < 5000; i++) {
      const response = await fetch(url, {
        method: 'POST', body: '{}',
        headers: { 'CF-Connecting-IP': `192.0.2.${Math.floor(i / 100) + 1}` },
      });
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    const limited = await fetch(url, { method: 'POST', body: '{}' });
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'DAILY_LIMIT' }]);
    time += 86_400_000;
    expect(await requestPlan(url, request)).toEqual(examplePlan);
  }, 15_000);

  it('rejects a sixth simultaneous request and releases slots after completion', async () => {
    await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    let calls = 0;
    upstream.mockImplementation(async () => {
      const call = ++calls;
      if (call === 5) ready();
      if (call <= 5) await gate;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(examplePlan) }] }));
    });
    const pending = Array.from({ length: 5 }, () => requestPlan(url, request));
    try {
      await entered;
      const response = await fetch(url, { method: 'POST', body: JSON.stringify(request) });
      expect([response.status, await response.json()]).toEqual([503, { error: 'BUSY' }]);
    } finally {
      release();
      await Promise.all(pending);
    }
    expect(await requestPlan(url, request)).toEqual(examplePlan);
  });

  it('aborts the upstream at 60 seconds and returns TIMEOUT without leaking a slot', async () => {
    await start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signal: AbortSignal | null | undefined;
    upstream.mockImplementationOnce(async (_url, init) => {
      signal = init?.signal;
      ready();
      await gate;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(examplePlan) }] }));
    });
    const pending = fetch(url, { method: 'POST', body: JSON.stringify(request) });
    try {
      await entered;
      expect(signal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal!.aborted).toBe(true);
      const response = await pending;
      expect([response.status, await response.json()]).toEqual([504, { error: 'TIMEOUT' }]);
    } finally {
      release();
      await pending;
    }
    vi.useRealTimers();
    expect(await requestPlan(url, request)).toEqual(examplePlan);
  });

  it('bounds the client wait and reports offline without exposing transport errors', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('private transport details')), { once: true });
      });
    }));
    const pending = requestPlan('http://127.0.0.1/plan', request);
    const assertion = expect(pending).rejects.toThrow('TIMEOUT');
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(65_000);
    await assertion;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private transport details')));
    await expect(requestPlan('http://127.0.0.1/plan', request)).rejects.toThrow('OFFLINE');
  });
});
