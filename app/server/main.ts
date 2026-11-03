import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { createPlanServer, type ServerOptions } from './index.js';

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireKeyFile() {
  const keyFile = process.env.ANTHROPIC_API_KEY_FILE;
  let hasKey = false;
  try {
    hasKey = Boolean(keyFile && readFileSync(keyFile, 'utf8').trim());
  } catch {
    hasKey = false;
  }
  if (!hasKey) stop('KEY_FILE_UNAVAILABLE: ANTHROPIC_API_KEY_FILE must name a readable, non-empty file');
}

function trustedProxy(): ServerOptions['trustedProxy'] {
  const address = process.env.TRUSTED_PROXY_ADDRESS;
  const header = process.env.TRUSTED_PROXY_HEADER;
  if (!address && !header) return undefined;
  if (address && isIP(address) && (header === 'cf-connecting-ip' || header === 'x-forwarded-for')) {
    return { address, header };
  }
  stop('TRUSTED_PROXY_INVALID: set TRUSTED_PROXY_ADDRESS to one IP and TRUSTED_PROXY_HEADER to cf-connecting-ip or x-forwarded-for, or set neither');
}

requireKeyFile();
const server = createPlanServer({ trustedProxy: trustedProxy() });
server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1');
server.on('error', () => {
  console.error('SERVER_START_FAILED');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close();
  });
}
