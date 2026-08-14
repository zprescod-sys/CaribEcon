/* End-to-end test of the MCP adapter over a REAL stdio JSON-RPC session.
 *
 * This spawns mcpServer.mjs as a child process and speaks the actual protocol to it — no mocks,
 * no stubbed transport. It is the local half of the Phase 0b proof: everything from "OpenClaw
 * launches the child process" rightwards is exercised here, so the only unknown left for the
 * live test is the gateway hop itself. When the live invoke misbehaves, this file is what tells
 * you whether the fault is ours or the gateway's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./mcpServer.mjs', import.meta.url));

/* A minimal MCP stdio client: newline-delimited JSON-RPC 2.0 over the child's stdin/stdout.
   Hand-rolled rather than pulled from the SDK so the test observes the wire format directly —
   if the SDK changed its framing, this test should notice rather than agree with it. */
function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  const pending = new Map();
  let buffer = '';
  let stderr = '';

  child.stderr.on('data', chunk => (stderr += chunk));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  const send = (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(
        () => reject(new Error(`timed out waiting for "${method}". stderr: ${stderr}`)),
        10_000,
      ).unref();
    });
  };
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  return { child, send, notify, stderr: () => stderr };
}

/* Full handshake, exactly as a real MCP client performs it. */
async function connect(env) {
  const server = startServer(env);
  const init = await server.send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'caribecon-phase0b-test', version: '0.0.1' },
  });
  server.notify('notifications/initialized');
  return { ...server, init };
}

test('initialize: the server identifies itself and advertises tools', async t => {
  const server = await connect();
  t.after(() => server.child.kill());

  assert.equal(server.init.result.serverInfo.name, 'caribecon-research');
  assert.ok(server.init.result.capabilities.tools, 'server must advertise a tools capability');
});

test('tools/list: exposes exactly one tool, caribecon_research', async t => {
  const server = await connect();
  t.after(() => server.child.kill());

  const { result } = await server.send('tools/list');
  assert.equal(result.tools.length, 1, 'the restricted agent must reach exactly one tool');

  const [tool] = result.tools;
  assert.equal(tool.name, 'caribecon_research');
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual(tool.inputSchema.required, ['question']);
});

test('tools/call: a ping returns the agreed Phase 0b JSON', async t => {
  const server = await connect();
  t.after(() => server.child.kill());

  const { result } = await server.send('tools/call', {
    name: 'caribecon_research',
    arguments: { question: 'ping' },
  });

  const expected = { ok: true, service: 'caribecon-research', runtime: 'noinfra' };
  assert.equal(result.isError ?? false, false);
  // Both encodings must agree — the gateway may surface either one.
  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
});

test('tools/call: the runtime label follows CARIBECON_RUNTIME, proving portability end to end', async t => {
  const server = await connect({ CARIBECON_RUNTIME: 'vercel' });
  t.after(() => server.child.kill());

  const { result } = await server.send('tools/call', {
    name: 'caribecon_research',
    arguments: { question: 'ping' },
  });
  assert.equal(result.structuredContent.runtime, 'vercel');
});

test('tools/call: an empty question is refused rather than answered', async t => {
  const server = await connect();
  t.after(() => server.child.kill());

  const { result } = await server.send('tools/call', {
    name: 'caribecon_research',
    arguments: { question: '' },
  });
  assert.equal(result.isError, true);
});

test('tools/call: an unknown tool name is refused — the surface is one tool, not a namespace', async t => {
  const server = await connect();
  t.after(() => server.child.kill());

  const response = await server.send('tools/call', {
    name: 'exec',
    arguments: { command: 'echo pwned' },
  });
  // Either a JSON-RPC error or an isError result is acceptable; silently running it is not.
  assert.ok(
    response.error || response.result?.isError,
    'an unregistered tool must never execute',
  );
});
