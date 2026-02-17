import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '..', 'src', 'index.js');

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
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
