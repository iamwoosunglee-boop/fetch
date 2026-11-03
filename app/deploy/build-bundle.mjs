// Builds deploy/out/proto1-server.tar.gz. Run from app: node deploy/build-bundle.mjs
// Leaves dist/web alone so a running web QA is not disturbed.
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const deploy = path.dirname(fileURLToPath(import.meta.url));
const app = path.dirname(deploy);
const webApp = await realpath(process.env.WEB_BASELINE_APP ?? app);
const out = path.join(deploy, 'out');
const stage = path.join(out, 'proto1-server');
const archive = path.join(out, 'proto1-server.tar.gz');
const keyPattern = /sk-ant-[A-Za-z0-9_-]{8,}/g;

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

await rm(out, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

const options = { cwd: app, maxBuffer: 1 << 24 };
await run('npx', ['tsc', '-p', 'server', '--outDir', path.join(stage, 'relay')], options);
// vite.web.config.mts always copies into dist/web, so it is skipped here on purpose.
const { build } = await import('vite');
await build({
  root: webApp, configFile: false, base: '/', publicDir: false, logLevel: 'warn',
  plugins: [{
    name: 'relay-client-timeout',
    enforce: 'pre',
    transform(code, id) {
      // Keep the frozen UI source, applying only this deployment's client timeout change.
      if (id === path.join(webApp, 'src/platform/web/search.ts')) {
        return code.replace(/AbortSignal\.timeout\((?:15|35)_000\)/g, 'AbortSignal.timeout(65_000)');
      }
      if (id === path.join(webApp, 'src/core/plan.ts')) {
        return code.replace(/controller\.abort\(\), (?:15|35)_000/g, 'controller.abort(), 65_000');
      }
    },
  }],
  build: { outDir: path.join(stage, 'web'), emptyOutDir: true, rollupOptions: { input: path.join(webApp, 'index.html') } },
});
for (const name of [
  'web-server.mjs', 'proto1.env.example', 'proto1-relay.service', 'proto1-web.service',
  'STATIC_HOSTING.md', 'post-deploy-check.sh', 'SERVER_BRIEF.md',
]) await cp(path.join(deploy, name), path.join(stage, name));

// Stop before packing if anything looks like a key. Matches are never printed.
let hits = 0;
for (const file of await files(stage)) {
  hits += (await readFile(file)).toString('latin1').match(keyPattern)?.length ?? 0;
}
if (hits) {
  console.error(`KEY_FORMAT_STRINGS=${hits}`);
  await rm(out, { recursive: true, force: true });
  process.exit(1);
}

await run('tar', ['-czf', archive, '-C', out, 'proto1-server']);
await rm(stage, { recursive: true });
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${digest}  proto1-server.tar.gz\n`);
console.log(`BUNDLE_READY ${path.relative(app, archive)} sha256=${digest} KEY_FORMAT_STRINGS=0`);
