import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'vite';
import electron from 'electron';

const compiler = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json'], { stdio: 'inherit' });
const [code] = await once(compiler, 'exit');
if (code !== 0) process.exit(code || 1);

const server = await createServer();
await server.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, PROTO1_DEV_URL: server.resolvedUrls.local[0] },
});
const close = () => child.kill('SIGTERM');
process.on('SIGINT', close);
process.on('SIGTERM', close);
try {
  const [exitCode] = await once(child, 'exit');
  process.exitCode = exitCode || 0;
} finally {
  await server.close();
  process.removeListener('SIGINT', close);
  process.removeListener('SIGTERM', close);
}
