import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '..', 'src', 'index.js');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
    },
    timeout: options.timeout ?? 8000,
  });
}

function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeout ?? 8000;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: null, signal: 'SIGKILL', stdout, stderr });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      finish({ status, signal, stdout, stderr });
    });
  });
}

test('shows help output', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SocialSeal CLI/i);
  assert.match(result.stdout, /Usage:/i);
});

test('invalid JSON body returns structured error', () => {
  const result = runCli(['tools', 'call', '--function', 'tracking', '--body', '{bad', '--json', '--api-key', 'test']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /"code":"INVALID_JSON"/);
  assert.match(result.stderr, /"message":"Invalid body JSON"/);
});

test('tools list returns built-in registry metadata', () => {
  const result = runCli(['tools', 'list', '--json']);
  assert.equal(result.status, 0);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.discovery, 'built_in_registry');
  assert.ok(Array.isArray(payload.tools));
  assert.ok(payload.tools.some((tool) => tool.name === 'tracking'));
  assert.ok(payload.tools.some((tool) => tool.name === 'google-ai-search'));
});

test('agent run fails fast on websocket error events', async () => {
  const httpServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/cli/agent/session') {
      const { port } = httpServer.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          sessionId: 'session-test',
          activeConversationId: 'conversation-test',
          websocketUrl: `ws://127.0.0.1:${port}/cli/agent/ws?ws_token=test`,
        },
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => {
    socket.on('message', () => {
      socket.send(JSON.stringify({
        type: 'error',
        payload: {
          code: 'AI_ERROR',
          message: 'Backend failed',
          retryable: false,
          errorId: 'err_cli_test',
        },
        timestamp: Date.now(),
      }));
    });
  });

  httpServer.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/cli/agent/ws')) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      'agent',
      'run',
      '--message',
      'ping',
      '--api-key',
      'test',
      '--api-base',
      `http://127.0.0.1:${port}`,
      '--verbose',
    ]);

    assert.equal(result.status, 5, result.stderr || result.stdout);
    assert.match(result.stderr, /Agent error: Backend failed/);
    assert.match(result.stderr, /err_cli_test/);
    assert.ok(!/timed out/i.test(result.stderr), result.stderr);
  } finally {
    for (const client of wss.clients) {
      client.close();
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
