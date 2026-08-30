import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as standalone from '../src/explore-contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const canonicalPath = path.resolve(__dirname, '..', '..', 'packages', 'contracts', 'src', 'explore.mjs');
const canonicalAvailable = fs.existsSync(canonicalPath);

test('standalone Explore contract stays in parity with the monorepo contract', {
  skip: !canonicalAvailable,
}, async () => {
  const canonical = await import(pathToFileURL(canonicalPath).href);

  assert.deepEqual(standalone.EXPLORE_CHANNEL_ACTIONS, canonical.EXPLORE_CHANNEL_ACTIONS);
  assert.deepEqual(standalone.EXPLORE_HANDOFF_DESTINATIONS, canonical.EXPLORE_HANDOFF_DESTINATIONS);
  assert.equal(standalone.EXPLORE_MAX_PAGE_SIZE, canonical.EXPLORE_MAX_PAGE_SIZE);
  assert.equal(standalone.EXPLORE_MAX_OVERVIEW_LIMIT, canonical.EXPLORE_MAX_OVERVIEW_LIMIT);

  const policyCases = [
    {},
    { policy: { mode: 'off' }, channel: 'cli', workspaceId: 'workspace-1' },
    { policy: { mode: 'live', allowedChannels: ['cli'] }, channel: 'cli', workspaceId: 'workspace-1' },
    { policy: { mode: 'live', allowedChannels: ['app'] }, channel: 'cli', workspaceId: 'workspace-1' },
    { policy: { allowlistedWorkspaceIds: ['workspace-1'], allowedChannels: ['agent'] }, channel: 'cli', workspaceId: 'workspace-1' },
    { policy: { allowlistedWorkspaceIds: ['workspace-1'] }, channel: 'cli', workspaceId: 'workspace-2' },
    { policy: { mode: 'live', killSwitch: true }, channel: 'cli', workspaceId: 'workspace-1' },
    { policy: '{bad json', channel: 'cli', workspaceId: 'workspace-1' },
    { policy: { mode: 'live', allowedChannels: ['cli', 7] }, channel: 'cli', workspaceId: 'workspace-1' },
  ];
  for (const input of policyCases) {
    assert.deepEqual(
      standalone.evaluateExploreFeaturePolicy(input),
      canonical.evaluateExploreFeaturePolicy(input),
      JSON.stringify(input),
    );
  }
});
