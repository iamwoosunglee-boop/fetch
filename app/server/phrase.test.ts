import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createPlanServer } from './index';
import { parsePhraseReply, phraseInput } from './phrase';
import type { PhraseFacts } from '../src/core/phrase';

const facts: PhraseFacts = {
  count: 3, requested_count: 3, packs: [{ name: 'Impact', count: 3 }], main_pack: null,
  length_range: '0.12-0.61초', length_condition: null, first_file: 'hit.wav',
  is_low_score: false, has_reference: false, reference_pack_avoided: false, is_refinement: false,
  changed: null, more_available: true, is_short: false, already_shown_excluded: false, removed_by_length: 0,
};
let directory = '';
let server: Server;
let url = '';
const upstream = vi.fn<typeof fetch>();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'phrase-test-'));
  await writeFile(join(directory, 'key'), 'fake-key');
  upstream.mockReset();
  upstream.mockResolvedValue(Response.json({ content: [{ type: 'text', text: JSON.stringify({ message: 'accepted' }) }] }));
  server = createPlanServer({ keyFile: join(directory, 'key'), fetch: upstream, logCount: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('NO_ADDRESS');
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
const post = (route: string, body: unknown = facts) => fetch(`${url}${route}`, { method: 'POST', body: JSON.stringify(body) });

describe('phrase relay', () => {
  it('returns the phrase envelope and sends only validated facts with the phrase token budget', async () => {
    const response = await post('/phrase');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'accepted 길이는 0.12-0.61초예요.' });
    const payload = JSON.parse(String(upstream.mock.calls[0]?.[1]?.body));
    expect(payload.max_tokens).toBe(150);
    expect(JSON.parse(payload.messages[0].content)).toEqual(phraseInput(facts));
  });

  it.each([{ ...facts, text: 'private request' }, { ...facts, first_file: 'x'.repeat(81) }, { ...facts, count: '3' }])('rejects invalid facts before calling a model %#', async (body) => {
    expect((await post('/phrase', body)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('returns 400 for an oversized phrase body', async () => {
    const response = await fetch(`${url}/phrase`, { method: 'POST', body: ' '.repeat(3072) });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('limits phrase requests per IP without using the plan IP window', async () => {
    for (let count = 0; count < 120; count++) {
      const response = await post('/phrase', {});
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    expect((await post('/phrase', {})).status).toBe(429);
    expect((await post('/plan', {})).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('aborts phrase API work at eight seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let entered: () => void = () => {};
    const called = new Promise<void>((resolve) => { entered = resolve; });
    let signal: AbortSignal | null | undefined;
    upstream.mockImplementation(async (_url, init) => {
      signal = init?.signal;
      entered();
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }));
    });
    const pending = post('/phrase');
    await called;
    await vi.advanceTimersByTimeAsync(7999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
    expect(signal?.aborted).toBe(true);
  });

  it('shares concurrency slots across plan and phrase routes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => {};
    const called = new Promise<void>((resolve) => { entered = resolve; });
    let count = 0;
    upstream.mockImplementation(async () => {
      if (++count === 5) entered();
      await gate;
      return Response.json({ content: [{ type: 'text', text: '{"message":"accepted"}' }] });
    });
    const pending = Array.from({ length: 5 }, () => post('/phrase'));
    try {
      await called;
      expect((await post('/plan', {
        text: 'test', has_reference: false, reference_duration_seconds: null, previous_plan: null,
      })).status).toBe(503);
    } finally {
      release();
      await Promise.all(pending);
    }
  });
});

describe('parsePhraseReply', () => {
  it('adds the second sentence the facts call for', () => {
    const one = { message: '3개를 가져왔어요.' };
    expect(parsePhraseReply(one, facts)).toEqual({ message: '3개를 가져왔어요. 길이는 0.12-0.61초예요.' });
    expect(parsePhraseReply(one, { ...facts, is_low_score: true })).toEqual({ message: '3개를 가져왔어요. hit.wav부터 들어 보세요.' });
    expect(parsePhraseReply(one, { ...facts, first_file: null, length_range: null })).toEqual({ message: '3개를 가져왔어요.' });
  });

  it('keeps the values of the second sentence from the model', () => {
    expect(phraseInput(facts)).toMatchObject({ count: 3, first_file: null, length_range: null });
  });

  it('rejects a reply without a message', () => {
    expect(() => parsePhraseReply({ sentence_1: '3개를 가져왔어요.' }, facts)).toThrow('INVALID_PHRASE');
  });
});
