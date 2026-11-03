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
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

/**
 * Callers pass the relay explicitly; without one /plan answers 502. Only the command line falls back
 * to the usual local relay port, so a test never reaches a relay it did not start.
 */
export function createWebServer({ root = path.resolve('dist/web'), relay } = {}) {
  root = path.resolve(root);
  const upstream = relay ? new URL('/plan', relay) : undefined;
  if (upstream && (!['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) || upstream.protocol !== 'http:')) {
    throw new Error('The local relay must use a loopback HTTP address.');
  }
  return createServer(async (req, res) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (req.url === '/plan') {
      if (!upstream) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'UPSTREAM_ERROR' })); return; }
      // Never forward client-supplied proxy or credential headers.
      const proxy = request(upstream, {
        method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/json' });
        response.pipe(res);
      });
      proxy.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'UPSTREAM_ERROR' }));
      });
      req.on('aborted', () => proxy.destroy());
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createWebServer({ relay: process.env.RELAY_URL ?? 'http://127.0.0.1:8787' });
  server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', () => {
    console.log(`WEB_READY http://127.0.0.1:${server.address().port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.closeAllConnections();
    server.close();
  });
}
