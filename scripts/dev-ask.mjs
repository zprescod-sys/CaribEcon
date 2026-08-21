// One-command local dev for the Ask CaribEcon task pane — `npm run dev:ask` from repo root.
//
// Testing Ask locally genuinely needs two separate servers running together (not one — see
// excel-addin/webpack.config.js's own comment on why `vercel dev` and the webpack dev server
// can't be merged): `vercel dev` serves the real /api/*.ts Vercel Functions, and the add-in's
// own dev server serves the https task-pane bundle and proxies /api/* to vercel dev. This script
// starts both, prefixes their output so it's clear which is which, and stops both together on
// Ctrl+C — it does not replace either process, just the two-terminal manual dance around them.
//
// vercel CLI is intentionally not a project dependency (see webpack.config.js's own note on
// this — it was the sole source of 24 Dependabot alerts on a public repo), so this always goes
// through npx, same as the manual command it replaces.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const addinDir = path.join(repoRoot, 'excel-addin');
const vercelDevPort = process.env.CARIBECON_VERCEL_DEV_PORT || '3001';

// Both dev servers' output previously only ever lived in the launching terminal's scrollback —
// gone the moment that terminal scrolled or closed, which is exactly what made a real incident
// (an "invalid structured response" 502 seen once, never diagnosed) unrecoverable after the
// fact. Appended, not overwritten, so a session survives across restarts; .tmp/ is already
// gitignored, same as devserver.log's own prior art.
mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
const logStream = createWriteStream(path.join(repoRoot, '.tmp', 'ask-dev.log'), { flags: 'a' });
logStream.write(`\n[dev:ask] session started ${new Date().toISOString()}\n`);

// A courtesy check, not a hard requirement: if something is already listening on the vercel dev
// port — most likely a `vercel dev` left running from an earlier session — reuse it instead of
// spawning a second instance that would just fall back to a different port and silently break
// the webpack proxy (this happened once already; see the port-conflict note this script exists
// to stop repeating).
function isPortTaken(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port: Number(port), host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Prefixes each line of a child process's output so two interleaved dev servers stay legible in
// one terminal, without buffering a whole process's output before showing any of it.
function pipeWithPrefix(stream, label) {
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const prefixed = `[${label}] ${line}`;
      console.log(prefixed);
      logStream.write(prefixed + '\n');
    }
  });
}

const children = [];

function spawnLabeled(label, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  pipeWithPrefix(child.stdout, label);
  pipeWithPrefix(child.stderr, label);
  child.on('exit', code => {
    // If one server dies, the other is not useful alone — bring the whole thing down rather
    // than leaving a half-working setup that fails in a confusing way.
    console.log(`[${label}] exited (code ${code}) — stopping the other server too.`);
    stopAll();
  });
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGINT');
  }
  logStream.end();
}

process.on('SIGINT', () => {
  console.log('\nStopping dev:ask...');
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', stopAll);

if (!existsSync(path.join(repoRoot, '.vercel', 'project.json'))) {
  console.error(
    'No .vercel/project.json found — this repo is not linked to a Vercel project yet.\n' +
      "Run 'npx vercel@58 link' from the repo root once, then re-run 'npm run dev:ask'.",
  );
  process.exit(1);
}

const vercelAlreadyRunning = await isPortTaken(vercelDevPort);
if (vercelAlreadyRunning) {
  console.log(`[dev:ask] Reusing an existing vercel dev already listening on port ${vercelDevPort}.`);
} else {
  spawnLabeled('vercel', 'npx', ['vercel@58', 'dev', '--listen', vercelDevPort, '--yes'], {
    cwd: repoRoot,
  });
}

// ASK_CARIBECON_MODE=ask here, explicitly — not left to .env alone — so `npm run dev:ask` does
// the right thing even on a machine whose .env has not been updated to set it (see
// excel-addin/webpack.config.js's own comment: dev-server already reads .env too, this is just
// belt-and-suspenders for this specific entry point).
spawnLabeled('addin', 'npm', ['run', 'dev-server'], {
  cwd: addinDir,
  env: { ...process.env, ASK_CARIBECON_MODE: 'ask' },
});

console.log(
  `[dev:ask] Starting. Add-in dev server: https://localhost:3000/ ` +
    `— vercel dev: http://localhost:${vercelDevPort}/. Ctrl+C stops both. ` +
    `Full output also logged to .tmp/ask-dev.log.`,
);
