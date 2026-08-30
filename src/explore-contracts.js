// Standalone copy of the channel-neutral Explore release contract.
// Keep this dependency-free so the published CLI works outside the monorepo.

export const EXPLORE_FEATURE_POLICY_VERSION = 'explore-feature-policy.v1';
export const EXPLORE_FEATURE_KEY = 'explore';
export const EXPLORE_MAX_PAGE_SIZE = 500;
export const EXPLORE_MAX_OVERVIEW_LIMIT = 100;

export const EXPLORE_SELECTION_DESTINATIONS = Object.freeze([
  'monitor',
  'study',
  'create',
  'find_creators',
  'seal',
  'deliverable_share',
]);
export const EXPLORE_HANDOFF_DESTINATIONS = Object.freeze([
  'home',
  ...EXPLORE_SELECTION_DESTINATIONS,
]);

export const EXPLORE_CHANNEL_ACTIONS = Object.freeze({
  start: Object.freeze({
    action: 'startLineage',
    required: Object.freeze(['workspaceId', 'anchor', 'marketCode', 'languageTag', 'previewFingerprint', 'idempotencyKey']),
    mutation: true,
  }),
  list: Object.freeze({ action: 'workspaceOverview', required: Object.freeze(['workspaceId']), mutation: false }),
  get: Object.freeze({ action: 'resource_read', required: Object.freeze(['workspaceId']), mutation: false }),
  refresh: Object.freeze({ action: 'refreshLineage', required: Object.freeze(['workspaceId', 'lineageId', 'idempotencyKey']), mutation: true }),
  correct: Object.freeze({
    action: 'applyInterpretationCorrection',
    required: Object.freeze(['workspaceId', 'lineageId', 'snapshotId', 'expectedRevisionId', 'labels', 'memberships', 'idempotencyKey']),
    mutation: true,
  }),
  select: Object.freeze({
    action: 'createSelection',
    required: Object.freeze(['workspaceId', 'lineageId', 'snapshotId', 'interpretationRevisionId', 'intendedDestination', 'intendedUse', 'items', 'idempotencyKey']),
    mutation: true,
  }),
  previewActivation: Object.freeze({ action: 'activationPreview', required: Object.freeze(['workspaceId', 'selectionId']), mutation: false }),
  activate: Object.freeze({ action: 'activateSearches', required: Object.freeze(['workspaceId', 'selectionId', 'planFingerprint', 'bindings', 'idempotencyKey']), mutation: true }),
  handoff: Object.freeze({ action: 'prepareHandoff', required: Object.freeze(['workspaceId', 'selectionId', 'destination', 'idempotencyKey']), mutation: true }),
  createDeliverable: Object.freeze({ action: 'createDeliverable', required: Object.freeze(['workspaceId', 'selectionId', 'idempotencyKey']), mutation: true }),
});

const POLICY_MODES = new Set(['off', 'allowlist', 'live']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function policyList(value, pattern = SAFE_ID, mapper = (item) => item) {
  if (value === undefined) return { values: [], valid: true };
  if (!Array.isArray(value)) return { values: [], valid: false };
  const values = value.map((item) => {
    if (typeof item !== 'string' || !pattern.test(item)) return null;
    return mapper(item);
  });
  return {
    values: [...new Set(values.filter(Boolean))].sort(),
    valid: values.every((item) => item !== null),
  };
}

function normaliseChannel(value) {
  if (value === 'app') return 'web';
  if (value === 'agent') return 'mcp';
  return ['web', 'mcp', 'cli', 'api', 'operator'].includes(value) ? value : null;
}

function normalisePolicyInput(value) {
  const disabled = {
    version: EXPLORE_FEATURE_POLICY_VERSION,
    key: EXPLORE_FEATURE_KEY,
    mode: 'off',
    enabled: false,
    killSwitch: false,
    allowedChannels: [],
    allowlistedWorkspaceIds: [],
    invalid: false,
  };
  let policy = value;
  if (typeof policy === 'string') {
    try {
      policy = JSON.parse(policy);
    } catch {
      return { ...disabled, invalid: true };
    }
  }
  const source = record(policy);
  if (!source) return disabled;

  const killSwitch = source.killSwitch === true || source.kill_switch === true;
  const requestedMode = typeof source.mode === 'string' ? source.mode.toLowerCase() : null;
  const workspaceList = policyList(source.allowlistedWorkspaceIds ?? source.allowlisted_workspace_ids);
  const channelList = policyList(
    source.allowedChannels ?? source.allowed_channels,
    /^[a-z]+$/u,
    normaliseChannel,
  );
  if (
    (source.enabled !== undefined && typeof source.enabled !== 'boolean') ||
    !workspaceList.valid ||
    !channelList.valid
  ) return { ...disabled, invalid: true };
  const workspaceIds = workspaceList.values;
  const channels = channelList.values;
  let mode = POLICY_MODES.has(requestedMode) ? requestedMode : null;
  if (requestedMode !== null && !mode) return { ...disabled, invalid: true };
  if (!mode) {
    mode = workspaceIds.length > 0 ? 'allowlist' : source.enabled === true ? 'live' : 'off';
  }
  if (source.enabled === false || killSwitch) mode = 'off';
  return {
    version: EXPLORE_FEATURE_POLICY_VERSION,
    key: EXPLORE_FEATURE_KEY,
    mode,
    enabled: mode !== 'off',
    killSwitch,
    allowedChannels: [...new Set(channels)].sort(),
    allowlistedWorkspaceIds: workspaceIds,
    invalid: false,
  };
}

export function evaluateExploreFeaturePolicy({ policy, channel, workspaceId } = {}) {
  const normalized = normalisePolicyInput(policy);
  const normalizedChannel = normaliseChannel(channel);
  const normalizedWorkspaceId = safeId(workspaceId);
  let allowed = true;
  let reason = 'enabled';

  if (normalized.invalid) {
    allowed = false;
    reason = 'invalid_policy';
  } else if (normalized.killSwitch || normalized.mode === 'off') {
    allowed = false;
    reason = normalized.killSwitch ? 'kill_switch' : 'disabled';
  } else if (!normalizedChannel) {
    allowed = false;
    reason = 'unsupported_channel';
  } else if (
    normalized.allowedChannels.length > 0 &&
    !normalized.allowedChannels.includes(normalizedChannel)
  ) {
    allowed = false;
    reason = 'channel_not_allowed';
  } else if (
    normalized.mode === 'allowlist' &&
    (!normalizedWorkspaceId || !normalized.allowlistedWorkspaceIds.includes(normalizedWorkspaceId))
  ) {
    allowed = false;
    reason = 'workspace_not_allowlisted';
  }

  return {
    version: EXPLORE_FEATURE_POLICY_VERSION,
    key: EXPLORE_FEATURE_KEY,
    allowed,
    reason,
    mode: normalized.mode,
    channel: normalizedChannel,
    workspaceId: normalizedWorkspaceId,
  };
}
