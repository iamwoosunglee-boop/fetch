import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createPlanServer } from './dist/server/index.js';
import { parsePlan } from './dist/src/core/plan.js';

const servers = [];
const ports = [];
const logs = [];
const results = [];
const originalLog = console.log;
const originalError = console.error;
const keyFile = process.env.ANTHROPIC_API_KEY_FILE;
const texts = ['금속이 부딪히는 소리', '더 짧게', '더 길게'];
const directory = await mkdtemp(join(tmpdir(), 'proto1-task7-'));
const logFile = join(directory, 'server.log');
console.log = (...args) => logs.push(args.join(' '));
console.error = (...args) => logs.push(args.join(' '));

async function start(options = {}) {
  const server = createPlanServer(options);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  ports.push(port);
  return `http://127.0.0.1:${port}/plan`;
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', body });
  return { status: response.status, value: await response.json() };
}

async function errorCase(name, url, body, status, error) {
  const response = await post(url, body);
  assert.equal(response.status, status, `${name} status`);
  assert.equal(response.value.error, error, `${name} error`);
  results.push(`${name}: ${status} ${error}`);
}

async function grep(args, input) {
  const child = spawn('grep', args, { stdio: ['pipe', 'ignore', 'ignore'] });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.end(input);
  return await exit;
}

let failure = false;
try {
  assert.ok(keyFile, 'KEY_FILE_REQUIRED');
  const url = await start();
  for (let i = 0; i < texts.length; i++) {
    const response = await post(url, JSON.stringify({
      text: texts[i], has_reference: i > 0,
      reference_duration_seconds: i > 0 ? 2 : null, previous_plan: null,
    }));
    assert.equal(response.status, 200, `real API case ${i + 1}`);
    const plan = parsePlan(response.value);
    if (i === 0) {
      assert.equal(plan.min_duration_seconds, null);
      assert.equal(plan.max_duration_seconds, null);
      assert.ok(plan.english_queries.length > 0);
    } else {
      assert.equal(plan.english_queries.length, 0);
      if (i === 1) assert.equal(plan.max_duration_seconds, 1.4);
      if (i === 2) assert.equal(plan.min_duration_seconds, 2.6);
    }
    results.push(`REAL_API_${i + 1}: 200 valid SearchPlan; queries=${plan.english_queries.length}; min=${plan.min_duration_seconds}; max=${plan.max_duration_seconds}`);
  }
  await errorCase('501 characters', url, ' '.repeat(501), 413, 'INPUT_TOO_LONG');
  await errorCase('invalid JSON', url, '{', 400, 'INVALID_JSON');
  await errorCase('other path', new URL('/other', url), '{}', 404, 'NOT_FOUND');

  const limited = await start();
  for (let i = 0; i < 120; i++) {
    const response = await post(limited, '{}');
    assert.equal(response.status, 400);
  }
  await errorCase('request 121', limited, '{}', 429, 'RATE_LIMITED');

  const body = JSON.stringify({
    text: texts[0], has_reference: false, reference_duration_seconds: null, previous_plan: null,
  });
  let aborted = false;
  const timeout = await start({
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('cancelled'));
      }, { once: true });
    }),
  });
  const began = performance.now();
  await errorCase('timeout', timeout, body, 504, 'TIMEOUT');
  assert.ok(aborted);
  results.push(`timeout elapsed: ${Math.round(performance.now() - began)} ms; upstream aborted`);
  const missing = await start({ keyFile: join(directory, 'missing-key') });
  await errorCase('missing key file', missing, body, 503, 'KEY_UNAVAILABLE');
} catch {
  failure = true;
  results.push('QA_FAILED: an assertion failed; sensitive details withheld');
} finally {
  for (const server of servers) {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  console.log = originalLog;
  console.error = originalError;
}

try {
  await writeFile(logFile, logs.join('\n') + '\n', { mode: 0o600 });
  assert.ok(logs.every((line) => /^\{"requests":\d+\}$/.test(line)));
  assert.equal(await grep(['-F', '-q', '-f', keyFile, logFile]), 1);
  assert.equal(await grep(['-F', '-q', '-f', '-', logFile], texts.join('\n') + '\n'), 1);
  results.push('grep key file: exit 1 (no match); grep request texts: exit 1 (no match)');
  results.push(`captured logs: ${logs.length} count-only lines`);
  for (const port of ports) {
    let refused = false;
    try { await fetch(`http://127.0.0.1:${port}/plan`); } catch { refused = true; }
    assert.ok(refused);
  }
  results.push(`cleanup: ${servers.length} servers closed; all ${ports.length} ports refuse connections`);
} catch {
  failure = true;
  results.push('LOG_OR_CLEANUP_CHECK_FAILED');
} finally {
  await rm(directory, { recursive: true, force: true });
}
for (const result of results) console.log(result);
process.exitCode = failure ? 1 : 0;
