import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { CREATOR_ACCOUNT_OPERATIONS } from '../src/contracts/creator-account.mjs';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const workspaceId = '11111111-1111-4111-8111-111111111111';
const receiptId = '22222222-2222-4222-8222-222222222222';
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, SOCIALSEAL_API_KEY: 'test-key', SOCIALSEAL_WORKSPACE_ID: '', SOCIALSEAL_CONFIG_PATH: '/tmp/socialseal-creator-nonexistent-config.json' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function withApi(fn, responses) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()), workspace: req.headers['x-workspace-id'] });
    const response = responses[Math.min(requests.length - 1, responses.length - 1)];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('creator commands are discoverable with canonical operation names', async () => {
  const result = await run(['creator', '--help']);
  assert.equal(result.code, 0);
  for (const operation of CREATOR_ACCOUNT_OPERATIONS) assert.match(result.stdout, new RegExp(operation.cliCommand));
  const registry = await run(['tools', 'schema', '--function', 'creator-account-collect', '--json']);
  assert.equal(registry.code, 0);
  assert.match(registry.stdout, /idempotencyKey/);
  assert.match(registry.stdout, /maxCredits/);
});
test('recent-post metrics preserve backend evidence including zero, null and denominators', async () => {
  const evidence = { schemaVersion: 'creator_account_v1', status: 'partial', posts: [{ url: 'https://www.instagram.com/p/test/', publishedAt: null, postType: 'carousel', metrics: { views: null, likes: 0 } }], aggregates: { averageViews: 0, viewsDenominator: 1, meanEngagementRateByViews: null }, coverage: { complete: false }, brandContext: { missing: true } };
  await withApi(async (url, requests) => {
    const result = await run(['creator', 'recent-posts', 'https://www.instagram.com/clubbradshaw/', '--count', '5', '--workspace-id', workspaceId, '--api-base', url, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), evidence);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/cli/tools/creator-account-read');
    assert.equal(requests[0].workspace, workspaceId);
    assert.deepEqual(requests[0].body, { action: 'recent_posts', workspaceId, target: 'https://www.instagram.com/clubbradshaw/', platform: 'instagram', recentPostCount: 5, freshness: 'stored' });
  }, [evidence]);
});
test('one-off collection polls status without repeating the charged start', async () => {
  const running = { schemaVersion: 'creator_account_collection_v1', status: 'running', id: receiptId, evidence: { partial: true } };
  const done = { ...running, status: 'complete', evidence: { averageViews: 100 } };
  await withApi(async (url, requests) => {
    const result = await run(['creator', 'collect', '@clubbradshaw', '--workspace-id', workspaceId, '--idempotency-key', 'same-key', '--max-credits', '1', '--wait', '--poll-interval', '1', '--api-base', url, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), done);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.action, 'start');
    assert.equal(requests[0].body.idempotencyKey, 'same-key');
    assert.equal(requests[0].body.maxCredits, 1);
    assert.deepEqual(requests[1].body, { workspaceId, recentPostCount: 5, action: 'status', id: receiptId });
  }, [running, done]);
});
test('failed collection returns useful evidence and a failing exit status', async () => {
  const failed = { schemaVersion: 'creator_account_collection_v1', id: receiptId, status: 'failed', error: { code: 'INSTAGRAM_ACCOUNT_UNAVAILABLE' }, evidence: { averageViews: 100 } };
  await withApi(async (url, requests) => {
    const result = await run(['creator', 'status', receiptId, '--workspace-id', workspaceId, '--wait', '--api-base', url, '--json']);
    assert.equal(result.code, 5);
    assert.deepEqual(JSON.parse(result.stdout), failed);
    assert.equal(requests.length, 1);
  }, [failed]);
});
test('creator collection requires explicit scope and budget; unsupported platform is precise', async () => {
  for (const args of [
    ['creator', 'collect', '@creator', '--workspace-id', workspaceId, '--idempotency-key', 'key'],
    ['creator', 'collect', '@creator', '--idempotency-key', 'key', '--max-credits', '1'],
    ['creator', 'recent-posts', '@creator', '--platform', 'tiktok', '--json'],
    ['creator', 'recent-posts', '@creator', '--count', '0', '--json'],
  ]) {
    const result = await run(args);
    assert.notEqual(result.code, 0);
  }
});
