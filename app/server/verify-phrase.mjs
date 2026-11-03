// Offline HTTP verification. Only loopback servers and a temporary fake key are used.
// Run with RELAY_DIST pointing at `tsc -p server --outDir ...` output.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { createPlanServer } = require(path.join(process.env.RELAY_DIST, 'server/index.js'));
const exec = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), 'phrase-curl-'));
const keyFile = path.join(directory, 'key');
await writeFile(keyFile, 'fake-local-key');
const counts = [];
const modelRequests = [];
const plan = { english_queries: ['impact'], name_keywords: [], min_duration_seconds: null,
  max_duration_seconds: null, explanation: 'test' };
const facts = {
  count: 3, requested_count: 3, packs: [{ name: 'Impact', count: 3 }], main_pack: null,
  length_range: '0.12-0.61초', length_condition: null, first_file: 'hit.wav',
  is_low_score: false, has_reference: false, reference_pack_avoided: false, is_refinement: false,
  changed: null, more_available: true, is_short: false, already_shown_excluded: false, removed_by_length: 0,
};
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  modelRequests.push(body);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(
    body.max_tokens === 150 ? { message: '3개를 가져왔어요.' } : plan,
  ) }] }));
});
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.notEqual(port, 8787);
  return `http://127.0.0.1:${port}`;
};
const fake = await listen(upstream);
const relay = createPlanServer({
  keyFile, backend: 'api', fetch: (_url, init) => fetch(fake, init),
  trustedProxy: { address: '127.0.0.1', header: 'x-forwarded-for' },
  logCount: (count) => counts.push(count),
});
const base = await listen(relay);
const proxy = spawn(process.execPath, ['deploy/web-server.mjs'], {
  env: { ...process.env, PORT: '0', RELAY_URL: base, TRUSTED_PROXY_HEADER: 'x-forwarded-for' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const proxyClosed = new Promise((resolve) => proxy.once('close', resolve));
const proxyReady = new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.once('exit', (code) => reject(new Error(`PROXY_EXIT_${code}`)));
  proxy.stdout.on('data', (chunk) => {
    const match = chunk.toString().match(/WEB_READY (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) resolve(match[1]);
  });
});
async function curl(route, body, expected) {
  const { stdout } = await exec('curl', ['-i', '-sS', '-X', 'POST', '-H', 'Content-Type: application/json',
    '--data-binary', body, base + route]);
  console.log(`curl -i POST ${route}\n${stdout}`);
  assert.match(stdout, new RegExp(`HTTP/1.1 ${expected}\\b`));
}
try {
  await curl('/phrase', JSON.stringify(facts), 200);
  await curl('/phrase', JSON.stringify({ ...facts, unknown: true }), 400);
  await curl('/phrase', 'x'.repeat(3072), 400);
  const web = await proxyReady;
  const forwarded = await fetch(`${web}/phrase`, { method: 'POST', body: JSON.stringify(facts) });
  assert.equal(forwarded.status, 200);
  assert.equal(typeof (await forwarded.json()).message, 'string');
  console.log('PASS public web proxy forwards /phrase to the local relay');
  assert.deepEqual(counts, []);
  console.log('PASS /plan count unchanged after /phrase calls');
  // Four phrase requests were counted above. Spread the rest over valid proxy IPs.
  for (let i = 4; i < 5000; i++) {
    const response = await fetch(base + '/phrase', {
      method: 'POST', body: '{',
      headers: { 'x-forwarded-for': `192.0.2.${Math.floor(i / 100) + 1}` },
    });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  await curl('/phrase', JSON.stringify(facts), 429);
  await curl('/plan', JSON.stringify({
    text: 'test', has_reference: false, reference_duration_seconds: null, previous_plan: null,
  }), 200);
  assert.deepEqual(counts, [1]);
  assert.equal(modelRequests.length, 3);
  console.log('PASS phrase day quota 5000 is independent; plan count is 1; only three fake model calls');
} finally {
  proxy.kill('SIGTERM');
  await proxyClosed;
  for (const server of [relay, upstream]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
  console.log('PASS servers closed and temporary profile removed');
}
