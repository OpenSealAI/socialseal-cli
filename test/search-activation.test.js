import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same channel fixtures as OpenSealAI/socialseal/packages/contracts.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/search-activation.json', import.meta.url)));
const cli = process.env.SOCIALSEAL_TEST_CLI_PATH || fileURLToPath(new URL('../src/index.js', import.meta.url));
function run(base, body, fn = 'tracking') {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'tools', 'call', '--function', fn, '--body', JSON.stringify(body), '--workspace-id', fixtures.workspaceId, '--api-key', 'test', '--api-base', base, '--json'], { env: { ...process.env, SOCIALSEAL_CONFIG: '/tmp/socialseal-pr186-nonexistent-config.json' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('generic CLI preserves shared Topic fixtures, accepted commands, and typed outcomes', async () => {
  const requests = [];
  let result = { status: 'activated', itemIds: [42], commandId: 'receipt' };
  let status = 200;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: JSON.parse(raw), workspace: req.headers['x-workspace-id'] });
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const fixture of [fixtures.explicitCreate, fixtures.mixedBatch, fixtures.sharedNewTopic, fixtures.omittedAuto]) {
      const payload = { ...fixture, action: 'create', idempotencyKey: 'same-key' };
      const output = await run(base, payload);
      assert.equal(output.status, 0, output.stderr);
      const request = requests.at(-1);
      assert.equal(request.url, '/cli/tools/search-activation');
      assert.equal(request.body.idempotencyKey, 'same-key');
      assert.deepEqual(request.body.topicDefinitions, fixture.topicDefinitions);
      assert.deepEqual(request.body.items, fixture.items);
      assert.deepEqual(JSON.parse(output.stdout), result);
    }
    const command = { workspaceId: fixtures.workspaceId, topicDefinitions: fixtures.explicitCreate.topicDefinitions, searches: [{ searchRef: 's1', topicRefs: ['remote-work'] }] };
    result = { status: 'ready', command, planFingerprint: 'a'.repeat(64) };
    assert.equal((await run(base, { ...fixtures.omittedAuto, action: 'preview' })).status, 0);
    assert.equal(requests.at(-1).body.action, 'preview');
    result = { status: 'reused', itemIds: [42] };
    const executed = await run(base, { action: 'execute', command, planFingerprint: 'a'.repeat(64), idempotencyKey: 'preview-key' });
    assert.equal(executed.status, 0, executed.stderr);
    assert.deepEqual(requests.at(-1).body.command, command);
    assert.equal(requests.at(-1).body.planFingerprint, 'a'.repeat(64));
    assert.deepEqual(JSON.parse(executed.stdout), result);
    assert.equal((await run(base, { action: 'list_topics' })).status, 0);
    assert.equal(requests.at(-1).body.action, 'listTopics');
    assert.equal((await run(base, { ...fixtures.explicitCreate, action: 'group_add_items', groupId: 7 }, 'group-management')).status, 0);
    assert.equal(requests.at(-1).body.targetGroupId, 7);
    const before = requests.length;
    assert.notEqual((await run(base, { ...fixtures.explicitCreate, action: 'group_add_items', groupId: 7, itemIds: [9] }, 'group-management')).status, 0);
    assert.equal(requests.length, before);
    status = 409; result = { status: 'conflict', code: 'SEARCH_ACTIVATION_STALE_PREVIEW' };
    const conflict = await run(base, { action: 'execute', command, planFingerprint: 'a'.repeat(64), idempotencyKey: 'preview-key' });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr + conflict.stdout, /SEARCH_ACTIVATION_STALE_PREVIEW/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
