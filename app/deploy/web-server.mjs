// Serves the static web demo and forwards the same-origin /plan to the relay.
// Differs from scripts/serve-web.mjs in one way: it passes on the one client IP
// header set by the tunnel, so the relay can count requests per real visitor.
// It must stay bound to loopback: only the tunnel may reach it.
import { createServer, request } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.png': 'image/png',
};

const root = path.resolve(process.env.WEB_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'web'));
const upstream = new URL('/plan', process.env.RELAY_URL ?? 'http://127.0.0.1:18787');
const clientIpHeader = process.env.TRUSTED_PROXY_HEADER || null;

const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (req.url === '/plan' || req.url === '/phrase') {
    const forwarded = { 'content-type': req.headers['content-type'] ?? 'application/json' };
    if (clientIpHeader && typeof req.headers[clientIpHeader] === 'string') {
      forwarded[clientIpHeader] = req.headers[clientIpHeader];
    }
    const proxy = request(new URL(req.url, upstream), { method: req.method, headers: forwarded }, (response) => {
      res.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/json' });
      response.pipe(res);
    });
    proxy.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'UPSTREAM_ERROR' }));
    });
    res.on('close', () => proxy.destroy());
    req.pipe(proxy);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(`${root}${path.sep}`)) { res.writeHead(403); res.end(); return; }
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Content-Length': info.size });
    if (req.method === 'HEAD') res.end();
    else createReadStream(target).on('error', () => res.destroy()).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});

server.on('error', () => {
  console.error('WEB_START_FAILED');
  process.exitCode = 1;
});
server.listen(Number(process.env.PORT ?? 14173), '127.0.0.1', () => {
  console.log(`WEB_READY http://127.0.0.1:${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.closeAllConnections();
  server.close();
});
