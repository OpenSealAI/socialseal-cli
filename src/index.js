#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import WebSocket from 'ws';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'socialseal', 'config.json');
const DEFAULT_API_BASE = 'https://api.socialseal.co';
const CLI_KEY_HEADER = 'X-CLI-Key';
const WORKSPACE_HEADER = 'X-Workspace-Id';
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 300000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_STATUS_RESULTS_LIMIT = 10;
const DEFAULT_FRAME_COUNT = 3;
const MAX_TIMEOUT_MS = 900000;
const LEGACY_ENABLED = process.env.SOCIALSEAL_ENABLE_LEGACY === '1';
const CLI_VERSION = loadRuntimeVersion();
const STATIC_TOOL_REGISTRY_NOTE = 'This registry is shipped with the CLI for stable discovery. It is not live backend enumeration, so environment-specific availability can drift.';
const STATIC_TOOL_SCHEMA_NOTE = 'Schema hints are static CLI docs for discoverability. Backend contracts can still evolve.';
const EXIT_CODES = {
  OK: 0,
  UNKNOWN: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  SERVER: 5,
};
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ACTIVE_STATUS_VALUES = new Set(['queued', 'pending', 'processing', 'in_progress', 'running']);
const TOOL_STATUS_KINDS = new Set(['auto', 'agent_job', 'google_ai_run', 'journey_run']);
const REPORT_TYPE_SEARCH_RESULTS_ENRICHED = 'search_results_enriched';
const EXPORT_DATA_TEMPLATE_TRACKING_RANKED_VIDEOS_RAW = 'tracking_ranked_videos_raw';
const EXPORT_DATA_TEMPLATE_GOOGLE_AI_SEARCH_SUMMARIES_RAW = 'google_ai_search_summaries_raw';
const PLATFORM_ID_GOOGLE_AI = 11;
const SUPPORTED_EXPORT_REPORT_TYPES = [
  'keyword_universe',
  'cluster_insights',
  'creator_signatures',
  'post_publish',
  'quick_audit',
  REPORT_TYPE_SEARCH_RESULTS_ENRICHED,
];
const EXPORT_OPTIONS = [
  {
    id: 'tracking_csv',
    command: 'socialseal data export-tracking --group-id <id> --time-period <window>',
    summary: 'Legacy tracking CSV export for a group or tracking item.',
    formats: ['csv'],
    required: ['workspace id', '--group-id or --item-id', '--time-period'],
    bestFor: 'Quick tracking-table exports and backwards-compatible pipelines.',
  },
  {
    id: 'search_results_enriched',
    command: 'socialseal data export-search-results --group-ids <id,id,...>',
    summary: 'Enriched ranked search rows (search results + video + latest metrics + analysis).',
    formats: ['csv'],
    required: ['workspace id', '--group-ids'],
    bestFor: 'SQL-like ranked-search datasets without using psql.',
    alias: 'socialseal data export-report --report-type search_results_enriched --format csv --payload @payload.json',
  },
  {
    id: 'group_evidence',
    command: 'socialseal data export-group-evidence --group-id <id> --workspace-id <uuid>',
    summary: 'Unified group evidence export that routes social groups and Google AI groups to the right raw export template.',
    formats: ['csv'],
    required: ['workspace id', '--group-id'],
    bestFor: 'Automation that needs usable evidence without knowing whether the group is social ranked search or Google AI.',
  },
  {
    id: 'report_templates',
    command: 'socialseal data export-report --report-type <type> --format <format> --payload @payload.json',
    summary: 'Report-template exports via export-report.',
    formats: ['csv', 'json', 'markdown', 'html', 'excel_data'],
    required: ['payload JSON'],
    bestFor: 'Keyword universe, clusters, creators, post-publish timeline, and quick-audit exports.',
    reportTypes: SUPPORTED_EXPORT_REPORT_TYPES,
  },
];
const KNOWN_TOOLS = [
  {
    name: 'agent-tool-jobs',
    category: 'agent',
    description: 'Queue/poll agent-backed tool jobs.',
    objectType: 'agent_tool_job',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    actionAliases: ['start', 'status'],
    notes: 'Use action=start to queue and action=status to read a UUID job id.',
  },
  { name: 'deep-exploration-runs', category: 'agent', description: 'Read or persist deep exploration render runs.' },
  { name: 'workspace-notes', category: 'agent', description: 'Search, create, update, and pin workspace note memory.' },
  { name: 'workspace-onboarding', category: 'agent', description: 'Read or update workspace onboarding metadata used by the agent.' },
  {
    name: 'brand-group-management',
    category: 'brand',
    description: 'Manage brand groups, aliases, competitors, and rule configuration.',
    objectType: 'brand_group',
    transport: 'rest_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    actionAliases: ['list', 'create', 'update', 'delete', 'add_member', 'remove_member'],
    notes: 'Brand groups are not tracking groups.',
  },
  {
    name: 'enqueue-brand-metrics-backfill',
    category: 'brand',
    description: 'Queue backfill jobs for brand metrics refreshes.',
    objectType: 'brand_metrics_backfill_job',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    notes: 'Refreshes brand metrics for brands/workspaces. It does not refresh a tracking group by UUID.',
  },
  { name: 'export-report', category: 'export', description: 'Generate report exports (csv/json/markdown/html/excel_data).' },
  {
    name: 'export-data',
    category: 'export',
    description: 'Run raw workspace-scoped export templates with signed-URL artifacts.',
    objectType: 'workspace_export',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'disabled_by_default',
    notes: 'Includes template `tracking_ranked_videos_raw` for ranked search results with video + metrics + analysis enrichment.',
  },
  {
    name: 'export_tracking_data',
    category: 'export',
    description: 'Stream tracking exports as CSV for a group or tracking item.',
    objectType: 'tracking_export',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'disabled_by_default',
    notes: 'group_id expects a numeric tracking_group id, not a brand_group UUID. Always pass a workspace id or configure a default workspace so the export does not silently target the personal workspace.',
  },
  {
    name: 'tracked-video-extract',
    category: 'video',
    description: 'Resolve tracked videos/results into structured analysis plus reference assets.',
    objectType: 'tracked_video_extract',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    notes: 'Accepts videoId/videoUid/platformVideoId/searchResultId items; videoId means video_uid or platform-native video id, not a tracking item id.',
  },
  { name: 'douyin-geo-api', category: 'search', description: 'Query Douyin search and geo data.' },
  {
    name: 'google-ai-search',
    category: 'search',
    description: 'Queue Google AI search runs.',
    objectType: 'google_ai_run',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    notes: 'Returns numeric runId. Read status/results via get-google-ai-search-runs/get-google-ai-search-results or socialseal tools status <runId>.',
  },
  {
    name: 'get-google-ai-search-runs',
    category: 'search',
    description: 'Read Google AI run queue/progress by numeric run id.',
    objectType: 'google_ai_run',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    notes: 'Primary status endpoint for numeric Google AI run ids.',
  },
  {
    name: 'get-google-ai-search-results',
    category: 'search',
    description: 'Read Google AI summaries/citations by numeric run id.',
    objectType: 'google_ai_summary',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    notes: 'Use this after a run reaches succeeded/partial/failed to inspect summary-level output.',
  },
  { name: 'instagram-geo-api', category: 'search', description: 'Query Instagram search and geo data.' },
  { name: 'tiktok-geo-api', category: 'search', description: 'Query TikTok search and geo data.' },
  { name: 'xhs-geo-api', category: 'search', description: 'Query Xiaohongshu search and geo data.' },
  { name: 'youtube-geo-api', category: 'search', description: 'Query YouTube search and geo data.' },
  {
    name: 'group-management',
    category: 'tracking',
    description: 'Manage tracking groups and memberships.',
    objectType: 'tracking_group',
    transport: 'rest_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'disabled_by_default',
    actionAliases: ['list', 'get', 'create', 'update', 'delete', 'refresh', 'list_items', 'add_item', 'group_add_item', 'add_items', 'group_add_items', 'remove_item', 'group_remove_item'],
    notes: 'REST-style surface under /groups. `add_item`/`group_add_item` accepts an existing `item_id`; `add_items`/`group_add_items` accepts `item_ids` or item payloads for bulk membership adds. `completeness` checks expected memberships and refresh queue visibility. Always pass a workspace id or configure a default workspace so the backend does not fall back to the personal workspace.',
  },
  {
    name: 'tracking',
    category: 'tracking',
    description: 'Manage tracking items.',
    objectType: 'tracking_item',
    transport: 'rest_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    actionAliases: ['list', 'get', 'resolve', 'get_by_value', 'create', 'update', 'delete', 'refresh'],
    notes: 'REST-style surface. `resolve`/`get_by_value` uses the same workspace/platform/region duplicate-detection lookup as create and returns inactive matches too.',
  },
  { name: 'journey-feedback', category: 'vnext', description: 'Record acceptance or rejection feedback for opportunity bundles.' },
  { name: 'opportunity-bundle-approve', category: 'vnext', description: 'Approve an opportunity bundle and create tracking coverage.' },
  {
    name: 'search-journey-run',
    category: 'vnext',
    description: 'Run or poll a search journey for a subject across supported platforms.',
    objectType: 'search_journey_run',
    transport: 'post_edge_function',
    workspaceScoped: true,
    knownLocalDevState: 'enabled',
    notes: 'Async start returns runId; poll with action=status or socialseal tools status <runId> --kind journey_run --workspace-id <workspace-id>.',
  },
  { name: 'vnext-blueprints-create', category: 'vnext', description: 'Create a vNext blueprint from grounded evidence.' },
  { name: 'vnext-blueprints-generate', category: 'vnext', description: 'Generate a vNext blueprint from workspace opportunity data.' },
  { name: 'vnext-blueprints-read', category: 'vnext', description: 'Read vNext blueprint history and specific versions.' },
  { name: 'vnext-briefs-create', category: 'vnext', description: 'Create a vNext brief record.' },
  { name: 'vnext-briefs-generate', category: 'vnext', description: 'Generate a vNext brief from a blueprint or opportunity.' },
  { name: 'vnext-briefs-read', category: 'vnext', description: 'Read generated vNext briefs and version history.' },
  { name: 'vnext-intents', category: 'vnext', description: 'List, create, update, or delete vNext intents.' },
  { name: 'vnext-journeys', category: 'vnext', description: 'List journey runs and inspect their latest outputs.' },
  { name: 'vnext-keywords', category: 'vnext', description: 'List, create, update, or delete vNext keywords.' },
  { name: 'vnext-personas', category: 'vnext', description: 'List, create, update, retire, or reactivate vNext personas.' },
  { name: 'vnext-pillars', category: 'vnext', description: 'List, create, update, or delete vNext content pillars.' },
  { name: 'vnext-topics', category: 'vnext', description: 'Manage topics, assignments, queues, and topic suggestions.' },
  { name: 'vnext-topics-auto-tag', category: 'vnext', description: 'Auto-tag keyword and topic assignments with Gemini-assisted review.' },
];

const TOOL_SCHEMA_HINTS = {
  'agent-tool-jobs': {
    summary: 'Queue agent-backed jobs and read UUID job status.',
    operations: [
      {
        action: 'start',
        required: ['action=start', 'toolName', 'payload'],
        optional: [],
        example: {
          action: 'start',
          toolName: 'search_videos',
          payload: {
            query: 'best africa safari itinerary',
            platform: 'tiktok',
            region: 'IN',
            limit: 20,
          },
        },
      },
      {
        action: 'status',
        required: ['action=status', 'jobId (uuid)'],
        optional: [],
        example: {
          action: 'status',
          jobId: '11111111-1111-4111-8111-111111111111',
        },
      },
    ],
    cliExamples: [
      'socialseal tools call --function agent-tool-jobs --body \'{"action":"start","toolName":"search_videos","payload":{"query":"best africa safari itinerary","platform":"tiktok","region":"IN"}}\'',
      'socialseal tools status 11111111-1111-4111-8111-111111111111 --kind agent_job',
    ],
  },
  'search-journey-run': {
    summary: 'Start/poll journey keyword expansion runs.',
    operations: [
      {
        action: 'start',
        required: ['subject', 'subjectType', 'region', 'workspaceId'],
        optional: [
          'locale',
          'platformKeys',
          'seedKeywords',
          'contentPillars',
          'contentPillarIds',
          'maxKeywords',
          'maxKeywordsPerStage',
          'includeRejected',
          'skipCache',
          'executionMode',
        ],
        example: {
          subject: 'Como Hotels',
          subjectType: 'brand',
          region: 'IN',
          locale: 'en-IN',
          workspaceId: '00000000-0000-4000-8000-000000000000',
          executionMode: 'async',
        },
      },
      {
        action: 'status',
        required: ['action=status', 'workspaceId', 'runId (uuid)'],
        optional: [],
        example: {
          action: 'status',
          workspaceId: '00000000-0000-4000-8000-000000000000',
          runId: '11111111-1111-4111-8111-111111111111',
        },
      },
    ],
    cliExamples: [
      'socialseal tools call --function search-journey-run --body @journey.json --async --workspace-id <workspace-uuid>',
      'socialseal tools status 11111111-1111-4111-8111-111111111111 --kind journey_run --workspace-id <workspace-uuid>',
    ],
  },
  'google-ai-search': {
    summary: 'Queue Google AI runs (returns numeric runId).',
    operations: [
      {
        action: 'start',
        required: ['queries'],
        optional: [
          'workspaceId',
          'trackingItemId',
          'countryCode',
          'searchLanguage',
          'brandId',
          'competitorBrandIds',
          'brandDomains',
          'competitorDomains',
          'aiMode',
        ],
        notes: 'region is commonly used in workflows, but the canonical field is countryCode.',
        example: {
          queries: ['east africa itinerary', 'kenya tanzania itinerary'],
          countryCode: 'in',
          searchLanguage: 'en',
          workspaceId: '00000000-0000-4000-8000-000000000000',
        },
      },
    ],
    cliExamples: [
      'socialseal tools call --function google-ai-search --body @google-ai-search.json --workspace-id <workspace-uuid>',
      'socialseal tools status 6809 --kind google_ai_run',
    ],
  },
  'get-google-ai-search-runs': {
    summary: 'Read Google AI run status/progress.',
    operations: [
      {
        action: 'read',
        required: [],
        optional: ['runId', 'trackingItemId', 'limit', 'offset', 'skipCache'],
        example: {
          runId: 6809,
          limit: 1,
          offset: 0,
        },
      },
    ],
    cliExamples: [
      'socialseal tools call --function get-google-ai-search-runs --body \'{"runId":6809,"limit":1}\'',
      'socialseal tools status 6809 --kind google_ai_run',
    ],
  },
  'get-google-ai-search-results': {
    summary: 'Read Google AI summary/citation rows.',
    operations: [
      {
        action: 'read',
        required: [],
        optional: ['runId', 'query', 'trackingItemId', 'includeCitations', 'limit', 'offset', 'skipCache'],
        example: {
          runId: 6809,
          includeCitations: true,
          limit: 10,
          offset: 0,
        },
      },
    ],
    cliExamples: [
      'socialseal tools call --function get-google-ai-search-results --body \'{"runId":6809,"includeCitations":true,"limit":10}\'',
    ],
  },
  'group-management': {
    summary: 'Manage single-platform tracking groups and memberships.',
    operations: [
      {
        action: 'create',
        required: ['action=create', 'name', 'workspaceId or --workspace-id'],
        optional: [
          'platform (defaults to tiktok)',
          'description',
          'refresh_frequency',
          'next_refresh_at',
          'brand_id',
        ],
        notes: 'Supported platform values: tiktok, instagram, youtube, ig_reels, yt_shorts, douyin, xhs, google_ai.',
        example: {
          action: 'create',
          name: 'YouTube competitor searches',
          platform: 'youtube',
        },
      },
      {
        action: 'add_items',
        required: ['action=add_items', 'group_id', 'workspaceId or --workspace-id'],
        optional: ['item_ids', 'items', 'platform/groupPlatform for item payload defaults'],
        notes: 'When adding item payloads, omit item platform to inherit the group platform, or pass platform explicitly.',
        example: {
          action: 'add_items',
          group_id: 123,
          items: [
            {
              name: 'best kenya safari',
              type: 'keyword',
              value: 'best kenya safari',
              region: 'US',
            },
          ],
        },
      },
      {
        action: 'completeness',
        required: ['action=completeness', 'group_id', 'items or expected_items', 'workspaceId or --workspace-id'],
        optional: ['include_refresh_status'],
        notes: 'Returns durable setup completeness and aggregate refresh queue status for the group.',
        example: {
          action: 'completeness',
          group_id: 123,
          expected_items: [
            {
              track_type: 'search',
              track_value: 'best kenya safari',
              region: 'US',
            },
          ],
        },
      },
    ],
    cliExamples: [
      'socialseal tools call --function group-management --workspace-id <workspace-uuid> --body \'{"action":"create","name":"YouTube group","platform":"youtube"}\'',
      'socialseal tools call --function group-management --workspace-id <workspace-uuid> --body \'{"action":"create","name":"Instagram group","platform":"instagram"}\'',
      'socialseal tools call --function group-management --workspace-id <workspace-uuid> --body \'{"action":"add_items","group_id":123,"items":[{"name":"best kenya safari","type":"keyword","value":"best kenya safari","region":"US"}]}\'',
    ],
  },
};

function getToolSchemaHint(functionName) {
  if (!functionName) return null;
  return TOOL_SCHEMA_HINTS[functionName] || null;
}

function getKnownTool(functionName) {
  return KNOWN_TOOLS.find((tool) => tool.name === functionName) || null;
}

function buildSchemaAvailabilitySummary(schema) {
  const firstOperation = Array.isArray(schema?.operations) ? schema.operations[0] : null;
  if (!firstOperation || !Array.isArray(firstOperation.required) || firstOperation.required.length === 0) {
    return 'optional body fields vary by read filter';
  }
  return `required: ${firstOperation.required.join(', ')}`;
}

function buildToolRegistry() {
  return KNOWN_TOOLS.map((tool) => {
    const schema = getToolSchemaHint(tool.name);
    if (!schema) return tool;
    return {
      ...tool,
      schemaAvailable: true,
      schemaSummary: buildSchemaAvailabilitySummary(schema),
    };
  });
}

function getConfigPath() {
  return process.env.SOCIALSEAL_CONFIG || DEFAULT_CONFIG_PATH;
}

function loadRuntimeVersion() {
  const envVersion = typeof process.env.npm_package_version === 'string'
    ? process.env.npm_package_version.trim()
    : '';
  if (envVersion) return envVersion;

  try {
    const packageJsonPath = new URL('../package.json', import.meta.url);
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // fall through to the safe fallback below
  }

  return '0.0.0';
}

function loadConfig() {
  const configPath = getConfigPath();
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[socialseal] Failed to read config:', err.message || err);
    return {};
  }
}

function saveConfig(config) {
  const configPath = getConfigPath();
  const normalizedConfig = Object.fromEntries(
    Object.entries(config || {}).filter(([, value]) => value !== undefined),
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(normalizedConfig, null, 2)}\n`);
}

function resolveApiKey(opts, config) {
  return opts.apiKey || process.env.SOCIALSEAL_API_KEY || config.apiKey;
}

function resolveApiBase(opts, config) {
  return opts.apiBase || process.env.SOCIALSEAL_API_BASE || config.apiBase || null;
}

function resolveAgentUrl(opts, config) {
  return opts.agentUrl || process.env.SOCIALSEAL_AGENT_URL || config.agentUrl;
}

function resolveSupabaseUrl(opts, config) {
  return opts.supabaseUrl || process.env.SOCIALSEAL_SUPABASE_URL || config.supabaseUrl;
}

function resolveWorkspaceSelection(opts, config) {
  if (typeof opts.workspaceId === 'string' && opts.workspaceId.trim().length > 0) {
    return { workspaceId: opts.workspaceId.trim(), source: 'flag' };
  }
  if (typeof process.env.SOCIALSEAL_WORKSPACE_ID === 'string' && process.env.SOCIALSEAL_WORKSPACE_ID.trim().length > 0) {
    return { workspaceId: process.env.SOCIALSEAL_WORKSPACE_ID.trim(), source: 'env' };
  }
  if (typeof config.workspaceId === 'string' && config.workspaceId.trim().length > 0) {
    return { workspaceId: config.workspaceId.trim(), source: 'config' };
  }
  return { workspaceId: null, source: null };
}

class CliError extends Error {
  constructor(message, { code = 'CLI_ERROR', exitCode = EXIT_CODES.UNKNOWN, status, hint, details } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.status = status;
    this.hint = hint;
    this.details = details;
  }
}

function normalizeMethod(method) {
  const normalized = String(method || 'POST').trim().toUpperCase();
  if (!HTTP_METHODS.has(normalized)) {
    throw new CliError(`Unsupported HTTP method: ${method}`, {
      code: 'INVALID_METHOD',
      exitCode: EXIT_CODES.USAGE,
      hint: `Use one of: ${Array.from(HTTP_METHODS).join(', ')}.`,
    });
  }
  return normalized;
}

function parseTimeoutMs(raw, { defaultValue = DEFAULT_TIMEOUT_MS, label = 'timeout' } = {}) {
  if (raw == null || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`Invalid ${label} value. Use a positive number of milliseconds.`, {
      code: 'INVALID_TIMEOUT',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

function resolveTimeoutMs(opts, config) {
  const raw = opts.timeout ?? process.env.SOCIALSEAL_TIMEOUT_MS ?? config.timeoutMs;
  return parseTimeoutMs(raw, { defaultValue: DEFAULT_TIMEOUT_MS, label: 'timeout' });
}

function resolveAgentIdleTimeoutMs(opts, config, fallbackTimeoutMs) {
  const explicitIdleTimeout =
    opts.idleTimeout
    ?? process.env.SOCIALSEAL_AGENT_IDLE_TIMEOUT_MS
    ?? config.agentIdleTimeoutMs;
  if (explicitIdleTimeout != null && explicitIdleTimeout !== '') {
    return parseTimeoutMs(explicitIdleTimeout, {
      defaultValue: DEFAULT_AGENT_IDLE_TIMEOUT_MS,
      label: 'idle timeout',
    });
  }

  const explicitTimeout = opts.timeout ?? process.env.SOCIALSEAL_TIMEOUT_MS ?? config.timeoutMs;
  if (explicitTimeout != null && explicitTimeout !== '') {
    return fallbackTimeoutMs;
  }

  return DEFAULT_AGENT_IDLE_TIMEOUT_MS;
}

function resolveLegacyUrl(value, label) {
  if (!value) return null;
  if (!LEGACY_ENABLED) {
    throw new CliError(`Legacy URL override (${label}) is disabled.`, {
      code: 'LEGACY_DISABLED',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Remove the legacy URL or set SOCIALSEAL_ENABLE_LEGACY=1.',
    });
  }
  return value;
}

function emitInfo(opts, message) {
  if (opts?.verbose) {
    process.stderr.write(`[socialseal] ${message}\n`);
  }
}

function formatCloseReason(reason) {
  if (reason == null) return '';
  if (Buffer.isBuffer(reason)) return reason.toString('utf8');
  if (typeof reason === 'string') return reason;
  return String(reason);
}

async function readNodeResponseBody(response, limit = 2000) {
  if (!response) return null;

  return await new Promise((resolve) => {
    const chunks = [];
    let bufferedBytes = 0;
    let totalBytes = 0;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    response.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buffer.length;
      if (bufferedBytes >= limit) return;

      const remaining = limit - bufferedBytes;
      const slice = buffer.subarray(0, remaining);
      chunks.push(slice);
      bufferedBytes += slice.length;
    });
    response.on('end', () => {
      const text = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '';
      finish(totalBytes > limit ? `${text}…` : text);
    });
    response.on('error', () => finish(null));
  });
}

function parseJsonInput(value, { label = 'payload', allowString = false } = {}) {
  if (!value) return null;
  if (value.startsWith('@')) {
    const filePath = value.slice(1);
    if (!fs.existsSync(filePath)) {
      throw new CliError(`File not found: ${filePath}`, {
        code: 'FILE_NOT_FOUND',
        exitCode: EXIT_CODES.USAGE,
        hint: `Use --${label} @path.json or --${label} '{"key":"value"}'.`,
      });
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new CliError(`Invalid JSON in ${filePath}`, {
        code: 'INVALID_JSON',
        exitCode: EXIT_CODES.USAGE,
        hint: `Fix ${filePath} or pass --${label} with valid JSON.`,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    if (allowString) return value;
    throw new CliError(`Invalid ${label} JSON`, {
      code: 'INVALID_JSON',
      exitCode: EXIT_CODES.USAGE,
      hint: `Use --${label} @path.json or --${label} '{"key":"value"}'.`,
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

function ensureJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`Invalid ${label}: expected a JSON object`, {
      code: 'INVALID_PAYLOAD',
      exitCode: EXIT_CODES.USAGE,
      hint: `Use --${label} '{"key":"value"}' or --${label} @payload.json.`,
    });
  }
  return value;
}

function mergeWorkspaceIdIntoPayload(payload, workspaceId) {
  if (!workspaceId) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  if (typeof payload.workspaceId === 'string' && payload.workspaceId.trim().length > 0) {
    return payload;
  }
  return { ...payload, workspaceId };
}

function sanitizeFileComponent(value, fallback = 'item') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function inferExtension(urlValue, contentType, fallback = '.bin') {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('jpeg')) return '.jpg';
  if (normalizedType.includes('png')) return '.png';
  if (normalizedType.includes('webp')) return '.webp';
  if (normalizedType.includes('gif')) return '.gif';
  if (normalizedType.includes('mp4')) return '.mp4';
  if (normalizedType.includes('quicktime')) return '.mov';

  try {
    const pathname = new URL(urlValue).pathname || '';
    const ext = path.extname(pathname);
    if (ext) return ext;
  } catch {
    // ignore parse failures
  }
  return fallback;
}

function normalizeVideoExtractBody(body) {
  const normalized = { ...body };
  const hasInlineIdentifier =
    normalized.videoId !== undefined ||
    normalized.searchResultId !== undefined ||
    normalized.videoUid !== undefined ||
    normalized.platformVideoId !== undefined;

  if (!Array.isArray(normalized.items) && hasInlineIdentifier) {
    normalized.items = [{
      videoId: normalized.videoId,
      searchResultId: normalized.searchResultId,
      videoUid: normalized.videoUid,
      platformVideoId: normalized.platformVideoId,
      platformId: normalized.platformId,
    }];
    delete normalized.videoId;
    delete normalized.searchResultId;
    delete normalized.videoUid;
    delete normalized.platformVideoId;
    delete normalized.platformId;
  }

  return normalized;
}

function buildVideoExtractBody(opts, workspaceId) {
  const parsed = opts.body
    ? ensureJsonObject(parseJsonInput(opts.body, { label: 'body' }), 'body')
    : {};
  const normalized = normalizeVideoExtractBody(parsed);

  if (!Array.isArray(normalized.items) || normalized.items.length === 0) {
    const inlineItem = stripUndefinedEntries({
      videoId: trimString(opts.videoId) || undefined,
      searchResultId: opts.searchResultId !== undefined
        ? coercePositiveInteger(opts.searchResultId, 'searchResultId')
        : undefined,
      videoUid: trimString(opts.videoUid) || undefined,
      platformVideoId: trimString(opts.platformVideoId) || undefined,
    });

    if (Object.keys(inlineItem).length === 0) {
      throw new CliError('Provide --body or one of --video-id, --video-uid, --platform-video-id, or --search-result-id.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
        hint: '--video-id accepts a video_uid or platform video id. It does not accept tracking item ids.',
      });
    }

    normalized.items = [inlineItem];
  }

  const bodyWithWorkspace = mergeWorkspaceIdIntoPayload(normalized, workspaceId);
  if (!bodyWithWorkspace.workspaceId) {
    throw new CliError('tracked-video extraction requires a workspace id.', {
      code: 'WORKSPACE_REQUIRED',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace.',
    });
  }

  const nextBody = { ...bodyWithWorkspace };
  if (opts.wait) {
    nextBody.ensureAnalysis = true;
  } else if (opts.ensureAnalysis === true) {
    nextBody.ensureAnalysis = true;
  } else if (nextBody.ensureAnalysis === undefined) {
    nextBody.ensureAnalysis = false;
  }

  if (opts.skipAssets === true) {
    nextBody.includeAssets = false;
  } else if (nextBody.includeAssets === undefined) {
    nextBody.includeAssets = true;
  }

  if (opts.includeSourceVideo === true) {
    nextBody.includeSourceVideo = true;
  } else if (nextBody.includeSourceVideo === undefined) {
    nextBody.includeSourceVideo = false;
  }

  if (opts.frameStrategy && nextBody.frameStrategy === undefined) {
    nextBody.frameStrategy = opts.frameStrategy;
  }
  if (nextBody.frameStrategy === undefined) {
    nextBody.frameStrategy = 'brief_shots';
  }

  if (nextBody.frameCount === undefined) {
    nextBody.frameCount = opts.frameCount !== undefined
      ? Number(opts.frameCount)
      : DEFAULT_FRAME_COUNT;
  }

  if (nextBody.signedUrlSeconds === undefined) {
    nextBody.signedUrlSeconds = opts.signedUrlSeconds !== undefined
      ? Number(opts.signedUrlSeconds)
      : 3600;
  }

  return nextBody;
}

function buildVideoQueueBody(opts, workspaceId) {
  const body = buildVideoExtractBody(opts, workspaceId);
  return {
    ...body,
    ensureAnalysis: true,
    queueOnly: true,
    includeAssets: false,
    includeRawAnalysis: false,
    includeSourceVideo: false,
  };
}

function hasPendingVideoExtractResults(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.some((result) => {
    const status = String(result?.analysis?.status || '').trim().toLowerCase();
    return status === 'pending' || status === 'processing';
  });
}

async function downloadAssetToFile({ url, outDir, stem, timeoutMs }) {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: '*/*' },
  }, timeoutMs);

  if (!response.ok) {
    throw new CliError(`Asset download failed: ${response.status}`, {
      code: 'ASSET_DOWNLOAD_FAILED',
      exitCode: EXIT_CODES.SERVER,
      details: await response.text().catch(() => null),
    });
  }

  const extension = inferExtension(url, response.headers.get('content-type'));
  const absolutePath = path.resolve(outDir, `${stem}${extension}`);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(absolutePath, buffer);
  return {
    path: absolutePath,
    bytes: buffer.length,
  };
}

async function downloadVideoExtractAssets(payload, outDir, timeoutMs) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const absoluteBaseDir = path.resolve(outDir);
  fs.mkdirSync(absoluteBaseDir, { recursive: true });

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const resolved = result?.resolved || {};
    const videoKey = sanitizeFileComponent(
      resolved.videoUid || resolved.platformVideoId || resolved.searchResultId || `item-${index + 1}`,
      `item-${index + 1}`,
    );
    const itemDir = path.join(absoluteBaseDir, `${String(index + 1).padStart(2, '0')}-${videoKey}`);
    const downloads = {
      directory: itemDir,
      thumbnail: null,
      sourceVideo: null,
      frames: [],
    };

    const thumbnailUrl = result?.assets?.thumbnail?.url;
    if (typeof thumbnailUrl === 'string' && thumbnailUrl.length > 0) {
      try {
        downloads.thumbnail = await downloadAssetToFile({
          url: thumbnailUrl,
          outDir: itemDir,
          stem: 'thumbnail',
          timeoutMs,
        });
      } catch (error) {
        downloads.thumbnail = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const sourceVideoUrl = result?.assets?.sourceVideo?.signedUrl;
    if (typeof sourceVideoUrl === 'string' && sourceVideoUrl.length > 0) {
      try {
        downloads.sourceVideo = await downloadAssetToFile({
          url: sourceVideoUrl,
          outDir: itemDir,
          stem: 'source-video',
          timeoutMs,
        });
      } catch (error) {
        downloads.sourceVideo = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const frames = Array.isArray(result?.assets?.frames) ? result.assets.frames : [];
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      const frameUrl = frame?.signedUrl;
      if (typeof frameUrl !== 'string' || frameUrl.length === 0) continue;
      const timestampToken = sanitizeFileComponent(frame?.timestamp || `frame-${frameIndex + 1}`, `frame-${frameIndex + 1}`);
      try {
        const download = await downloadAssetToFile({
          url: frameUrl,
          outDir: itemDir,
          stem: `${frame?.kind || 'frame'}-${String(frameIndex + 1).padStart(2, '0')}-${timestampToken}`,
          timeoutMs,
        });
        downloads.frames.push({
          kind: frame?.kind || null,
          timestamp: frame?.timestamp || null,
          path: download.path,
          bytes: download.bytes,
        });
      } catch (error) {
        downloads.frames.push({
          kind: frame?.kind || null,
          timestamp: frame?.timestamp || null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.downloads = downloads;
  }

  return {
    ...payload,
    downloadsRoot: absoluteBaseDir,
    results,
  };
}

function hasOwn(value, key) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function firstDefined(source, keys) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  for (const key of keys) {
    if (hasOwn(source, key) && source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }
  return undefined;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripUndefinedEntries(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== undefined),
  );
}

function resolvePayloadWorkspaceId(payload, fallbackWorkspaceId) {
  const workspaceId = firstDefined(payload, ['workspace_id', 'workspaceId']);
  if (typeof workspaceId === 'string' && workspaceId.trim().length > 0) {
    return workspaceId.trim();
  }
  return fallbackWorkspaceId || null;
}

function isUuidLike(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.trim());
}

function isPositiveIntegerString(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value.trim());
}

function normalizeStatusIdentifier(rawId) {
  const id = trimString(rawId);
  if (!id) {
    throw new CliError('Missing status identifier.', {
      code: 'MISSING_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Pass a numeric Google AI runId or a UUID job/run id.',
    });
  }

  if (isPositiveIntegerString(id)) {
    const parsed = Number(id);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return { rawId: id, numericId: parsed, uuidId: null };
    }
  }

  if (isUuidLike(id)) {
    return { rawId: id, numericId: null, uuidId: id };
  }

  throw new CliError(`Unsupported status identifier: ${id}`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Use a numeric Google AI runId (for example 6809) or UUID job/run id.',
  });
}

function parseToolStatusKind(rawKind) {
  const normalized = trimString(rawKind || 'auto').toLowerCase();
  if (TOOL_STATUS_KINDS.has(normalized)) {
    return normalized;
  }
  throw new CliError(`Unsupported tools status kind: ${rawKind}`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Use --kind auto|agent_job|google_ai_run|journey_run.',
  });
}

function normalizeStatusValue(value) {
  return trimString(value).toLowerCase();
}

function isTerminalStatusValue(value) {
  const normalized = normalizeStatusValue(value);
  if (!normalized) return true;
  return !ACTIVE_STATUS_VALUES.has(normalized);
}

function isFailedStatusValue(value) {
  const normalized = normalizeStatusValue(value);
  return normalized === 'failed' || normalized === 'error';
}

function coercePositiveInteger(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new CliError(`Invalid ${label}: expected a positive integer.`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: isUuidLike(value)
      ? `${label} expects a numeric tracking id. Brand-group ids are UUIDs and use brand-group-management instead.`
      : null,
    details: value,
  });
}

function normalizePositiveIntegerList(value, label, { max } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const entries = Array.isArray(value)
    ? value
    : String(value)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  const parsed = entries.map((entry, index) => {
    const normalized = coercePositiveInteger(entry, `${label}[${index}]`);
    if (!normalized) {
      throw new CliError(`Invalid ${label}[${index}] value.`, {
        code: 'INVALID_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return normalized;
  });
  const deduped = Array.from(new Set(parsed));
  if (max && deduped.length > max) {
    throw new CliError(`Too many ${label} values: received ${deduped.length}, max is ${max}.`, {
      code: 'INVALID_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return deduped;
}

function normalizeIsoDateTime(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new CliError(`Invalid ${label}: expected an ISO datetime string.`, {
      code: 'INVALID_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  const trimmed = value.trim();
  const epoch = Date.parse(trimmed);
  if (Number.isNaN(epoch)) {
    throw new CliError(`Invalid ${label}: expected an ISO datetime string.`, {
      code: 'INVALID_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
      details: value,
    });
  }
  return new Date(epoch).toISOString();
}

function buildSearchResultsEnrichedExportPayload(rawPayload, workspaceId) {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const groupIds = normalizePositiveIntegerList(
    firstDefined(payload, ['groupIds', 'group_ids']),
    'groupIds',
    { max: 100 },
  );
  if (groupIds.length === 0) {
    throw new CliError('search_results_enriched export requires at least one group id.', {
      code: 'MISSING_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Provide --group-ids for `data export-search-results`, or include groupIds in --payload for `data export-report`.',
    });
  }

  const trackingItemIds = normalizePositiveIntegerList(
    firstDefined(payload, ['trackingItemIds', 'tracking_item_ids']),
    'trackingItemIds',
    { max: 1000 },
  );
  const dateFrom = normalizeIsoDateTime(firstDefined(payload, ['dateFrom', 'date_from']), 'dateFrom');
  const dateTo = normalizeIsoDateTime(firstDefined(payload, ['dateTo', 'date_to']), 'dateTo');
  const filename = trimString(firstDefined(payload, ['filename'])) || undefined;

  return stripUndefinedEntries({
    workspaceId,
    groupIds,
    trackingItemIds: trackingItemIds.length > 0 ? trackingItemIds : undefined,
    dateFrom,
    dateTo,
    filename,
  });
}

function buildGoogleAiSearchSummariesExportPayload(rawPayload, workspaceId) {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const groupId = coercePositiveInteger(firstDefined(payload, ['groupId', 'group_id']), 'groupId');
  if (!groupId) {
    throw new CliError('Google AI evidence export requires a group id.', {
      code: 'MISSING_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Provide --group-id or groupId in the payload.',
    });
  }

  const trackingItemIds = normalizePositiveIntegerList(
    firstDefined(payload, ['trackingItemIds', 'tracking_item_ids']),
    'trackingItemIds',
    { max: 1000 },
  );
  const filename = trimString(firstDefined(payload, ['filename'])) || undefined;

  return stripUndefinedEntries({
    workspaceId,
    groupId,
    trackingItemIds: trackingItemIds.length > 0 ? trackingItemIds : undefined,
    filename,
  });
}

function normalizeEvidenceSurface(value) {
  const normalized = trimString(value || 'auto').toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
  if (['auto', 'social', 'ranked', 'ranked_search', 'google_ai', 'google'].includes(normalized)) {
    if (normalized === 'ranked' || normalized === 'ranked_search') return 'social';
    if (normalized === 'google') return 'google_ai';
    return normalized;
  }
  throw new CliError(`Unsupported evidence surface: ${value}`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Use --surface auto|social|google_ai.',
  });
}

function normalizePlatformKey(value) {
  const normalized = trimString(value).toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
  if (!normalized) return null;
  if (['google', 'google_ai', 'google_ai_overview', 'ai_search'].includes(normalized)) return 'google_ai';
  return normalized;
}

function resolveEvidenceSurfaceFromGroup(group) {
  if (!isJsonObject(group)) return 'social';
  const platformId = firstDefined(group, ['platform_id', 'platformId']);
  if (Number(platformId) === PLATFORM_ID_GOOGLE_AI) return 'google_ai';
  const platform = normalizePlatformKey(firstDefined(group, ['platform', 'platform_key', 'platformKey']));
  return platform === 'google_ai' ? 'google_ai' : 'social';
}

function buildGroupEvidenceMetadata({ surface, groupId, workspaceId, responseJson }) {
  const metadata = isJsonObject(responseJson) && isJsonObject(responseJson.metadata)
    ? responseJson.metadata
    : {};
  const rowCount = Number.isFinite(metadata.row_count) ? metadata.row_count : null;
  return {
    group_id: groupId,
    workspace_id: workspaceId,
    platform: surface === 'google_ai' ? 'google_ai' : 'social',
    surface,
    row_count: rowCount,
    generated_at: new Date().toISOString(),
    header_only: rowCount === 0,
    template: metadata.template ?? (surface === 'google_ai'
      ? EXPORT_DATA_TEMPLATE_GOOGLE_AI_SEARCH_SUMMARIES_RAW
      : EXPORT_DATA_TEMPLATE_TRACKING_RANKED_VIDEOS_RAW),
  };
}

function normalizeCompletenessPlatform(rawItem) {
  const platformId = firstDefined(rawItem, ['platform_id', 'platformId']);
  if (Number.isFinite(Number(platformId))) return `id:${Number(platformId)}`;
  const platform = normalizePlatformKey(firstDefined(rawItem, ['platform', 'platform_key', 'platformKey']));
  return platform ? `key:${platform}` : '';
}

function normalizeCompletenessItem(rawItem, index, source) {
  if (!isJsonObject(rawItem)) {
    throw new CliError(`Invalid ${source} item at index ${index}: expected an object.`, {
      code: 'INVALID_MANIFEST',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const id = coercePositiveInteger(firstDefined(rawItem, ['item_id', 'itemId', 'id']), `${source}[${index}].item_id`);
  const rawValue = firstDefined(rawItem, ['track_value', 'trackValue', 'value', 'name']);
  const value = trimString(rawValue).toLowerCase();
  const rawType = firstDefined(rawItem, ['track_type', 'trackType', 'type']);
  const type = normalizeTrackingType(rawType) || trimString(rawType).toLowerCase() || '';
  const region = trimString(firstDefined(rawItem, ['region'])).toUpperCase();
  const platform = normalizeCompletenessPlatform(rawItem);
  const hasSemanticKey = Boolean(value && type);
  const key = hasSemanticKey ? `${type}|${value}|${region}|${platform}` : `id:${id}`;
  const looseKey = hasSemanticKey ? `${type}|${value}|${region}` : `id:${id}`;

  if (!id && (!value || !type)) {
    throw new CliError(`Invalid ${source} item at index ${index}: expected item_id or track_type + track_value.`, {
      code: 'INVALID_MANIFEST',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  return {
    key,
    looseKey,
    item_id: id ?? null,
    track_type: type || null,
    track_value: value || null,
    region: region || null,
    platform: platform || null,
    raw: rawItem,
  };
}

function extractExpectedManifestItems(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (!isJsonObject(manifest)) {
    throw new CliError('Invalid completeness manifest: expected an array or object with items.', {
      code: 'INVALID_MANIFEST',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  const items = firstDefined(manifest, ['items', 'expectedItems', 'expected_items']);
  if (!Array.isArray(items)) {
    throw new CliError('Invalid completeness manifest: expected items, expectedItems, or expected_items array.', {
      code: 'INVALID_MANIFEST',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return items;
}

function normalizeActualGroupItem(rawItem, index) {
  const tracking = isJsonObject(rawItem?.user_tracking) ? rawItem.user_tracking : rawItem;
  return normalizeCompletenessItem(tracking, index, 'actual_items');
}

function buildCompletenessDiff({ expectedItems, actualItems, groupId, workspaceId }) {
  const expected = expectedItems.map((item, index) =>
    normalizeCompletenessItem(item, index, 'expected_items')
  );
  const actual = actualItems.map((item, index) => normalizeActualGroupItem(item, index));
  const actualByKey = new Map(actual.map((item) => [item.key, item]));
  const expectedByKey = new Map(expected.map((item) => [item.key, item]));
  const actualByLooseKey = new Map(actual.map((item) => [item.looseKey, item]));
  const expectedByLooseKey = new Map(expected.map((item) => [item.looseKey, item]));

  const missing = [];
  const platformMismatches = [];
  for (const expectedItem of expected) {
    if (actualByKey.has(expectedItem.key)) continue;
    const looseMatch = actualByLooseKey.get(expectedItem.looseKey);
    if (looseMatch && expectedItem.platform !== looseMatch.platform) {
      platformMismatches.push({
        expected: expectedItem.raw,
        actual: looseMatch.raw,
        expected_platform: expectedItem.platform,
        actual_platform: looseMatch.platform,
      });
      continue;
    }
    missing.push(expectedItem.raw);
  }

  const extra = [];
  for (const actualItem of actual) {
    if (expectedByKey.has(actualItem.key)) continue;
    const looseMatch = expectedByLooseKey.get(actualItem.looseKey);
    if (looseMatch && looseMatch.platform !== actualItem.platform) continue;
    extra.push(actualItem.raw);
  }

  const complete = missing.length === 0 && extra.length === 0 && platformMismatches.length === 0;
  return {
    success: complete,
    complete,
    group_id: groupId,
    workspace_id: workspaceId,
    expected_count: expected.length,
    actual_count: actual.length,
    missing_count: missing.length,
    extra_count: extra.length,
    platform_mismatch_count: platformMismatches.length,
    missing,
    extra,
    platform_mismatches: platformMismatches,
  };
}

function buildPathWithQuery(basePath, query) {
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query || {})) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    if (Array.isArray(rawValue)) {
      for (const entry of rawValue) {
        if (entry !== undefined && entry !== null && entry !== '') {
          params.append(key, String(entry));
        }
      }
      continue;
    }
    params.set(key, String(rawValue));
  }
  const queryString = params.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

function normalizeTrackingType(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'keyword' || normalized === 'search') return 'search';
  if (normalized === 'account' || normalized === 'creator') return 'creator';
  if (normalized === 'hashtag') return 'hashtag';
  throw new CliError(`Invalid tracking type: ${value}`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Use keyword/search, hashtag, or account/creator.',
  });
}

function normalizeTrackingPayload(payload, fallbackWorkspaceId) {
  const trackValue = firstDefined(payload, ['track_value', 'trackValue', 'value']);
  const refreshFrequency = firstDefined(payload, ['refresh_frequency', 'refreshFrequency']);
  const nextRefreshAt = firstDefined(payload, ['next_refresh_at', 'nextRefreshAt']);
  const region = firstDefined(payload, ['region']);
  const platform = firstDefined(payload, ['platform']);
  const brandIds = firstDefined(payload, ['brand_ids', 'brandIds']);
  const includeInactive = firstDefined(payload, ['includeInactive', 'include_inactive']);
  const isActive = firstDefined(payload, ['is_active', 'isActive']);
  const limit = firstDefined(payload, ['limit']);
  const page = firstDefined(payload, ['page']);
  const offset = firstDefined(payload, ['offset']);
  const itemId = firstDefined(payload, ['item_id', 'itemId', 'id']);

  return stripUndefinedEntries({
    action: trimString(firstDefined(payload, ['action'])) || undefined,
    workspaceId: resolvePayloadWorkspaceId(payload, fallbackWorkspaceId),
    item_id: coercePositiveInteger(itemId, 'item_id'),
    name: trimString(firstDefined(payload, ['name'])) || (trimString(trackValue) || undefined),
    track_type: normalizeTrackingType(firstDefined(payload, ['track_type', 'trackType', 'type'])),
    track_value: trimString(trackValue) || undefined,
    refresh_frequency: trimString(refreshFrequency) || undefined,
    next_refresh_at: nextRefreshAt ?? undefined,
    region: typeof region === 'string' ? region.trim() || undefined : region,
    platform: trimString(platform) || undefined,
    brand_ids: Array.isArray(brandIds) ? brandIds : undefined,
    limit: limit !== undefined ? Number(limit) : undefined,
    page: page !== undefined ? Number(page) : undefined,
    offset: offset !== undefined ? Number(offset) : undefined,
    is_active: typeof isActive === 'boolean' ? isActive : undefined,
    include_inactive: typeof includeInactive === 'boolean' ? includeInactive : undefined,
  });
}

function normalizeGroupManagementPayload(payload, fallbackWorkspaceId) {
  const groupId = firstDefined(payload, ['group_id', 'groupId', 'id']);
  const itemId = firstDefined(payload, ['item_id', 'itemId']);
  const itemIds = firstDefined(payload, ['item_ids', 'itemIds']);
  const items = firstDefined(payload, ['items']);
  const expectedItems = firstDefined(payload, ['expected_items', 'expectedItems']);
  const limit = firstDefined(payload, ['limit']);
  const page = firstDefined(payload, ['page']);
  const force = firstDefined(payload, ['force']);
  return stripUndefinedEntries({
    action: trimString(firstDefined(payload, ['action'])) || undefined,
    workspaceId: resolvePayloadWorkspaceId(payload, fallbackWorkspaceId),
    group_id: coercePositiveInteger(groupId, 'group_id'),
    item_id: coercePositiveInteger(itemId, 'item_id'),
    item_ids: Array.isArray(itemIds)
      ? itemIds.map((value, index) => {
        const parsed = coercePositiveInteger(value, `item_ids[${index}]`);
        if (!parsed) {
          throw new CliError(`Invalid item_ids[${index}]: expected a positive integer.`, {
            code: 'INVALID_ARGUMENT',
            exitCode: EXIT_CODES.USAGE,
          });
        }
        return parsed;
      })
      : undefined,
    items: Array.isArray(items) ? items : undefined,
    expected_items: Array.isArray(expectedItems) ? expectedItems : undefined,
    name: trimString(firstDefined(payload, ['name'])) || undefined,
    description: firstDefined(payload, ['description']),
    platform: trimString(firstDefined(payload, ['platform', 'groupPlatform'])) || undefined,
    refresh_frequency: trimString(firstDefined(payload, ['refresh_frequency', 'refreshFrequency'])) || undefined,
    next_refresh_at: firstDefined(payload, ['next_refresh_at', 'nextRefreshAt']) ?? undefined,
    brand_id: trimString(firstDefined(payload, ['brand_id', 'brandId'])) || undefined,
    track_type: normalizeTrackingType(firstDefined(payload, ['track_type', 'trackType', 'type'])),
    track_value: trimString(firstDefined(payload, ['track_value', 'trackValue', 'value'])) || undefined,
    region: typeof firstDefined(payload, ['region']) === 'string'
      ? trimString(firstDefined(payload, ['region'])) || undefined
      : firstDefined(payload, ['region']),
    limit: limit !== undefined ? Number(limit) : undefined,
    page: page !== undefined ? Number(page) : undefined,
    force: force === true || trimString(force).toLowerCase() === 'true' ? true : undefined,
  });
}

function normalizeBrandGroupPayload(payload, fallbackWorkspaceId) {
  return stripUndefinedEntries({
    action: trimString(firstDefined(payload, ['action'])) || undefined,
    workspaceId: resolvePayloadWorkspaceId(payload, fallbackWorkspaceId),
    workspace_id: resolvePayloadWorkspaceId(payload, fallbackWorkspaceId) || undefined,
    brand_group_id: trimString(firstDefined(payload, ['brand_group_id', 'brandGroupId', 'group_id', 'groupId', 'id'])) || undefined,
    brand_id: trimString(firstDefined(payload, ['brand_id', 'brandId'])) || undefined,
    name: trimString(firstDefined(payload, ['name'])) || undefined,
    description: firstDefined(payload, ['description']),
  });
}

function normalizeBackfillPayload(payload, fallbackWorkspaceId) {
  return stripUndefinedEntries({
    workspace_id: resolvePayloadWorkspaceId(payload, fallbackWorkspaceId) || undefined,
    brand_id: trimString(firstDefined(payload, ['brand_id', 'brandId'])) || undefined,
    tracking_group_ids: firstDefined(payload, ['tracking_group_ids', 'trackingGroupIds']),
    backfill_days: firstDefined(payload, ['backfill_days', 'backfillDays']),
    max_tracking_groups: firstDefined(payload, ['max_tracking_groups', 'maxTrackingGroups']),
    max_videos: firstDefined(payload, ['max_videos', 'maxVideos']),
    max_summaries: firstDefined(payload, ['max_summaries', 'maxSummaries']),
    bump_user_revision: firstDefined(payload, ['bump_user_revision', 'bumpUserRevision']),
    bump_workspace_revision: firstDefined(payload, ['bump_workspace_revision', 'bumpWorkspaceRevision']),
  });
}

function normalizeTrackingExportPayload(payload, fallbackWorkspaceId) {
  const groupId = firstDefined(payload, ['group_id', 'groupId', 'tracking_group_id', 'trackingGroupId']);
  const itemId = firstDefined(payload, ['tracking_item_id', 'trackingItemId', 'item_id', 'itemId']);
  return stripUndefinedEntries({
    workspace_id: resolvePayloadWorkspaceId(payload, fallbackWorkspaceId) || undefined,
    group_id: coercePositiveInteger(groupId, 'group_id'),
    tracking_item_id: coercePositiveInteger(itemId, 'tracking_item_id'),
    time_period: trimString(firstDefined(payload, ['time_period', 'timePeriod'])) || undefined,
  });
}

function buildGroupAddPayloadFromValue(rawValue, payload, label) {
  const value = trimString(rawValue);
  if (!value) {
    throw new CliError(`Invalid ${label}: expected a non-empty tracking value.`, {
      code: 'INVALID_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  if (!payload.track_type) {
    throw new CliError(`${label} requires track_type/type when using raw values.`, {
      code: 'MISSING_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Use type=keyword/search, hashtag, or account/creator when adding items by value.',
    });
  }
  return stripUndefinedEntries({
    name: value,
    track_type: payload.track_type,
    track_value: value,
    refresh_frequency: payload.refresh_frequency,
    next_refresh_at: payload.next_refresh_at,
    region: payload.region,
    platform: payload.platform,
  });
}

function buildGroupAddPayloadFromItem(rawItem, payload, label) {
  if (typeof rawItem === 'number') {
    return { item_id: coercePositiveInteger(rawItem, label) };
  }

  if (typeof rawItem === 'string') {
    const trimmed = rawItem.trim();
    if (/^\d+$/.test(trimmed)) {
      return { item_id: coercePositiveInteger(trimmed, label) };
    }
    return buildGroupAddPayloadFromValue(rawItem, payload, label);
  }

  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new CliError(`Invalid ${label}: expected an item id, string value, or object payload.`, {
      code: 'INVALID_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const itemId = coercePositiveInteger(firstDefined(rawItem, ['item_id', 'itemId', 'id']), `${label}.item_id`);
  if (itemId) {
    return { item_id: itemId };
  }

  const trackValue = trimString(firstDefined(rawItem, ['track_value', 'trackValue', 'value'])) || undefined;
  const name = trimString(firstDefined(rawItem, ['name'])) || trackValue;
  const trackType = normalizeTrackingType(firstDefined(rawItem, ['track_type', 'trackType', 'type'])) || payload.track_type;
  const region = firstDefined(rawItem, ['region']) ?? payload.region;
  const platform = trimString(firstDefined(rawItem, ['platform'])) || payload.platform;
  const refreshFrequency = trimString(firstDefined(rawItem, ['refresh_frequency', 'refreshFrequency'])) || payload.refresh_frequency;
  const nextRefreshAt = firstDefined(rawItem, ['next_refresh_at', 'nextRefreshAt']) ?? payload.next_refresh_at;

  if (!name || !trackValue || !trackType) {
    throw new CliError(`${label} requires item_id or name/track_value + track_type.`, {
      code: 'MISSING_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  return stripUndefinedEntries({
    name,
    track_type: trackType,
    track_value: trackValue,
    refresh_frequency: refreshFrequency,
    next_refresh_at: nextRefreshAt,
    region,
    platform,
  });
}

function buildSingleGroupAddBody(payload) {
  if (payload.item_id) {
    return { item_id: payload.item_id };
  }
  if (payload.track_value || payload.name) {
    return buildGroupAddPayloadFromItem({
      name: payload.name,
      track_type: payload.track_type,
      track_value: payload.track_value,
      refresh_frequency: payload.refresh_frequency,
      next_refresh_at: payload.next_refresh_at,
      region: payload.region,
      platform: payload.platform,
    }, payload, 'group add item payload');
  }
  throw new CliError('group add_item requires item_id or a tracking payload.', {
    code: 'MISSING_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Provide item_id to attach an existing tracking item, or provide track_type + track_value to create/link by value.',
  });
}

function buildBulkGroupAddBody(payload) {
  if (Array.isArray(payload.item_ids) && payload.item_ids.length > 0) {
    return payload.item_ids.map((item_id) => ({ item_id }));
  }
  if (Array.isArray(payload.items) && payload.items.length > 0) {
    return payload.items.map((item, index) => buildGroupAddPayloadFromItem(item, payload, `items[${index}]`));
  }
  if (payload.item_id || payload.track_value || payload.name) {
    return [buildSingleGroupAddBody(payload)];
  }
  throw new CliError('group add_items requires item_ids, items, or a single item payload.', {
    code: 'MISSING_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Use item_ids to bulk attach existing tracking items, or use items with track_type/type for value-based adds.',
  });
}

function translateTrackingAction(payload, workspaceId) {
  const action = payload.action ? payload.action.toLowerCase() : null;
  if (!action) {
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery('', { workspace_id: workspaceId || undefined }),
      body: stripUndefinedEntries({
        name: payload.name,
        track_type: payload.track_type,
        track_value: payload.track_value,
        refresh_frequency: payload.refresh_frequency,
        next_refresh_at: payload.next_refresh_at,
        region: payload.region,
        platform: payload.platform,
        brand_ids: payload.brand_ids,
      }),
      workspaceId,
    };
  }

  if (action === 'list' || action === 'item_list') {
    const limit = Number.isFinite(payload.limit) ? payload.limit : 20;
    const page = Number.isFinite(payload.page) ? Math.max(1, payload.page) : 1;
    const offset = Number.isFinite(payload.offset) ? Math.max(0, payload.offset) : ((page - 1) * limit);
    const isActive = typeof payload.is_active === 'boolean'
      ? payload.is_active
      : (payload.include_inactive ? undefined : true);
    return {
      method: 'GET',
      pathSuffix: buildPathWithQuery('', {
        workspace_id: workspaceId || undefined,
        limit,
        offset,
        track_type: payload.track_type,
        track_value: payload.track_value,
        platform: payload.platform,
        region: payload.region,
        is_active: isActive,
      }),
      body: undefined,
      workspaceId,
    };
  }

  if (action === 'get' || action === 'item_get') {
    const itemId = coercePositiveInteger(payload.item_id, 'item_id');
    if (!itemId) {
      throw new CliError('item_id is required for tracking get.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'GET',
      pathSuffix: buildPathWithQuery(`/${itemId}`, { workspace_id: workspaceId || undefined }),
      body: undefined,
      workspaceId,
    };
  }

  if (action === 'resolve' || action === 'item_resolve' || action === 'get_by_value' || action === 'item_get_by_value') {
    if (!payload.track_type || !payload.track_value) {
      throw new CliError('track_type and track_value are required for tracking resolve.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'GET',
      pathSuffix: buildPathWithQuery('', {
        workspace_id: workspaceId || undefined,
        resolve: 'true',
        track_type: payload.track_type,
        track_value: payload.track_value,
        platform: payload.platform,
        region: payload.region,
      }),
      body: undefined,
      workspaceId,
    };
  }

  if (action === 'create' || action === 'item_create') {
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery('', { workspace_id: workspaceId || undefined }),
      body: stripUndefinedEntries({
        name: payload.name,
        track_type: payload.track_type,
        track_value: payload.track_value,
        refresh_frequency: payload.refresh_frequency,
        next_refresh_at: payload.next_refresh_at,
        region: payload.region,
        platform: payload.platform,
        brand_ids: payload.brand_ids,
      }),
      workspaceId,
    };
  }

  if (action === 'update' || action === 'item_update') {
    const itemId = coercePositiveInteger(payload.item_id, 'item_id');
    if (!itemId) {
      throw new CliError('item_id is required for tracking update.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'PATCH',
      pathSuffix: buildPathWithQuery(`/${itemId}`, { workspace_id: workspaceId || undefined }),
      body: stripUndefinedEntries({
        refresh_frequency: payload.refresh_frequency,
        next_refresh_at: payload.next_refresh_at,
      }),
      workspaceId,
    };
  }

  if (action === 'delete' || action === 'item_delete') {
    const itemId = coercePositiveInteger(payload.item_id, 'item_id');
    if (!itemId) {
      throw new CliError('item_id is required for tracking delete.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'DELETE',
      pathSuffix: buildPathWithQuery(`/${itemId}`, { workspace_id: workspaceId || undefined }),
      body: undefined,
      workspaceId,
    };
  }

  if (action === 'refresh' || action === 'item_refresh') {
    const itemId = coercePositiveInteger(payload.item_id, 'item_id');
    if (!itemId) {
      throw new CliError('item_id is required for tracking refresh.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery(`/${itemId}/refresh`, { workspace_id: workspaceId || undefined }),
      body: {},
      workspaceId,
    };
  }

  throw new CliError(`Unsupported tracking action: ${payload.action}`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Supported tracking actions: list, get, resolve, create, update, delete, refresh.',
  });
}

function translateGroupManagementAction(payload, workspaceId, originalMethod) {
  const action = payload.action ? payload.action.toLowerCase() : null;

  if (!action && originalMethod === 'GET') {
    return {
      method: 'GET',
      pathSuffix: buildPathWithQuery('/groups', { workspace_id: workspaceId || undefined }),
      body: undefined,
      workspaceId,
    };
  }

  if (!action) {
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery('/groups', { workspace_id: workspaceId || undefined }),
      body: stripUndefinedEntries({
        name: payload.name,
        description: payload.description,
        platform: payload.platform,
        refresh_frequency: payload.refresh_frequency,
        next_refresh_at: payload.next_refresh_at,
        brand_id: payload.brand_id,
      }),
      workspaceId,
    };
  }

  if (action === 'list' || action === 'group_list') {
    return {
      method: 'GET',
      pathSuffix: buildPathWithQuery('/groups', { workspace_id: workspaceId || undefined }),
      body: undefined,
      workspaceId,
    };
  }

  if (action === 'get' || action === 'group_get') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    if (!groupId) {
      throw new CliError('group_id is required for group get.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'GET',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}`, { workspace_id: workspaceId || undefined }),
      body: undefined,
      workspaceId,
    };
  }

  if (action === 'create' || action === 'group_create') {
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery('/groups', { workspace_id: workspaceId || undefined }),
      body: stripUndefinedEntries({
        name: payload.name,
        description: payload.description,
        platform: payload.platform,
        refresh_frequency: payload.refresh_frequency,
        next_refresh_at: payload.next_refresh_at,
        brand_id: payload.brand_id,
      }),
      workspaceId,
    };
  }

  if (action === 'update' || action === 'group_update') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    if (!groupId) {
      throw new CliError('group_id is required for group update.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'PATCH',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}`, { workspace_id: workspaceId || undefined }),
      body: stripUndefinedEntries({
        name: payload.name,
        description: payload.description,
        refresh_frequency: payload.refresh_frequency,
        next_refresh_at: payload.next_refresh_at,
        brand_id: payload.brand_id,
      }),
      workspaceId,
    };
  }

  if (action === 'delete' || action === 'group_delete') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    if (!groupId) {
      throw new CliError('group_id is required for group delete.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'DELETE',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}`, { workspace_id: workspaceId || undefined }),
      body: undefined,
      workspaceId,
    };
  }

  if (action === 'refresh' || action === 'group_refresh') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    if (!groupId) {
      throw new CliError('group_id is required for group refresh.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}/refresh`, { workspace_id: workspaceId || undefined }),
      body: {},
      workspaceId,
    };
  }

  if (action === 'list_items' || action === 'group_list_items') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    if (!groupId) {
      throw new CliError('group_id is required for group list_items.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'GET',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}/items`, {
        workspace_id: workspaceId || undefined,
        page: Number.isFinite(payload.page) ? payload.page : undefined,
        limit: Number.isFinite(payload.limit) ? payload.limit : undefined,
      }),
      body: undefined,
      workspaceId,
    };
  }

  if (action === 'add_item' || action === 'group_add_item') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    if (!groupId) {
      throw new CliError('group_id is required for group add_item.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}/items`, { workspace_id: workspaceId || undefined }),
      body: buildSingleGroupAddBody(payload),
      workspaceId,
    };
  }

  if (action === 'add_items' || action === 'group_add_items') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    if (!groupId) {
      throw new CliError('group_id is required for group add_items.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}/items/bulk`, { workspace_id: workspaceId || undefined }),
      body: buildBulkGroupAddBody(payload),
      workspaceId,
    };
  }

  if (action === 'completeness' || action === 'group_completeness') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    if (!groupId) {
      throw new CliError('group_id is required for group completeness.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    const expectedItems = Array.isArray(payload.expected_items)
      ? payload.expected_items
      : (Array.isArray(payload.items) ? payload.items : undefined);
    return {
      method: 'POST',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}/completeness`, { workspace_id: workspaceId || undefined }),
      body: stripUndefinedEntries({
        expected_items: expectedItems,
        include_refresh_status: firstDefined(payload, ['include_refresh_status', 'includeRefreshStatus']),
      }),
      workspaceId,
    };
  }

  if (action === 'remove_item' || action === 'group_remove_item') {
    const groupId = coercePositiveInteger(payload.group_id, 'group_id');
    const itemId = coercePositiveInteger(payload.item_id, 'item_id');
    if (!groupId || !itemId) {
      throw new CliError('group_id and item_id are required for group remove_item.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'DELETE',
      pathSuffix: buildPathWithQuery(`/groups/${groupId}/items/${itemId}`, { workspace_id: workspaceId || undefined }),
      body: undefined,
      workspaceId,
    };
  }

  throw new CliError(`Unsupported group-management action: ${payload.action}`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Supported group-management actions: list, get, create, update, delete, refresh, list_items, add_item, add_items, completeness, remove_item.',
  });
}

function translateBrandGroupAction(payload, workspaceId) {
  const action = payload.action ? payload.action.toLowerCase() : null;
  const brandGroupId = payload.brand_group_id || undefined;
  const effectiveWorkspaceId = payload.workspace_id || workspaceId || undefined;

  if (!action) {
    return {
      method: 'POST',
      pathSuffix: '',
      body: stripUndefinedEntries({
        name: payload.name,
        description: payload.description,
        workspace_id: effectiveWorkspaceId,
      }),
      workspaceId: workspaceId || null,
    };
  }

  if (action === 'list') {
    return {
      method: 'GET',
      pathSuffix: buildPathWithQuery('', { workspace_id: effectiveWorkspaceId }),
      body: undefined,
      workspaceId: workspaceId || null,
    };
  }

  if (action === 'create') {
    return {
      method: 'POST',
      pathSuffix: '',
      body: stripUndefinedEntries({
        name: payload.name,
        description: payload.description,
        workspace_id: effectiveWorkspaceId,
      }),
      workspaceId: workspaceId || null,
    };
  }

  if (action === 'update') {
    if (!brandGroupId) {
      throw new CliError('brand_group_id is required for brand-group update.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'PATCH',
      pathSuffix: `/${brandGroupId}`,
      body: stripUndefinedEntries({
        name: payload.name,
        description: payload.description,
      }),
      workspaceId: workspaceId || null,
    };
  }

  if (action === 'delete') {
    if (!brandGroupId) {
      throw new CliError('brand_group_id is required for brand-group delete.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'DELETE',
      pathSuffix: `/${brandGroupId}`,
      body: undefined,
      workspaceId: workspaceId || null,
    };
  }

  if (action === 'add_member') {
    if (!brandGroupId || !payload.brand_id) {
      throw new CliError('brand_group_id and brand_id are required for brand-group add_member.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'POST',
      pathSuffix: `/${brandGroupId}/members`,
      body: { brand_id: payload.brand_id },
      workspaceId: workspaceId || null,
    };
  }

  if (action === 'remove_member') {
    if (!brandGroupId || !payload.brand_id) {
      throw new CliError('brand_group_id and brand_id are required for brand-group remove_member.', {
        code: 'MISSING_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    return {
      method: 'DELETE',
      pathSuffix: `/${brandGroupId}/members/${payload.brand_id}`,
      body: undefined,
      workspaceId: workspaceId || null,
    };
  }

  throw new CliError(`Unsupported brand-group-management action: ${payload.action}`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: 'Supported brand-group-management actions: list, create, update, delete, add_member, remove_member.',
  });
}

function translateToolInvocation({ functionName, method, payload, resolvedWorkspaceId }) {
  if (!isJsonObject(payload)) {
    return {
      method,
      pathSuffix: '',
      body: payload,
      workspaceId: resolvedWorkspaceId,
      normalizedPayload: payload,
    };
  }

  if (functionName === 'tracking') {
    const normalizedPayload = normalizeTrackingPayload(payload, resolvedWorkspaceId);
    const workspaceId = normalizedPayload.workspaceId || resolvedWorkspaceId || null;
    const translated = translateTrackingAction(normalizedPayload, workspaceId);
    return { ...translated, normalizedPayload };
  }

  if (functionName === 'group-management') {
    const normalizedPayload = normalizeGroupManagementPayload(payload, resolvedWorkspaceId);
    const workspaceId = normalizedPayload.workspaceId || resolvedWorkspaceId || null;
    const translated = translateGroupManagementAction(normalizedPayload, workspaceId, method);
    return { ...translated, normalizedPayload };
  }

  if (functionName === 'brand-group-management') {
    const normalizedPayload = normalizeBrandGroupPayload(payload, resolvedWorkspaceId);
    const workspaceId = normalizedPayload.workspaceId || resolvedWorkspaceId || null;
    const translated = translateBrandGroupAction(normalizedPayload, workspaceId);
    return { ...translated, normalizedPayload };
  }

  if (functionName === 'enqueue-brand-metrics-backfill') {
    const normalizedPayload = normalizeBackfillPayload(payload, resolvedWorkspaceId);
    if (!normalizedPayload.brand_id && hasOwn(payload, 'group_id')) {
      throw new CliError('enqueue-brand-metrics-backfill expects brand_id, not group_id.', {
        code: 'INVALID_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
        hint: 'Use group-management refresh for tracking groups. Backfill jobs refresh brand metrics for a workspace brand.',
      });
    }
    return {
      method,
      pathSuffix: '',
      body: normalizedPayload,
      workspaceId: resolvedWorkspaceId,
      normalizedPayload,
    };
  }

  if (functionName === 'export_tracking_data') {
    const normalizedPayload = normalizeTrackingExportPayload(payload, resolvedWorkspaceId);
    return {
      method,
      pathSuffix: '',
      body: normalizedPayload,
      workspaceId: normalizedPayload.workspace_id || resolvedWorkspaceId || null,
      normalizedPayload,
    };
  }

  return {
    method,
    pathSuffix: '',
    body: payload,
    workspaceId: resolvedWorkspaceId,
    normalizedPayload: payload,
  };
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStateChangingMethod(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

function emitWorkspaceContext(opts, { workspaceId, source, functionName, method }) {
  if (!workspaceId || !isStateChangingMethod(method)) return;
  process.stderr.write(
    `[socialseal] Workspace: ${workspaceId}${source ? ` (${source})` : ''} for ${functionName} ${method}\n`,
  );
}

function describeWorkspaceSource(source) {
  switch (source) {
    case 'flag':
      return '--workspace-id';
    case 'env':
      return 'SOCIALSEAL_WORKSPACE_ID';
    case 'config':
      return 'the saved default workspace';
    case 'body':
      return 'the request body';
    default:
      return 'implicit selection';
  }
}

function emitWorkspaceSelectionNotice(opts, { workspaceId, source, label }) {
  if (!workspaceId || !source || source === 'flag' || source === 'body') return;
  process.stderr.write(
    `[socialseal] Using workspace ${workspaceId} from ${describeWorkspaceSource(source)} for ${label}. Pass --workspace-id to override.\n`,
  );
}

function requireWorkspaceSelection(workspaceId, { label, hint }) {
  if (workspaceId) return workspaceId;
  throw new CliError(`${label} requires a workspace id.`, {
    code: 'WORKSPACE_REQUIRED',
    exitCode: EXIT_CODES.USAGE,
    hint,
  });
}

function emitTrackingCreateScopeWarning(action, workspaceId) {
  if (action !== 'create' || workspaceId) return;
  process.stderr.write(
    '[socialseal] tracking create is running without a workspace id. The backend may create a personal/null-scope item that is not attached to a workspace or group.\n',
  );
}

function looksLikeShortNumericVideoId(value) {
  return typeof value === 'string' && /^\d{1,7}$/.test(value.trim());
}

function emitAmbiguousVideoIdWarnings(items) {
  const references = Array.isArray(items) ? items : [];
  for (const item of references) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (looksLikeShortNumericVideoId(item.videoId)) {
      process.stderr.write(
        `[socialseal] videoId "${item.videoId}" looks like a short internal row id. If you meant a ranked result row, use --search-result-id. If you meant a tracking item id, resolve it first and retry with --video-uid or --platform-video-id.\n`,
      );
      return;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePollIntervalMs(opts) {
  const raw = opts.pollInterval ?? process.env.SOCIALSEAL_POLL_INTERVAL_MS;
  return parseTimeoutMs(raw, { defaultValue: DEFAULT_POLL_INTERVAL_MS, label: 'poll interval' });
}

function shouldHandleSearchJourneyRunAsync(functionName, method, payload, opts) {
  if (String(functionName || '').trim() !== 'search-journey-run') return false;
  if (method !== 'POST') return false;
  if (!isJsonObject(payload)) return false;
  if (payload.action === 'status') return false;
  return opts.async === true || payload.executionMode === 'async';
}

function applySearchJourneyRunAsyncStart(payload, opts) {
  if (!shouldHandleSearchJourneyRunAsync(opts.function, normalizeMethod(opts.method), payload, opts)) {
    return payload;
  }
  return {
    ...payload,
    executionMode: 'async',
  };
}

function formatJsonOutput(value, pretty) {
  return JSON.stringify(value, null, pretty ? 2 : 0);
}

function emitJsonOutput(value, pretty) {
  process.stdout.write(formatJsonOutput(value, pretty) + '\n');
}

function isGroupManagementBulkAddInvocation(functionName, translated) {
  if (functionName !== 'group-management') return false;
  const action = isJsonObject(translated.normalizedPayload)
    ? trimString(translated.normalizedPayload.action).toLowerCase()
    : '';
  return action === 'add_items' || action === 'group_add_items';
}

function getBulkAddExpectedCount(translated) {
  return Array.isArray(translated.body) ? translated.body.length : null;
}

function maybeThrowGroupManagementBulkAddPartialFailure(data, translated) {
  if (!isJsonObject(data)) return;

  const errors = Array.isArray(data.errors) ? data.errors : [];
  const expected = getBulkAddExpectedCount(translated);
  const processed = Number.isFinite(data.items_processed) ? data.items_processed : null;
  const added = Number.isFinite(data.items_added) ? data.items_added : 0;
  const linked = Number.isFinite(data.items_linked) ? data.items_linked : 0;
  const alreadyLinked = Number.isFinite(data.items_already_linked) ? data.items_already_linked : 0;
  const successful = added + linked + alreadyLinked;
  const failed = errors.length;
  const hasErrors = failed > 0;
  const hasProcessedMismatch = expected !== null && processed !== null && processed !== expected;
  const hasSuccessMismatch = expected !== null && successful !== expected;
  const hasVerificationFailure = data.verified === false;

  if (!hasErrors && !hasProcessedMismatch && !hasSuccessMismatch && !hasVerificationFailure) return;

  throw new CliError('group-management add_items partially failed.', {
    code: 'PARTIAL_FAILURE',
    exitCode: EXIT_CODES.SERVER,
    hint: 'Inspect errors[] and re-run add_items after fixing failed items; automation should treat this as an unsuccessful setup.',
    details: truncateDetails({
      expected,
      processed,
      added,
      linked,
      alreadyLinked,
      successful,
      failed,
      verified: data.verified,
      finalGroupItemCount: data.final_group_item_count,
      expectedFinalGroupItemCount: data.expected_final_group_item_count,
      errors,
      response: data,
    }),
  });
}

function getGroupManagementAction(translated) {
  return isJsonObject(translated.normalizedPayload)
    ? trimString(translated.normalizedPayload.action).toLowerCase()
    : '';
}

function isGroupManagementRefreshInvocation(functionName, translated) {
  if (functionName !== 'group-management') return false;
  const action = getGroupManagementAction(translated);
  return action === 'refresh' || action === 'group_refresh';
}

function getGroupManagementGroupId(translated) {
  return isJsonObject(translated.normalizedPayload)
    ? coercePositiveInteger(translated.normalizedPayload.group_id, 'group_id')
    : undefined;
}

function getGroupItemsCount(data) {
  if (Array.isArray(data)) return data.length;
  if (!isJsonObject(data)) return null;
  if (Number.isFinite(data.total)) return data.total;
  if (Array.isArray(data.items)) return data.items.length;
  if (Array.isArray(data.data)) return data.data.length;
  return null;
}

async function preflightGroupRefreshNotEmpty({
  opts,
  translated,
  apiBase,
  apiKey,
  pathPrefix,
  workspaceId,
  timeoutMs,
}) {
  if (!isGroupManagementRefreshInvocation(opts.function, translated)) return;
  if (translated.normalizedPayload?.force === true) return;

  const groupId = getGroupManagementGroupId(translated);
  if (!groupId) return;

  const res = await callApi({
    apiBase,
    apiKey,
    path: `${pathPrefix}/groups/${groupId}/items?${new URLSearchParams({
      workspace_id: workspaceId,
      page: '1',
      limit: '1',
    }).toString()}`,
    method: 'GET',
    workspaceId,
    timeoutMs,
  });

  if (!res.ok) {
    throw await buildHttpError(res, {
      label: 'Group refresh preflight',
      functionName: 'group-management',
      method: 'GET',
    });
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new CliError('Group refresh preflight returned a non-JSON response.', {
      code: 'INVALID_RESPONSE',
      exitCode: EXIT_CODES.SERVER,
    });
  }

  const data = await res.json();
  const itemCount = getGroupItemsCount(data);
  if (itemCount === 0) {
    throw new CliError('Refusing to refresh an empty tracking group.', {
      code: 'EMPTY_GROUP_REFRESH',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Add items to the group first, or pass force:true in the group-management payload to override.',
      details: truncateDetails({
        groupId,
        workspaceId,
        itemCount,
        response: data,
      }),
    });
  }
}

function buildSearchJourneyRunFailure(data) {
  const message = isJsonObject(data) && typeof data.error === 'string' && data.error.trim().length > 0
    ? data.error
    : 'search-journey-run failed';
  return new CliError(message, {
    code: 'ASYNC_RUN_FAILED',
    exitCode: EXIT_CODES.SERVER,
    details: truncateDetails(data),
  });
}

async function pollSearchJourneyRun({
  apiBase,
  apiKey,
  path,
  workspaceId,
  timeoutMs,
  pollIntervalMs,
  runId,
  opts,
}) {
  if (!workspaceId) {
    throw new CliError('Async search-journey-run polling requires a workspace id.', {
      code: 'WORKSPACE_REQUIRED',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace.',
    });
  }

  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CliError('Timed out waiting for search-journey-run async completion.', {
        code: 'ASYNC_WAIT_TIMEOUT',
        exitCode: EXIT_CODES.SERVER,
        hint: 'Increase --timeout <ms> or use --no-poll to return the run id immediately.',
        details: truncateDetails({ runId, workspaceId, lastStatus }),
      });
    }

    await sleep(Math.min(pollIntervalMs, remainingMs));

    const res = await callApi({
      apiBase,
      apiKey,
      path,
      method: 'POST',
      body: {
        action: 'status',
        workspaceId,
        runId,
      },
      workspaceId,
      timeoutMs: remainingMs,
    });

    if (!res.ok) {
      throw await buildHttpError(res, {
        label: 'Tool status poll',
        functionName: 'search-journey-run',
        method: 'POST',
      });
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new CliError('search-journey-run status poll returned a non-JSON response.', {
        code: 'INVALID_STATUS_RESPONSE',
        exitCode: EXIT_CODES.SERVER,
      });
    }

    const data = await res.json();
    const status = isJsonObject(data) && typeof data.status === 'string' ? data.status : null;
    const normalizedStatus = normalizeStatusValue(status);
    if (status && status !== lastStatus) {
      emitInfo(opts, `search-journey-run status: ${status}`);
      lastStatus = status;
    }

    if (normalizedStatus === 'completed' || normalizedStatus === 'succeeded') return data;
    if (normalizedStatus === 'failed' || normalizedStatus === 'error') {
      throw buildSearchJourneyRunFailure(data);
    }
    if (normalizedStatus && ACTIVE_STATUS_VALUES.has(normalizedStatus)) continue;

    throw new CliError('search-journey-run status poll returned an unexpected payload.', {
      code: 'INVALID_STATUS_RESPONSE',
      exitCode: EXIT_CODES.SERVER,
      details: truncateDetails(data),
    });
  }
}

function mapStatusToExitCode(status) {
  if (status === 401 || status === 403) return EXIT_CODES.AUTH;
  if (status === 404) return EXIT_CODES.NOT_FOUND;
  if (status >= 500) return EXIT_CODES.SERVER;
  if (status >= 400) return EXIT_CODES.USAGE;
  return EXIT_CODES.UNKNOWN;
}

function isLocallyDisabledByDefaultFunction(functionName) {
  return functionName === 'group-management'
    || functionName === 'export_tracking_data'
    || functionName === 'export-data';
}

function buildStatusHint(status, context = {}) {
  switch (status) {
    case 401:
    case 403:
      return 'Check your CLI key and workspace access.';
    case 404:
      if (context.functionName) {
        if (isLocallyDisabledByDefaultFunction(context.functionName)) {
          return `Unknown function "${context.functionName}". The CLI ships a static registry, but availability depends on the backend you are calling. Verify the tool is deployed on the current API base; for local direct Supabase calls, enable it in supabase/config.toml.`;
        }
        return `Unknown function "${context.functionName}". Double-check the name and API base.`;
      }
      return 'Check the API base URL and endpoint path.';
    case 405:
      return `Method not allowed. Try --method GET or ensure the endpoint supports ${context.method || 'this method'}.`;
    case 422:
      return 'Validation error. Review the JSON payload schema. For tracking/group tools, prefer the CLI action aliases or the documented REST semantics.';
    default:
      return null;
  }
}

function truncateDetails(value, limit = 2000) {
  if (value == null) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= limit) return value;
  return `${text.slice(0, limit)}…`;
}

async function buildHttpError(res, context = {}) {
  const status = res.status;
  const contentType = res.headers.get('content-type') || '';
  const raw = await res.text();
  let details = raw || null;
  if (raw && contentType.includes('application/json')) {
    try {
      details = JSON.parse(raw);
    } catch {
      details = raw;
    }
  }

  const label = context.label || 'Request';
  const statusText = res.statusText ? ` ${res.statusText}` : '';
  const hint = context.hint || buildStatusHint(status, context);

  return new CliError(`${label} failed: ${status}${statusText}`.trim(), {
    code: 'HTTP_ERROR',
    exitCode: mapStatusToExitCode(status),
    status,
    hint,
    details: truncateDetails(details),
  });
}

function resolveStatusResultsLimit(rawLimit) {
  if (rawLimit == null || rawLimit === '') return DEFAULT_STATUS_RESULTS_LIMIT;
  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError('Invalid results limit. Use a positive integer.', {
      code: 'INVALID_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Use --results-limit <n> where n is between 1 and 50.',
    });
  }
  return Math.min(parsed, 50);
}

async function callToolJson({
  apiBase,
  apiKey,
  useGateway,
  legacyUrl,
  functionName,
  body,
  workspaceId,
  timeoutMs,
  label,
}) {
  const path = useGateway ? `/cli/tools/${functionName}` : `/functions/v1/${functionName}`;
  const res = await callApi({
    apiBase: useGateway ? apiBase : legacyUrl,
    apiKey,
    path,
    method: 'POST',
    body,
    workspaceId,
    timeoutMs,
  });

  if (res.status === 404) {
    return { notFound: true, data: null };
  }
  if (!res.ok) {
    throw await buildHttpError(res, {
      label,
      functionName,
      method: 'POST',
    });
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new CliError(`${label} returned a non-JSON response.`, {
      code: 'INVALID_RESPONSE',
      exitCode: EXIT_CODES.SERVER,
    });
  }

  return { notFound: false, data: await res.json() };
}

async function readAgentToolJobStatus({
  apiBase,
  apiKey,
  useGateway,
  legacyUrl,
  timeoutMs,
  jobId,
}) {
  const response = await callToolJson({
    apiBase,
    apiKey,
    useGateway,
    legacyUrl,
    functionName: 'agent-tool-jobs',
    body: { action: 'status', jobId },
    workspaceId: null,
    timeoutMs,
    label: 'Agent tool job status',
  });
  if (response.notFound) return null;

  const data = response.data;
  return {
    kind: 'agent_tool_job',
    id: jobId,
    status: isJsonObject(data) ? trimString(data.status || '') : '',
    workspaceId: isJsonObject(data) ? (data.workspaceId ?? null) : null,
    toolName: isJsonObject(data) ? (data.toolName ?? null) : null,
    result: isJsonObject(data) ? (data.result ?? null) : null,
    error: isJsonObject(data) ? (data.error ?? null) : null,
    raw: data,
  };
}

async function readSearchJourneyRunStatus({
  apiBase,
  apiKey,
  useGateway,
  legacyUrl,
  timeoutMs,
  workspaceId,
  runId,
}) {
  if (!workspaceId) {
    throw new CliError('Search journey run status requires a workspace id.', {
      code: 'WORKSPACE_REQUIRED',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace.',
    });
  }

  const response = await callToolJson({
    apiBase,
    apiKey,
    useGateway,
    legacyUrl,
    functionName: 'search-journey-run',
    body: { action: 'status', workspaceId, runId },
    workspaceId,
    timeoutMs,
    label: 'Search journey status',
  });
  if (response.notFound) return null;

  const data = response.data;
  return {
    kind: 'search_journey_run',
    id: runId,
    status: isJsonObject(data) ? trimString(data.status || '') : '',
    workspaceId,
    journeyId: isJsonObject(data) ? (data.journeyId ?? null) : null,
    stagedKeywordsCount:
      isJsonObject(data) && Array.isArray(data.stagedKeywords) ? data.stagedKeywords.length : 0,
    error: isJsonObject(data) ? (data.error ?? null) : null,
    raw: data,
  };
}

async function readGoogleAiRunStatus({
  apiBase,
  apiKey,
  useGateway,
  legacyUrl,
  timeoutMs,
  runId,
  includeResults,
  resultsLimit,
}) {
  const runsResponse = await callToolJson({
    apiBase,
    apiKey,
    useGateway,
    legacyUrl,
    functionName: 'get-google-ai-search-runs',
    body: {
      runId,
      limit: 1,
      offset: 0,
    },
    workspaceId: null,
    timeoutMs,
    label: 'Google AI run status',
  });
  if (runsResponse.notFound) return null;

  const runsPayload = runsResponse.data;
  const runItem = isJsonObject(runsPayload) && Array.isArray(runsPayload.items)
    ? runsPayload.items.find((item) => isJsonObject(item) && Number(item.id) === runId) || null
    : null;

  if (!runItem) return null;

  let resultsPayload = null;
  if (includeResults) {
    const resultsResponse = await callToolJson({
      apiBase,
      apiKey,
      useGateway,
      legacyUrl,
      functionName: 'get-google-ai-search-results',
      body: {
        runId,
        includeCitations: true,
        limit: resultsLimit,
        offset: 0,
      },
      workspaceId: null,
      timeoutMs,
      label: 'Google AI run results',
    });
    resultsPayload = resultsResponse.notFound ? null : resultsResponse.data;
  }

  return {
    kind: 'google_ai_run',
    id: runId,
    status: trimString(runItem.status || ''),
    progress: {
      completedQueries: typeof runItem.completedQueries === 'number' ? runItem.completedQueries : null,
      totalQueries: typeof runItem.totalQueries === 'number' ? runItem.totalQueries : null,
      progressPercent: typeof runItem.progressPercent === 'number' ? runItem.progressPercent : null,
    },
    lastErrorMessage: runItem.lastErrorMessage ?? null,
    run: runItem,
    results: resultsPayload,
  };
}

function buildToolStatusNotFoundError(identifier, kind, workspaceId) {
  if (kind === 'google_ai_run') {
    return new CliError(`Google AI run not found: ${identifier.rawId}`, {
      code: 'STATUS_NOT_FOUND',
      exitCode: EXIT_CODES.NOT_FOUND,
      hint: 'Verify the run id and key scope, then retry with --kind google_ai_run.',
    });
  }
  if (kind === 'agent_job') {
    return new CliError(`Agent tool job not found: ${identifier.rawId}`, {
      code: 'STATUS_NOT_FOUND',
      exitCode: EXIT_CODES.NOT_FOUND,
      hint: 'Verify the UUID job id, then retry with --kind agent_job.',
    });
  }
  if (kind === 'journey_run') {
    return new CliError(`Search journey run not found: ${identifier.rawId}`, {
      code: 'STATUS_NOT_FOUND',
      exitCode: EXIT_CODES.NOT_FOUND,
      hint: 'Verify --workspace-id and the journey run UUID, then retry.',
    });
  }
  return new CliError(`No matching status record found for ${identifier.rawId}.`, {
    code: 'STATUS_NOT_FOUND',
    exitCode: EXIT_CODES.NOT_FOUND,
    hint: workspaceId
      ? 'Try --kind agent_job or --kind journey_run explicitly.'
      : 'Try --kind agent_job or provide --workspace-id to also check journey runs.',
  });
}

async function resolveUnifiedToolStatus({
  apiBase,
  apiKey,
  useGateway,
  legacyUrl,
  timeoutMs,
  identifier,
  kind,
  workspaceId,
  includeResults,
  resultsLimit,
}) {
  if (kind === 'google_ai_run') {
    if (identifier.numericId == null) {
      throw new CliError('google_ai_run status expects a numeric run id.', {
        code: 'INVALID_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    const result = await readGoogleAiRunStatus({
      apiBase,
      apiKey,
      useGateway,
      legacyUrl,
      timeoutMs,
      runId: identifier.numericId,
      includeResults,
      resultsLimit,
    });
    if (result) return result;
    throw buildToolStatusNotFoundError(identifier, kind, workspaceId);
  }

  if (kind === 'agent_job') {
    if (!identifier.uuidId) {
      throw new CliError('agent_job status expects a UUID id.', {
        code: 'INVALID_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    const result = await readAgentToolJobStatus({
      apiBase,
      apiKey,
      useGateway,
      legacyUrl,
      timeoutMs,
      jobId: identifier.uuidId,
    });
    if (result) return result;
    throw buildToolStatusNotFoundError(identifier, kind, workspaceId);
  }

  if (kind === 'journey_run') {
    if (!identifier.uuidId) {
      throw new CliError('journey_run status expects a UUID run id.', {
        code: 'INVALID_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
      });
    }
    const result = await readSearchJourneyRunStatus({
      apiBase,
      apiKey,
      useGateway,
      legacyUrl,
      timeoutMs,
      workspaceId,
      runId: identifier.uuidId,
    });
    if (result) return result;
    throw buildToolStatusNotFoundError(identifier, kind, workspaceId);
  }

  if (identifier.numericId != null) {
    const result = await readGoogleAiRunStatus({
      apiBase,
      apiKey,
      useGateway,
      legacyUrl,
      timeoutMs,
      runId: identifier.numericId,
      includeResults,
      resultsLimit,
    });
    if (result) return result;
    throw buildToolStatusNotFoundError(identifier, 'google_ai_run', workspaceId);
  }

  const agentJob = await readAgentToolJobStatus({
    apiBase,
    apiKey,
    useGateway,
    legacyUrl,
    timeoutMs,
    jobId: identifier.uuidId,
  });
  if (agentJob) return agentJob;

  if (workspaceId) {
    const journeyRun = await readSearchJourneyRunStatus({
      apiBase,
      apiKey,
      useGateway,
      legacyUrl,
      timeoutMs,
      workspaceId,
      runId: identifier.uuidId,
    });
    if (journeyRun) return journeyRun;
  }

  throw buildToolStatusNotFoundError(identifier, 'auto', workspaceId);
}

function buildStatusCommandHint(result, workspaceId) {
  if (!result || !result.kind) return null;
  if (result.kind === 'google_ai_run') {
    return `socialseal tools status ${result.id} --kind google_ai_run`;
  }
  if (result.kind === 'agent_tool_job') {
    return `socialseal tools status ${result.id} --kind agent_job`;
  }
  if (result.kind === 'search_journey_run') {
    const scopedWorkspace = workspaceId || result.workspaceId;
    if (!scopedWorkspace) return null;
    return `socialseal tools status ${result.id} --kind journey_run --workspace-id ${scopedWorkspace}`;
  }
  return null;
}

function maybeEmitFollowupStatusHint({ functionName, data, workspaceId }) {
  if (!isJsonObject(data)) return;
  if (functionName === 'google-ai-search' && Number.isInteger(data.runId)) {
    process.stderr.write(
      `[socialseal] Google AI run queued: ${data.runId}. Use: socialseal tools status ${data.runId} --kind google_ai_run\n`,
    );
    return;
  }
  if (functionName === 'agent-tool-jobs' && typeof data.jobId === 'string' && isUuidLike(data.jobId)) {
    process.stderr.write(
      `[socialseal] Agent tool job queued: ${data.jobId}. Use: socialseal tools status ${data.jobId} --kind agent_job\n`,
    );
    return;
  }
  if (functionName === 'search-journey-run' && typeof data.runId === 'string' && isUuidLike(data.runId)) {
    const scopedWorkspace = trimString(workspaceId || data.workspaceId || '');
    const workspaceFlag = scopedWorkspace ? ` --workspace-id ${scopedWorkspace}` : '';
    process.stderr.write(
      `[socialseal] Search journey run id: ${data.runId}. Use: socialseal tools status ${data.runId} --kind journey_run${workspaceFlag}\n`,
    );
  }
}

async function pollUnifiedStatus({
  loader,
  timeoutMs,
  pollIntervalMs,
  opts,
}) {
  const deadline = Date.now() + timeoutMs;
  let current = await loader();
  let lastStatus = normalizeStatusValue(current?.status);

  while (!isTerminalStatusValue(current?.status)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CliError('Timed out waiting for status completion.', {
        code: 'ASYNC_WAIT_TIMEOUT',
        exitCode: EXIT_CODES.SERVER,
        hint: 'Increase --timeout <ms> or omit --wait to return current status immediately.',
        details: truncateDetails(current),
      });
    }

    emitInfo(opts, `status: ${current.status}`);
    await sleep(Math.min(pollIntervalMs, remainingMs));
    current = await loader();
    const normalized = normalizeStatusValue(current?.status);
    if (normalized && normalized !== lastStatus) {
      emitInfo(opts, `status: ${current.status}`);
      lastStatus = normalized;
    }
  }

  return current;
}

function emitError(err, opts = {}) {
  const showDetails = opts.json || opts.verbose;
  const payload = {
    type: 'error',
    error: {
      code: err.code || 'CLI_ERROR',
      message: err.message || 'Unknown error',
      status: err.status ?? null,
      hint: err.hint ?? null,
      details: showDetails ? (err.details ?? null) : null,
    },
  };

  if (opts.json) {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stderr.write(`[socialseal] ${payload.error.message}\n`);
  if (payload.error.hint) {
    process.stderr.write(`[socialseal] ${payload.error.hint}\n`);
  }
  if (showDetails && payload.error.details) {
    const detailsText =
      typeof payload.error.details === 'string'
        ? payload.error.details
        : JSON.stringify(payload.error.details);
    process.stderr.write(`[socialseal] Details: ${detailsText}\n`);
  } else if (!showDetails && err.details) {
    process.stderr.write('[socialseal] Use --verbose to see error details.\n');
  }
}

function coerceCliError(err, fallbackMessage = 'Command failed') {
  if (err instanceof CliError) return err;
  if (err instanceof Error) {
    return new CliError(err.message || fallbackMessage, {
      code: 'CLI_ERROR',
      exitCode: EXIT_CODES.UNKNOWN,
    });
  }
  return new CliError(fallbackMessage, {
    code: 'CLI_ERROR',
    exitCode: EXIT_CODES.UNKNOWN,
    details: String(err),
  });
}

function requireApiKey(opts, config) {
  const apiKey = resolveApiKey(opts, config);
  if (!apiKey) {
    throw new CliError('Missing API key. Set SOCIALSEAL_API_KEY or --api-key.', {
      code: 'MISSING_API_KEY',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return apiKey;
}

function assertSupportedReportType(reportType) {
  const normalized = trimString(reportType);
  if (SUPPORTED_EXPORT_REPORT_TYPES.includes(normalized)) {
    return normalized;
  }
  throw new CliError(`Unsupported report type: ${reportType}`, {
    code: 'INVALID_ARGUMENT',
    exitCode: EXIT_CODES.USAGE,
    hint: `Use one of: ${SUPPORTED_EXPORT_REPORT_TYPES.join(', ')}. Run \`socialseal data export-options\` to choose the right export flow.`,
  });
}

function resolveApiTarget({ apiBase, legacyUrl }) {
  const resolvedApiBase = apiBase || (!legacyUrl ? DEFAULT_API_BASE : null);
  if (!resolvedApiBase && !legacyUrl) {
    throw new CliError('Missing API base. Set SOCIALSEAL_API_BASE or --api-base.', {
      code: 'MISSING_API_BASE',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return { resolvedApiBase, legacyUrl, useGateway: !!resolvedApiBase };
}

async function runCommand(handler, opts) {
  try {
    await handler(opts);
  } catch (err) {
    const cliError = coerceCliError(err);
    emitError(cliError, opts);
    process.exitCode = cliError.exitCode ?? EXIT_CODES.UNKNOWN;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CliError('Request timed out.', {
        code: 'TIMEOUT',
        exitCode: EXIT_CODES.SERVER,
        hint: 'Increase the timeout with --timeout <ms>.',
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callApi({ apiBase, apiKey, path, method = 'POST', body, workspaceId, timeoutMs }) {
  if (!apiBase) {
    throw new CliError('Missing API base. Set SOCIALSEAL_API_BASE or --api-base.', {
      code: 'MISSING_API_BASE',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  const normalizedMethod = normalizeMethod(method);
  const url = `${apiBase.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    Accept: 'application/json',
    [CLI_KEY_HEADER]: apiKey,
  };
  if (workspaceId) headers[WORKSPACE_HEADER] = workspaceId;
  const hasBody = body !== undefined && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD';
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetchWithTimeout(url, {
    method: normalizedMethod,
    headers,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return res;
}

async function fetchWorkspaceDirectory({ apiBase, apiKey, timeoutMs }) {
  const res = await callApi({
    apiBase,
    apiKey,
    path: '/cli/workspaces',
    method: 'GET',
    timeoutMs,
  });
  if (!res.ok) {
    throw await buildHttpError(res, { label: 'Workspace discovery' });
  }
  const payload = await res.json();
  return payload?.data || {};
}

function matchWorkspaceIdentifier(workspaces, identifier) {
  const normalized = String(identifier || '').trim();
  if (!normalized) {
    throw new CliError('Missing workspace identifier.', {
      code: 'MISSING_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Use a workspace id, slug, or exact name from `socialseal workspace list`.',
    });
  }

  const exactId = workspaces.find((workspace) => workspace.id === normalized);
  if (exactId) return exactId;

  const exactSlug = workspaces.find((workspace) => workspace.slug === normalized);
  if (exactSlug) return exactSlug;

  const exactNameMatches = workspaces.filter(
    (workspace) => typeof workspace.name === 'string' && workspace.name.trim().toLowerCase() === normalized.toLowerCase(),
  );
  if (exactNameMatches.length === 1) {
    return exactNameMatches[0];
  }
  if (exactNameMatches.length > 1) {
    throw new CliError(`Workspace name "${normalized}" is ambiguous.`, {
      code: 'AMBIGUOUS_WORKSPACE',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Use the workspace id or slug from `socialseal workspace list`.',
    });
  }

  throw new CliError(`Workspace "${normalized}" was not found.`, {
    code: 'WORKSPACE_NOT_FOUND',
    exitCode: EXIT_CODES.NOT_FOUND,
    hint: 'Run `socialseal workspace list` to discover available workspaces.',
  });
}

function formatWorkspaceLine(workspace, { isEffective = false, source = null, isSuggested = false } = {}) {
  const tags = [];
  if (workspace.isPersonalWorkspace) tags.push('personal');
  if (isEffective) tags.push(source === 'config' ? 'default' : `active:${source}`);
  if (isSuggested) tags.push('suggested');
  const tagText = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const slugText = workspace.slug ? ` slug=${workspace.slug}` : '';
  return `- ${workspace.name} (${workspace.id}) role=${workspace.role}${slugText}${tagText}`;
}

async function handleAgentRun(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const agentUrl = resolveLegacyUrl(resolveAgentUrl(opts, config), 'SOCIALSEAL_AGENT_URL');
  const { resolvedApiBase, legacyUrl } = resolveApiTarget({ apiBase, legacyUrl: agentUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const idleTimeoutMs = resolveAgentIdleTimeoutMs(opts, config, timeoutMs);
  const continuationToken = typeof opts.continue === 'string' ? opts.continue.trim() : '';
  const { workspaceId: resolvedWorkspaceIdInput } = resolveWorkspaceSelection(opts, config);

  if (continuationToken && opts.conversationId) {
    throw new CliError('Use either --continue or --conversation-id, not both.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  if (continuationToken && opts.createNew) {
    throw new CliError('Use either --continue or --create-new, not both.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  if (opts.conversationId && opts.createNew) {
    throw new CliError('Use either --conversation-id or --create-new, not both.', {
      code: 'INVALID_ARGUMENTS',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const headers = {
    'Content-Type': 'application/json',
    [CLI_KEY_HEADER]: apiKey,
  };
  if (resolvedWorkspaceIdInput) headers[WORKSPACE_HEADER] = resolvedWorkspaceIdInput;

  const sessionUrl = resolvedApiBase
    ? `${resolvedApiBase.replace(/\/$/, '')}/cli/agent/session`
    : `${legacyUrl.replace(/\/$/, '')}/api/agent/session`;

  const sessionRes = await fetchWithTimeout(sessionUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      continuationToken: continuationToken || undefined,
      conversationId: continuationToken ? undefined : (opts.conversationId || undefined),
      createNew: continuationToken || opts.conversationId ? undefined : true,
    }),
  }, timeoutMs);

  if (!sessionRes.ok) {
    throw await buildHttpError(sessionRes, { label: 'Agent session creation' });
  }

  const sessionData = await sessionRes.json();
  const sessionId = sessionData?.data?.sessionId || null;
  const initialConversationId = sessionData?.data?.activeConversationId || opts.conversationId || null;
  const resolvedWorkspaceId = sessionData?.data?.workspaceId || resolvedWorkspaceIdInput || null;
  const nextContinuationToken = sessionData?.data?.continuationToken || null;
  const wsUrl = sessionData?.data?.websocketUrl;
  if (!wsUrl) {
    throw new CliError('Missing websocketUrl in session response.', {
      code: 'INVALID_RESPONSE',
      exitCode: EXIT_CODES.SERVER,
    });
  }
  emitInfo(
    opts,
    `Agent session created${sessionId ? ` (session ${sessionId})` : ''}${initialConversationId ? ` for conversation ${initialConversationId}` : ''}.`,
  );
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      type: 'session_bootstrap',
      payload: {
        sessionId,
        conversationId: initialConversationId,
        workspaceId: resolvedWorkspaceId,
        continuationToken: nextContinuationToken,
      },
    }) + '\n');
  } else if (nextContinuationToken) {
    process.stderr.write(`[socialseal] Continuation token: ${nextContinuationToken}\n`);
  }

  const context = parseJsonInput(opts.context, { label: 'context', allowString: true });
  const message = opts.message;

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let finished = false;
    let settled = false;
    let inactivityTimer = null;
    let sawAssistantChunk = false;
    let sawToolCall = false;
    let sawThinking = false;
    let lastMessageType = 'none';
    let activeConversationId = initialConversationId;
    const toolProgressStatus = new Map();

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      resolve();
    };

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(error);
    };

    const resetInactivity = () => {
      if (!idleTimeoutMs) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        settleReject(new CliError('WebSocket timed out waiting for agent response.', {
          code: 'WEBSOCKET_TIMEOUT',
          exitCode: EXIT_CODES.SERVER,
          hint: 'Increase the timeout with --idle-timeout <ms> or --timeout <ms>.',
          details: truncateDetails({
            sessionId,
            activeConversationId,
            lastMessageType,
            sawAssistantChunk,
            sawToolCall,
            sawThinking,
            idleTimeoutMs,
          }),
        }));
      }, idleTimeoutMs);
    };

    ws.on('open', () => {
      resetInactivity();
      emitInfo(opts, 'Connected to agent WebSocket.');
      const payload = {
        type: 'user_message',
        payload: { content: message, context: context || undefined },
        timestamp: Date.now(),
      };
      ws.send(JSON.stringify(payload));
      emitInfo(opts, 'User message sent to agent.');
    });

    ws.on('message', (data) => {
      try {
        resetInactivity();
        const msg = JSON.parse(data.toString());
        lastMessageType = msg.type || 'unknown';

        if (msg.type === 'session_state' && msg.payload?.activeConversationId) {
          activeConversationId = msg.payload.activeConversationId;
          emitInfo(
            opts,
            `Session state received${sessionId ? ` for session ${sessionId}` : ''}${activeConversationId ? ` (conversation ${activeConversationId})` : ''}.`,
          );
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(msg) + '\n');
          if (msg.type === 'assistant_chunk' && msg.payload?.done) {
            finished = true;
            ws.close(1000, 'done');
          }
          if (msg.type === 'error') {
            const payload = msg.payload || {};
            settleReject(new CliError(`Agent error: ${payload.message || 'unknown'}`, {
              code: payload.code || 'AGENT_ERROR',
              exitCode: EXIT_CODES.SERVER,
              hint: payload.retryable ? 'Retry the request or inspect backend status.' : null,
              details: truncateDetails({
                ...payload,
                sessionId,
                activeConversationId,
                lastMessageType,
              }),
            }));
          }
          return;
        }
        if (msg.type === 'assistant_chunk') {
          const chunk = msg.payload?.chunk ?? '';
          sawAssistantChunk = sawAssistantChunk || chunk.length > 0 || !!msg.payload?.done;
          if (chunk) process.stdout.write(chunk);
          if (msg.payload?.done) {
            finished = true;
            process.stdout.write('\n');
            ws.close(1000, 'done');
          }
        } else if (msg.type === 'error') {
          const payload = msg.payload || {};
          settleReject(new CliError(`Agent error: ${payload.message || 'unknown'}`, {
            code: payload.code || 'AGENT_ERROR',
            exitCode: EXIT_CODES.SERVER,
            hint: payload.retryable ? 'Retry the request or inspect backend status.' : null,
            details: truncateDetails({
              ...payload,
              sessionId,
              activeConversationId,
              lastMessageType,
            }),
          }));
        } else if (msg.type === 'thinking_chunk') {
          sawThinking = true;
          emitInfo(opts, 'Agent is thinking.');
        } else if (msg.type === 'assistant_status') {
          const code = msg.payload?.code || 'unknown';
          const statusMessage = msg.payload?.message || 'Agent reported a status update.';
          emitInfo(opts, `Agent status [${code}]: ${statusMessage}`);
        } else if (msg.type === 'tool_call_start') {
          sawToolCall = true;
          emitInfo(opts, `Tool start: ${msg.payload?.name || 'unknown'}`);
        } else if (msg.type === 'tool_call_progress') {
          const toolCallId = msg.payload?.toolCallId || '';
          const progressStatus = msg.payload?.status || 'running';
          if (toolProgressStatus.get(toolCallId) !== progressStatus) {
            toolProgressStatus.set(toolCallId, progressStatus);
            emitInfo(opts, `Tool progress: ${progressStatus}`);
          }
        } else if (msg.type === 'tool_call_complete') {
          const error = msg.payload?.error;
          const duration = typeof msg.payload?.duration_ms === 'number'
            ? `${msg.payload.duration_ms}ms`
            : 'unknown duration';
          if (error) {
            emitInfo(opts, `Tool failed after ${duration}: ${error}`);
          } else {
            emitInfo(opts, `Tool completed in ${duration}.`);
          }
        }
      } catch (err) {
        settleReject(new CliError(`Failed to parse agent message: ${err.message || err}`, {
          code: 'INVALID_AGENT_MESSAGE',
          exitCode: EXIT_CODES.SERVER,
          details: data.toString(),
        }));
      }
    });

    ws.on('unexpected-response', async (_req, response) => {
      const statusText = response.statusCode
        ? `${response.statusCode}${response.statusMessage ? ` ${response.statusMessage}` : ''}`
        : 'unknown';
      const details = await readNodeResponseBody(response);
      settleReject(new CliError(`WebSocket upgrade failed: ${statusText}`.trim(), {
        code: 'WEBSOCKET_UPGRADE_FAILED',
        exitCode:
          response.statusCode === 401 || response.statusCode === 403
            ? EXIT_CODES.AUTH
            : EXIT_CODES.SERVER,
        hint:
          response.statusCode === 401 || response.statusCode === 403
            ? 'Check your CLI key, workspace scope, and session endpoint auth.'
            : 'Retry with --verbose to inspect gateway or backend behavior.',
        details: truncateDetails({
          sessionId,
          activeConversationId,
          responseBody: details,
        }),
      }));
    });

    ws.on('close', (code, reason) => {
      const closeReason = formatCloseReason(reason);
      if (!finished) {
        settleReject(new CliError(
          `WebSocket closed before completion (code ${code}${closeReason ? `: ${closeReason}` : ''}).`,
          {
            code: 'WEBSOCKET_CLOSED',
            exitCode: EXIT_CODES.SERVER,
            hint: sawAssistantChunk
              ? 'The agent disconnected mid-response. Retry the request.'
              : 'The agent closed the connection before completing. Retry with --verbose for more diagnostics.',
            details: truncateDetails({
              sessionId,
              activeConversationId,
              lastMessageType,
              sawAssistantChunk,
              sawToolCall,
              sawThinking,
            }),
          },
        ));
      } else {
        settleResolve();
      }
    });

    ws.on('error', (err) => {
      settleReject(new CliError(`WebSocket error: ${err.message || err}`, {
        code: 'WEBSOCKET_ERROR',
        exitCode: EXIT_CODES.SERVER,
        details: truncateDetails({
          sessionId,
          activeConversationId,
          lastMessageType,
        }),
      }));
    });
  });
}

async function handleToolsCall(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const { workspaceId: resolvedWorkspaceId, source: workspaceSource } = resolveWorkspaceSelection(opts, config);

  const parsedPayload = parseJsonInput(opts.body, { label: 'body' }) ?? {};
  const mergedPayload = mergeWorkspaceIdIntoPayload(parsedPayload, resolvedWorkspaceId);
  const requestedMethod = normalizeMethod(opts.method);
  const payload = applySearchJourneyRunAsyncStart(mergedPayload, { ...opts, method: requestedMethod });
  const translated = translateToolInvocation({
    functionName: opts.function,
    method: requestedMethod,
    payload,
    resolvedWorkspaceId,
  });
  const method = normalizeMethod(translated.method);
  const payloadWorkspaceId = isJsonObject(translated.normalizedPayload)
    ? resolvePayloadWorkspaceId(translated.normalizedPayload, resolvedWorkspaceId)
    : (isJsonObject(translated.body)
        ? resolvePayloadWorkspaceId(translated.body, resolvedWorkspaceId)
        : (resolvedWorkspaceId ?? null));
  const effectiveWorkspaceId = translated.workspaceId ?? payloadWorkspaceId ?? null;
  const effectiveWorkspaceSource =
    translated.workspaceId && translated.workspaceId !== resolvedWorkspaceId
      ? 'body'
      : (payloadWorkspaceId && payloadWorkspaceId !== resolvedWorkspaceId ? 'body' : workspaceSource);
  const path = useGateway
    ? `/cli/tools/${opts.function}${translated.pathSuffix || ''}`
    : `/functions/v1/${opts.function}${translated.pathSuffix || ''}`;

  if (opts.function === 'group-management') {
    requireWorkspaceSelection(effectiveWorkspaceId, {
      label: 'group-management',
      hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace. Omitting workspace lets the backend fall back to the personal workspace.',
    });
    emitWorkspaceSelectionNotice(opts, {
      workspaceId: effectiveWorkspaceId,
      source: effectiveWorkspaceSource,
      label: 'group-management',
    });
  }

  if (opts.function === 'export_tracking_data') {
    requireWorkspaceSelection(effectiveWorkspaceId, {
      label: 'export_tracking_data',
      hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace before exporting tracking data.',
    });
    emitWorkspaceSelectionNotice(opts, {
      workspaceId: effectiveWorkspaceId,
      source: effectiveWorkspaceSource,
      label: 'export_tracking_data',
    });
  }

  if (opts.function === 'tracked-video-extract') {
    requireWorkspaceSelection(effectiveWorkspaceId, {
      label: 'tracked-video-extract',
      hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace.',
    });
    emitWorkspaceSelectionNotice(opts, {
      workspaceId: effectiveWorkspaceId,
      source: effectiveWorkspaceSource,
      label: 'tracked-video-extract',
    });
  }

  emitTrackingCreateScopeWarning(
    isJsonObject(translated.normalizedPayload) ? trimString(translated.normalizedPayload.action).toLowerCase() : '',
    effectiveWorkspaceId,
  );

  emitWorkspaceContext(opts, {
    workspaceId: effectiveWorkspaceId,
    source: effectiveWorkspaceSource,
    functionName: opts.function,
    method,
  });

  if (isGroupManagementRefreshInvocation(opts.function, translated)) {
    await preflightGroupRefreshNotEmpty({
      opts,
      translated,
      apiBase: useGateway ? resolvedApiBase : legacyUrl,
      apiKey,
      pathPrefix: useGateway ? '/cli/tools/group-management' : '/functions/v1/group-management',
      workspaceId: effectiveWorkspaceId,
      timeoutMs,
    });
  }

  const res = await callApi({
    apiBase: useGateway ? resolvedApiBase : legacyUrl,
    apiKey,
    path,
    method,
    body: translated.body,
    workspaceId: effectiveWorkspaceId,
    timeoutMs,
  });

  if (!res.ok) {
    throw await buildHttpError(res, {
      label: 'Tool call',
      functionName: opts.function,
      method,
    });
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    const shouldPoll = shouldHandleSearchJourneyRunAsync(opts.function, method, payload, opts) && opts.poll !== false;
    if (!shouldPoll) {
      if (isGroupManagementBulkAddInvocation(opts.function, translated)) {
        maybeThrowGroupManagementBulkAddPartialFailure(data, translated);
      }
      maybeEmitFollowupStatusHint({
        functionName: opts.function,
        data,
        workspaceId: effectiveWorkspaceId,
      });
      emitJsonOutput(data, opts.pretty);
      return;
    }

    const startStatus = isJsonObject(data) && typeof data.status === 'string' ? data.status : null;
    if (startStatus === 'failed') {
      throw buildSearchJourneyRunFailure(data);
    }
    if (startStatus === 'completed') {
      emitJsonOutput(data, opts.pretty);
      return;
    }

    const runId = isJsonObject(data) && typeof data.runId === 'string' ? data.runId : null;
    if (!runId) {
      throw new CliError('Async search-journey-run start response did not include a runId.', {
        code: 'INVALID_START_RESPONSE',
        exitCode: EXIT_CODES.SERVER,
        details: truncateDetails(data),
      });
    }

    emitInfo(opts, `search-journey-run async run started: ${runId}`);
    const finalData = await pollSearchJourneyRun({
      apiBase: useGateway ? resolvedApiBase : legacyUrl,
      apiKey,
      path: useGateway ? `/cli/tools/${opts.function}` : `/functions/v1/${opts.function}`,
      workspaceId: effectiveWorkspaceId,
      timeoutMs,
      pollIntervalMs: resolvePollIntervalMs(opts),
      runId,
      opts,
    });

    emitJsonOutput(finalData, opts.pretty);
    return;
  }

  const text = await res.text();
  process.stdout.write(text);
}

function handleToolsList(opts) {
  const tools = buildToolRegistry();
  const payload = {
    discovery: 'built_in_registry',
    tools,
    note: STATIC_TOOL_REGISTRY_NOTE,
    schemaNote: STATIC_TOOL_SCHEMA_NOTE,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : 0) + '\n');
    return;
  }

  process.stdout.write('[socialseal] Built-in tool registry\n');
  process.stdout.write(`[socialseal] ${payload.note}\n`);
  process.stdout.write(`[socialseal] ${payload.schemaNote}\n`);

  let currentCategory = null;
  for (const tool of tools) {
    if (tool.category !== currentCategory) {
      currentCategory = tool.category;
      process.stdout.write(`\n${currentCategory}\n`);
    }
    const qualifiers = [
      tool.objectType ? `object=${tool.objectType}` : null,
      tool.transport ? `transport=${tool.transport}` : null,
      tool.knownLocalDevState ? `local=${tool.knownLocalDevState}` : null,
    ].filter(Boolean);
    const qualifierText = qualifiers.length > 0 ? ` [${qualifiers.join(', ')}]` : '';
    process.stdout.write(`- ${tool.name}${qualifierText}: ${tool.description}\n`);
    if (tool.notes) {
      process.stdout.write(`  note: ${tool.notes}\n`);
    }
    if (tool.schemaAvailable) {
      process.stdout.write(`  schema: ${tool.schemaSummary}\n`);
      process.stdout.write(`  schema command: socialseal tools schema --function ${tool.name}\n`);
    }
  }

  process.stdout.write('\n[socialseal] Call a tool with: socialseal tools call --function <name> --body @payload.json\n');
  process.stdout.write('[socialseal] Inspect schema examples with: socialseal tools schema --function <name>\n');
}

function handleToolsSchema(opts) {
  const tools = buildToolRegistry();
  const functionName = trimString(opts.function || '');

  if (!functionName) {
    const payload = {
      note: STATIC_TOOL_SCHEMA_NOTE,
      schemas: tools
        .filter((tool) => tool.schemaAvailable)
        .map((tool) => ({
          function: tool.name,
          summary: tool.schemaSummary,
          details: getToolSchemaHint(tool.name),
        })),
    };

    if (opts.json) {
      emitJsonOutput(payload, opts.pretty);
      return;
    }

    process.stdout.write('[socialseal] Tool schema hints\n');
    process.stdout.write(`[socialseal] ${payload.note}\n`);
    for (const schemaEntry of payload.schemas) {
      process.stdout.write(`- ${schemaEntry.function}: ${schemaEntry.summary}\n`);
      process.stdout.write(`  command: socialseal tools schema --function ${schemaEntry.function}\n`);
    }
    return;
  }

  const knownTool = getKnownTool(functionName);
  if (!knownTool) {
    throw new CliError(`Unknown tool: ${functionName}`, {
      code: 'INVALID_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
      hint: 'Run `socialseal tools list` to discover available tool names.',
    });
  }

  const schema = getToolSchemaHint(functionName);
  if (!schema) {
    throw new CliError(`No schema hint is bundled for ${functionName}.`, {
      code: 'SCHEMA_NOT_AVAILABLE',
      exitCode: EXIT_CODES.NOT_FOUND,
      hint: 'Use `socialseal tools call --function <tool> --body @payload.json` and inspect backend validation errors for this tool.',
    });
  }

  const payload = {
    function: functionName,
    note: STATIC_TOOL_SCHEMA_NOTE,
    schema,
  };

  if (opts.json) {
    emitJsonOutput(payload, opts.pretty);
    return;
  }

  process.stdout.write(`[socialseal] Tool schema: ${functionName}\n`);
  process.stdout.write(`[socialseal] ${payload.note}\n`);
  process.stdout.write(`summary: ${schema.summary}\n`);
  if (Array.isArray(schema.operations) && schema.operations.length > 0) {
    process.stdout.write('operations:\n');
    for (const operation of schema.operations) {
      process.stdout.write(`- ${operation.action}\n`);
      if (Array.isArray(operation.required) && operation.required.length > 0) {
        process.stdout.write(`  required: ${operation.required.join(', ')}\n`);
      }
      if (Array.isArray(operation.optional) && operation.optional.length > 0) {
        process.stdout.write(`  optional: ${operation.optional.join(', ')}\n`);
      }
      if (operation.notes) {
        process.stdout.write(`  note: ${operation.notes}\n`);
      }
      if (operation.example) {
        process.stdout.write(`  example body: ${JSON.stringify(operation.example)}\n`);
      }
    }
  }
  if (Array.isArray(schema.cliExamples) && schema.cliExamples.length > 0) {
    process.stdout.write('cli examples:\n');
    for (const example of schema.cliExamples) {
      process.stdout.write(`- ${example}\n`);
    }
  }
}

async function handleToolsStatus(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const pollIntervalMs = resolvePollIntervalMs(opts);
  const includeResults = opts.includeResults === true;
  const resultsLimit = resolveStatusResultsLimit(opts.resultsLimit);
  const kind = parseToolStatusKind(opts.kind);
  const identifier = normalizeStatusIdentifier(opts.id);
  const { workspaceId } = resolveWorkspaceSelection(opts, config);

  const loadStatus = async () =>
    await resolveUnifiedToolStatus({
      apiBase: resolvedApiBase,
      apiKey,
      useGateway,
      legacyUrl,
      timeoutMs,
      identifier,
      kind,
      workspaceId,
      includeResults,
      resultsLimit,
    });

  let result = await loadStatus();
  if (opts.wait) {
    result = await pollUnifiedStatus({
      loader: loadStatus,
      timeoutMs,
      pollIntervalMs,
      opts,
    });
  }

  const commandHint = buildStatusCommandHint(result, workspaceId);
  const payload = {
    ...result,
    hint: commandHint,
  };
  if (opts.wait && isFailedStatusValue(result.status)) {
    throw new CliError(`${result.kind} reached terminal ${result.status} status.`, {
      code: 'STATUS_FAILED',
      exitCode: EXIT_CODES.SERVER,
      hint: commandHint,
      details: truncateDetails(payload),
    });
  }
  emitJsonOutput(payload, opts.pretty);
}

async function handleDataExportTracking(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const { workspaceId: resolvedWorkspaceId, source: workspaceSource } = resolveWorkspaceSelection(opts, config);

  if (!opts.groupId && !opts.itemId) {
    throw new CliError('Provide --group-id or --item-id.', {
      code: 'MISSING_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (opts.groupId !== undefined) {
    opts.groupId = coercePositiveInteger(opts.groupId, 'group_id');
  }
  if (opts.itemId !== undefined) {
    opts.itemId = coercePositiveInteger(opts.itemId, 'tracking_item_id');
  }

  const payload = {
    tracking_item_id: opts.itemId || undefined,
    group_id: opts.groupId || undefined,
    time_period: opts.timePeriod,
  };

  requireWorkspaceSelection(resolvedWorkspaceId, {
    label: 'Tracking export',
    hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace before exporting tracking data.',
  });
  emitWorkspaceSelectionNotice(opts, {
    workspaceId: resolvedWorkspaceId,
    source: workspaceSource,
    label: 'tracking export',
  });

  const res = await callApi({
    apiBase: useGateway ? resolvedApiBase : legacyUrl,
    apiKey,
    path: useGateway ? '/cli/tools/export_tracking_data' : '/functions/v1/export_tracking_data',
    method: 'POST',
    body: payload,
    workspaceId: resolvedWorkspaceId,
    timeoutMs,
  });

  if (!res.ok) {
    throw await buildHttpError(res, { label: 'Tracking export' });
  }

  if (!res.body) {
    throw new CliError('Export response contained no body.', {
      code: 'EMPTY_RESPONSE',
      exitCode: EXIT_CODES.SERVER,
    });
  }

  const outPath = opts.stdout ? null : (opts.out || 'tracking_export.csv');
  if (outPath) {
    await pipeline(res.body, fs.createWriteStream(outPath));
    process.stderr.write(`[socialseal] CSV written to ${outPath}\n`);
  } else {
    await pipeline(res.body, process.stdout);
  }
}

async function handleDataExportReport(opts) {
  const reportType = assertSupportedReportType(opts.reportType);

  if (reportType === REPORT_TYPE_SEARCH_RESULTS_ENRICHED) {
    if (opts.format !== 'csv') {
      throw new CliError('search_results_enriched supports only csv format.', {
        code: 'INVALID_ARGUMENT',
        exitCode: EXIT_CODES.USAGE,
        hint: 'Use --format csv.',
      });
    }
    const payload = ensureJsonObject(parseJsonInput(opts.payload, { label: 'payload' }), 'payload');
    await handleDataExportSearchResults({
      ...opts,
      __rawPayload: payload,
    });
    return;
  }

  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const { workspaceId: resolvedWorkspaceId } = resolveWorkspaceSelection(opts, config);

  const payload = ensureJsonObject(parseJsonInput(opts.payload, { label: 'payload' }), 'payload');

  const res = await callApi({
    apiBase: useGateway ? resolvedApiBase : legacyUrl,
    apiKey,
    path: useGateway ? '/cli/tools/export-report' : '/functions/v1/export-report',
    method: 'POST',
    body: {
      reportType,
      format: opts.format,
      payload,
    },
    workspaceId: resolvedWorkspaceId,
    timeoutMs,
  });

  if (!res.ok) {
    throw await buildHttpError(res, { label: 'Report export' });
  }

  const json = await res.json();
  if (!json?.artifact) {
    process.stdout.write(JSON.stringify(json, null, opts.pretty ? 2 : 0) + '\n');
    return;
  }

  const artifact = json.artifact;
  if (artifact.contentBase64) {
    const buffer = Buffer.from(artifact.contentBase64, 'base64');
    const outPath = opts.stdout ? null : (opts.out || artifact.filename || 'export.bin');
    if (outPath) {
      fs.writeFileSync(outPath, buffer);
      process.stderr.write(`[socialseal] Export written to ${outPath}\n`);
    } else {
      process.stdout.write(buffer);
    }
    return;
  }

  if (artifact.contentJson) {
    const outPath = opts.stdout ? null : (opts.out || artifact.filename || 'export.json');
    const jsonText = JSON.stringify(artifact.contentJson, null, opts.pretty ? 2 : 0);
    if (outPath) {
      fs.writeFileSync(outPath, jsonText);
      process.stderr.write(`[socialseal] Export written to ${outPath}\n`);
    } else {
      process.stdout.write(jsonText + '\n');
    }
    return;
  }

  process.stdout.write(JSON.stringify(json, null, opts.pretty ? 2 : 0) + '\n');
}

async function runExportDataCsv({
  opts,
  label,
  template,
  normalizedPayload,
  requestedFilename,
  effectiveWorkspaceId,
  apiBase,
  apiKey,
  useGateway,
  legacyUrl,
  timeoutMs,
  decorateResponse,
}) {
  const exportResponse = await callApi({
    apiBase: useGateway ? apiBase : legacyUrl,
    apiKey,
    path: useGateway ? '/cli/tools/export-data' : '/functions/v1/export-data',
    method: 'POST',
    body: {
      template,
      format: 'csv',
      payload: normalizedPayload,
      filename: requestedFilename,
    },
    workspaceId: effectiveWorkspaceId,
    timeoutMs,
  });

  if (!exportResponse.ok) {
    throw await buildHttpError(exportResponse, {
      label,
      functionName: 'export-data',
      method: 'POST',
    });
  }

  const responseJson = await exportResponse.json();
  const decoratedResponse = typeof decorateResponse === 'function'
    ? decorateResponse(responseJson)
    : responseJson;
  const metadata = isJsonObject(responseJson) && isJsonObject(responseJson.metadata)
    ? responseJson.metadata
    : null;
  const fileUrl = trimString(metadata?.file_url || '');
  const status = trimString(metadata?.status || '').toLowerCase();

  if (!fileUrl) {
    if (status === 'processing') {
      process.stderr.write('[socialseal] Export is still processing. Re-run the same command shortly; the backend dedupes and returns the finished artifact when ready.\n');
    } else if (status === 'failed') {
      process.stderr.write('[socialseal] Export status is failed. Inspect the JSON metadata for details, then retry with corrected filters.\n');
    } else {
      process.stderr.write('[socialseal] Export did not include a file URL yet. Inspect the JSON metadata and retry if needed.\n');
    }
    emitJsonOutput(decoratedResponse, opts.pretty);
    return;
  }

  const artifactResponse = await fetchWithTimeout(fileUrl, {
    method: 'GET',
    headers: { Accept: '*/*' },
  }, timeoutMs);

  if (!artifactResponse.ok) {
    throw await buildHttpError(artifactResponse, {
      label: `${label} artifact download`,
      method: 'GET',
      hint: 'The signed file URL may be expired or inaccessible. Re-run the export command to mint a fresh URL.',
    });
  }

  if (!artifactResponse.body) {
    throw new CliError('Export artifact response contained no body.', {
      code: 'EMPTY_RESPONSE',
      exitCode: EXIT_CODES.SERVER,
    });
  }

  const outPath = opts.stdout
    ? null
    : (opts.out || trimString(metadata?.filename || '') || `${template}.csv`);
  if (outPath) {
    await pipeline(artifactResponse.body, fs.createWriteStream(outPath));
    process.stderr.write(`[socialseal] Export written to ${outPath}\n`);
  } else {
    await pipeline(artifactResponse.body, process.stdout);
  }
}

async function handleDataExportSearchResults(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const { workspaceId: resolvedWorkspaceId, source: workspaceSource } = resolveWorkspaceSelection(opts, config);

  const rawPayload = opts.__rawPayload ?? stripUndefinedEntries({
    groupIds: normalizePositiveIntegerList(opts.groupIds, 'groupIds', { max: 100 }),
    trackingItemIds: normalizePositiveIntegerList(opts.trackingItemIds, 'trackingItemIds', { max: 1000 }),
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    filename: opts.filename,
  });

  const payloadWorkspaceId = resolvePayloadWorkspaceId(rawPayload, null);
  const effectiveWorkspaceId = requireWorkspaceSelection(payloadWorkspaceId || resolvedWorkspaceId, {
    label: 'Search results enriched export',
    hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace before exporting.',
  });
  const effectiveWorkspaceSource = payloadWorkspaceId ? 'body' : workspaceSource;
  emitWorkspaceSelectionNotice(opts, {
    workspaceId: effectiveWorkspaceId,
    source: effectiveWorkspaceSource,
    label: 'search_results_enriched export',
  });

  const normalizedPayload = buildSearchResultsEnrichedExportPayload(rawPayload, effectiveWorkspaceId);
  const requestedFilename = trimString(normalizedPayload.filename) || undefined;
  delete normalizedPayload.filename;

  await runExportDataCsv({
    opts,
    label: 'Search results enriched export',
    template: EXPORT_DATA_TEMPLATE_TRACKING_RANKED_VIDEOS_RAW,
    normalizedPayload,
    requestedFilename,
    effectiveWorkspaceId,
    apiBase: resolvedApiBase,
    apiKey,
    useGateway,
    legacyUrl,
    timeoutMs,
  });
}

async function handleDataExportGroupEvidence(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const { workspaceId: resolvedWorkspaceId, source: workspaceSource } = resolveWorkspaceSelection(opts, config);

  const groupId = coercePositiveInteger(opts.groupId, 'group_id');
  const effectiveWorkspaceId = requireWorkspaceSelection(resolvedWorkspaceId, {
    label: 'Group evidence export',
    hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace before exporting group evidence.',
  });
  emitWorkspaceSelectionNotice(opts, {
    workspaceId: effectiveWorkspaceId,
    source: workspaceSource,
    label: 'group evidence export',
  });

  const requestedSurface = normalizeEvidenceSurface(opts.surface);
  let surface = requestedSurface;
  if (requestedSurface === 'auto') {
    const groupResponse = await callApi({
      apiBase: useGateway ? resolvedApiBase : legacyUrl,
      apiKey,
      path: useGateway
        ? `/cli/tools/group-management/groups/${groupId}?workspace_id=${encodeURIComponent(effectiveWorkspaceId)}`
        : `/functions/v1/group-management/groups/${groupId}?workspace_id=${encodeURIComponent(effectiveWorkspaceId)}`,
      method: 'GET',
      workspaceId: effectiveWorkspaceId,
      timeoutMs,
    });

    if (!groupResponse.ok) {
      throw await buildHttpError(groupResponse, {
        label: 'Group evidence platform detection',
        functionName: 'group-management',
        method: 'GET',
      });
    }

    const groupData = await groupResponse.json();
    surface = resolveEvidenceSurfaceFromGroup(groupData);
  }

  const rawPayload = stripUndefinedEntries({
    groupId,
    groupIds: surface === 'social' ? [groupId] : undefined,
    trackingItemIds: normalizePositiveIntegerList(opts.trackingItemIds, 'trackingItemIds', { max: 1000 }),
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    filename: opts.filename,
  });
  const normalizedPayload = surface === 'google_ai'
    ? buildGoogleAiSearchSummariesExportPayload(rawPayload, effectiveWorkspaceId)
    : buildSearchResultsEnrichedExportPayload(rawPayload, effectiveWorkspaceId);
  const requestedFilename = trimString(normalizedPayload.filename) || undefined;
  delete normalizedPayload.filename;
  const template = surface === 'google_ai'
    ? EXPORT_DATA_TEMPLATE_GOOGLE_AI_SEARCH_SUMMARIES_RAW
    : EXPORT_DATA_TEMPLATE_TRACKING_RANKED_VIDEOS_RAW;

  await runExportDataCsv({
    opts,
    label: 'Group evidence export',
    template,
    normalizedPayload,
    requestedFilename,
    effectiveWorkspaceId,
    apiBase: resolvedApiBase,
    apiKey,
    useGateway,
    legacyUrl,
    timeoutMs,
    decorateResponse: (responseJson) => ({
      ...responseJson,
      evidence: buildGroupEvidenceMetadata({
        surface,
        groupId,
        workspaceId: effectiveWorkspaceId,
        responseJson,
      }),
    }),
  });
}

async function handleDataGroupCompleteness(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const { workspaceId: resolvedWorkspaceId, source: workspaceSource } = resolveWorkspaceSelection(opts, config);

  const groupId = coercePositiveInteger(opts.groupId, 'group_id');
  const effectiveWorkspaceId = requireWorkspaceSelection(resolvedWorkspaceId, {
    label: 'Group completeness check',
    hint: 'Pass --workspace-id, set SOCIALSEAL_WORKSPACE_ID, or configure a default workspace before checking group completeness.',
  });
  emitWorkspaceSelectionNotice(opts, {
    workspaceId: effectiveWorkspaceId,
    source: workspaceSource,
    label: 'group completeness check',
  });

  const manifest = parseJsonInput(opts.manifest, { label: 'manifest' });
  const expectedItems = extractExpectedManifestItems(manifest);
  const backendPath = useGateway
    ? `/cli/tools/group-management/groups/${groupId}/completeness?${new URLSearchParams({
      workspace_id: effectiveWorkspaceId,
    }).toString()}`
    : `/functions/v1/group-management/groups/${groupId}/completeness?${new URLSearchParams({
      workspace_id: effectiveWorkspaceId,
    }).toString()}`;

  const backendRes = await callApi({
    apiBase: useGateway ? resolvedApiBase : legacyUrl,
    apiKey,
    path: backendPath,
    method: 'POST',
    body: {
      expected_items: expectedItems,
      include_refresh_status: true,
    },
    workspaceId: effectiveWorkspaceId,
    timeoutMs,
  });

  if (backendRes.ok) {
    const contentType = backendRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new CliError('Group completeness check returned a non-JSON response.', {
        code: 'INVALID_RESPONSE',
        exitCode: EXIT_CODES.SERVER,
      });
    }
    const backendData = await backendRes.json();
    emitJsonOutput(backendData, opts.pretty);
    if (isJsonObject(backendData) && backendData.complete === false) {
      process.exitCode = EXIT_CODES.SERVER;
    }
    return;
  }

  if (backendRes.status !== 404) {
    throw await buildHttpError(backendRes, {
      label: 'Group completeness check',
      functionName: 'group-management',
      method: 'POST',
    });
  }

  const res = await callApi({
    apiBase: useGateway ? resolvedApiBase : legacyUrl,
    apiKey,
    path: useGateway
      ? `/cli/tools/group-management/groups/${groupId}/items?${new URLSearchParams({
        workspace_id: effectiveWorkspaceId,
        page: '1',
        limit: String(Math.max(expectedItems.length + 100, 1000)),
      }).toString()}`
      : `/functions/v1/group-management/groups/${groupId}/items?${new URLSearchParams({
        workspace_id: effectiveWorkspaceId,
        page: '1',
        limit: String(Math.max(expectedItems.length + 100, 1000)),
      }).toString()}`,
    method: 'GET',
    workspaceId: effectiveWorkspaceId,
    timeoutMs,
  });

  if (!res.ok) {
    throw await buildHttpError(res, {
      label: 'Group completeness check',
      functionName: 'group-management',
      method: 'GET',
    });
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new CliError('Group completeness check returned a non-JSON response.', {
      code: 'INVALID_RESPONSE',
      exitCode: EXIT_CODES.SERVER,
    });
  }

  const data = await res.json();
  const actualItems = isJsonObject(data) && Array.isArray(data.items)
    ? data.items
    : (Array.isArray(data) ? data : []);
  const diff = buildCompletenessDiff({
    expectedItems,
    actualItems,
    groupId,
    workspaceId: effectiveWorkspaceId,
  });
  diff.source = 'manifest_fallback';

  emitJsonOutput(diff, opts.pretty);
  if (!diff.complete) {
    process.exitCode = EXIT_CODES.SERVER;
  }
}

function handleDataExportOptions(opts) {
  const payload = {
    exports: EXPORT_OPTIONS,
    supportedReportTypes: SUPPORTED_EXPORT_REPORT_TYPES,
    note: 'Use this list to choose the right export surface before running data export commands.',
  };

  if (opts.json) {
    emitJsonOutput(payload, opts.pretty);
    return;
  }

  process.stdout.write('[socialseal] Available export options\n');
  process.stdout.write('[socialseal] Choose a flow based on dataset shape, not endpoint name.\n\n');
  for (const option of EXPORT_OPTIONS) {
    process.stdout.write(`- ${option.id}: ${option.summary}\n`);
    process.stdout.write(`  command: ${option.command}\n`);
    process.stdout.write(`  formats: ${option.formats.join(', ')}\n`);
    process.stdout.write(`  required: ${option.required.join(', ')}\n`);
    process.stdout.write(`  best for: ${option.bestFor}\n`);
    if (option.alias) {
      process.stdout.write(`  alias: ${option.alias}\n`);
    }
    if (Array.isArray(option.reportTypes)) {
      process.stdout.write(`  report types: ${option.reportTypes.join(', ')}\n`);
    }
    process.stdout.write('\n');
  }
}

async function handleVideoExtract(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const { workspaceId: resolvedWorkspaceId, source: workspaceSource } = resolveWorkspaceSelection(opts, config);

  const body = buildVideoExtractBody(opts, resolvedWorkspaceId);
  const path = useGateway ? '/cli/tools/tracked-video-extract' : '/functions/v1/tracked-video-extract';
  const effectiveWorkspaceId = body.workspaceId || resolvedWorkspaceId;
  const effectiveWorkspaceSource = body.workspaceId && body.workspaceId !== resolvedWorkspaceId ? 'body' : workspaceSource;

  emitWorkspaceSelectionNotice(opts, {
    workspaceId: effectiveWorkspaceId,
    source: effectiveWorkspaceSource,
    label: 'tracked-video extract',
  });
  emitAmbiguousVideoIdWarnings(body.items);

  emitWorkspaceContext(opts, {
    workspaceId: effectiveWorkspaceId,
    source: effectiveWorkspaceSource,
    functionName: 'tracked-video-extract',
    method: 'POST',
  });

  const requestOnce = async (remainingTimeoutMs) => {
    const res = await callApi({
      apiBase: useGateway ? resolvedApiBase : legacyUrl,
      apiKey,
      path,
      method: 'POST',
      body,
      workspaceId: effectiveWorkspaceId,
      timeoutMs: remainingTimeoutMs,
    });

    if (!res.ok) {
      throw await buildHttpError(res, {
        label: 'Tracked video extract',
        functionName: 'tracked-video-extract',
        method: 'POST',
      });
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new CliError('tracked-video-extract returned a non-JSON response.', {
        code: 'INVALID_RESPONSE',
        exitCode: EXIT_CODES.SERVER,
      });
    }

    return await res.json();
  };

  let payload = await requestOnce(timeoutMs);

  if (opts.wait) {
    const pollIntervalMs = resolvePollIntervalMs(opts);
    const deadline = Date.now() + timeoutMs;

    while (hasPendingVideoExtractResults(payload)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new CliError('Timed out waiting for tracked video analysis completion.', {
          code: 'ASYNC_WAIT_TIMEOUT',
          exitCode: EXIT_CODES.SERVER,
          hint: 'Increase --timeout <ms> or omit --wait to return the current status immediately.',
          details: truncateDetails(payload),
        });
      }

      emitInfo(opts, 'tracked-video-extract pending; polling for completion.');
      await sleep(Math.min(pollIntervalMs, remainingMs));
      payload = await requestOnce(Math.max(1000, deadline - Date.now()));
    }
  }

  if (opts.outDir) {
    payload = await downloadVideoExtractAssets(payload, opts.outDir, timeoutMs);
  }

  emitJsonOutput(payload, opts.pretty);
}

async function handleVideoQueueAnalysis(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const { workspaceId: resolvedWorkspaceId, source: workspaceSource } = resolveWorkspaceSelection(opts, config);

  const body = buildVideoQueueBody(opts, resolvedWorkspaceId);
  const effectiveWorkspaceId = body.workspaceId || resolvedWorkspaceId;
  const effectiveWorkspaceSource = body.workspaceId && body.workspaceId !== resolvedWorkspaceId ? 'body' : workspaceSource;

  emitWorkspaceSelectionNotice(opts, {
    workspaceId: effectiveWorkspaceId,
    source: effectiveWorkspaceSource,
    label: 'tracked-video queue-analysis',
  });
  emitAmbiguousVideoIdWarnings(body.items);
  const path = useGateway ? '/cli/tools/tracked-video-extract' : '/functions/v1/tracked-video-extract';

  emitWorkspaceContext(opts, {
    workspaceId: effectiveWorkspaceId,
    source: effectiveWorkspaceSource,
    functionName: 'tracked-video-extract',
    method: 'POST',
  });

  const requestOnce = async (remainingTimeoutMs) => {
    const res = await callApi({
      apiBase: useGateway ? resolvedApiBase : legacyUrl,
      apiKey,
      path,
      method: 'POST',
      body,
      workspaceId: effectiveWorkspaceId,
      timeoutMs: remainingTimeoutMs,
    });

    if (!res.ok) {
      throw await buildHttpError(res, {
        label: 'Tracked video queue-analysis',
        functionName: 'tracked-video-extract',
        method: 'POST',
      });
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new CliError('tracked-video-extract returned a non-JSON response.', {
        code: 'INVALID_RESPONSE',
        exitCode: EXIT_CODES.SERVER,
      });
    }

    return await res.json();
  };

  let payload = await requestOnce(timeoutMs);

  if (opts.wait) {
    const pollIntervalMs = resolvePollIntervalMs(opts);
    const deadline = Date.now() + timeoutMs;

    while (hasPendingVideoExtractResults(payload)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new CliError('Timed out waiting for queued video analysis completion.', {
          code: 'ASYNC_WAIT_TIMEOUT',
          exitCode: EXIT_CODES.SERVER,
          hint: 'Increase --timeout <ms> or omit --wait to return queue status immediately.',
          details: truncateDetails(payload),
        });
      }

      emitInfo(opts, 'tracked-video queue-analysis pending; polling for completion.');
      await sleep(Math.min(pollIntervalMs, remainingMs));
      payload = await requestOnce(Math.max(1000, deadline - Date.now()));
    }
  }

  emitJsonOutput(payload, opts.pretty);
}

async function handleWorkspaceList(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const { resolvedApiBase } = resolveApiTarget({ apiBase, legacyUrl: null });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const directory = await fetchWorkspaceDirectory({
    apiBase: resolvedApiBase,
    apiKey,
    timeoutMs,
  });
  const selection = resolveWorkspaceSelection({}, config);
  const workspaces = Array.isArray(directory.workspaces) ? directory.workspaces : [];
  const payload = {
    ...directory,
    effectiveWorkspaceId: selection.workspaceId,
    effectiveWorkspaceSource: selection.source,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : 0) + '\n');
    return;
  }

  process.stdout.write('[socialseal] Available workspaces\n');
  if (workspaces.length === 0) {
    process.stdout.write('[socialseal] No accessible workspaces were returned for this key.\n');
    return;
  }

  for (const workspace of workspaces) {
    const isEffective = selection.workspaceId === workspace.id;
    const isSuggested = !selection.workspaceId && directory.defaultWorkspaceId === workspace.id;
    process.stdout.write(`${formatWorkspaceLine(workspace, { isEffective, source: selection.source, isSuggested })}\n`);
  }

  process.stdout.write('\n[socialseal] Note: workspace ids are not brand ids. When a payload includes both workspace_id and brand_id, pass the workspace id to --workspace-id.\n');

  if (!selection.workspaceId && directory.defaultWorkspaceId) {
    process.stdout.write('\n[socialseal] No local default is configured. Set one with: socialseal workspace use <id>\n');
  }
}

async function handleWorkspaceCurrent(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const { resolvedApiBase } = resolveApiTarget({ apiBase, legacyUrl: null });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const directory = await fetchWorkspaceDirectory({
    apiBase: resolvedApiBase,
    apiKey,
    timeoutMs,
  });
  const selection = resolveWorkspaceSelection({}, config);
  const workspaces = Array.isArray(directory.workspaces) ? directory.workspaces : [];
  const effectiveWorkspace = selection.workspaceId
    ? workspaces.find((workspace) => workspace.id === selection.workspaceId) || null
    : null;

  if (selection.workspaceId && !effectiveWorkspace) {
    throw new CliError(`Configured workspace "${selection.workspaceId}" is not accessible with this CLI key.`, {
      code: 'WORKSPACE_NOT_ACCESSIBLE',
      exitCode: EXIT_CODES.NOT_FOUND,
      hint: 'Run `socialseal workspace list` to pick a valid workspace or `socialseal workspace clear` to unset the default.',
    });
  }

  const payload = {
    effectiveWorkspaceId: selection.workspaceId,
    effectiveWorkspaceSource: selection.source,
    workspace: effectiveWorkspace,
    defaultWorkspaceId: directory.defaultWorkspaceId || null,
    personalWorkspaceId: directory.personalWorkspaceId || null,
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : 0) + '\n');
    return;
  }

  if (effectiveWorkspace) {
    process.stdout.write(`[socialseal] Effective workspace: ${effectiveWorkspace.name} (${effectiveWorkspace.id}) via ${selection.source}\n`);
    process.stdout.write('[socialseal] Note: workspace ids are not brand ids. Use the workspace id, not brand_id, with --workspace-id.\n');
    return;
  }

  if (directory.defaultWorkspaceId) {
    const suggestedWorkspace = workspaces.find((workspace) => workspace.id === directory.defaultWorkspaceId) || null;
    if (suggestedWorkspace) {
      process.stdout.write(`[socialseal] No local default workspace is configured. Suggested workspace: ${suggestedWorkspace.name} (${suggestedWorkspace.id})\n`);
      return;
    }
  }

  process.stdout.write('[socialseal] No default workspace is configured and no accessible workspace suggestion is available.\n');
}

async function handleWorkspaceUse(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const { resolvedApiBase } = resolveApiTarget({ apiBase, legacyUrl: null });
  const timeoutMs = resolveTimeoutMs(opts, config);
  const directory = await fetchWorkspaceDirectory({
    apiBase: resolvedApiBase,
    apiKey,
    timeoutMs,
  });
  const workspaces = Array.isArray(directory.workspaces) ? directory.workspaces : [];
  const workspace = matchWorkspaceIdentifier(workspaces, opts.identifier);
  saveConfig({
    ...config,
    workspaceId: workspace.id,
  });

  const payload = {
    success: true,
    workspaceId: workspace.id,
    workspace,
    configPath: getConfigPath(),
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : 0) + '\n');
    return;
  }

  process.stdout.write(`[socialseal] Default workspace set to ${workspace.name} (${workspace.id})\n`);
}

function handleWorkspaceClear(opts) {
  const config = loadConfig();
  const nextConfig = { ...config };
  delete nextConfig.workspaceId;
  saveConfig(nextConfig);

  const payload = {
    success: true,
    configPath: getConfigPath(),
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : 0) + '\n');
    return;
  }

  process.stdout.write('[socialseal] Default workspace cleared.\n');
}

const program = new Command();
program
  .name('socialseal')
  .description('SocialSeal CLI (non-interactive)')
  .version(CLI_VERSION);

if (typeof program.showHelpAfterError === 'function') {
  program.showHelpAfterError(true);
}
if (typeof program.showSuggestionAfterError === 'function') {
  program.showSuggestionAfterError(true);
}
program.addHelpText('after', `\nExamples:\n  socialseal workspace list\n  socialseal workspace use <workspace-id>\n  socialseal agent run --message "ping"\n  socialseal tools list\n  socialseal tools schema --function search-journey-run\n  socialseal tools call --function <tool> --body @payload.json\n  socialseal tools status 6809 --kind google_ai_run\n  socialseal tools status <run-uuid> --kind journey_run --workspace-id <uuid>\n  socialseal video queue-analysis --video-id 734829384 --workspace-id <uuid>\n  socialseal video extract --video-id 734829384 --wait --out-dir ./video-assets\n  socialseal data export-options\n  socialseal data export-tracking --group-id 123 --time-period 30d\n  socialseal data export-search-results --group-ids 123,124 --workspace-id <uuid> --out ranked.csv\n  socialseal data export-group-evidence --group-id 123 --workspace-id <uuid> --out evidence.csv\n`);

program
  .command('agent')
  .description('Agent operations')
  .command('run')
  .requiredOption('-m, --message <text>', 'Message to send to the agent')
  .option('--context <jsonOrFile>', 'Context JSON or @file.json')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--continue <token>', 'Continuation token from a previous agent run')
  .option('--conversation-id <id>', 'Conversation id to resume')
  .option('--create-new', 'Create a new conversation')
  .option('--json', 'Emit NDJSON events')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--idle-timeout <ms>', 'WebSocket inactivity timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleAgentRun, opts));

const workspace = program.command('workspace').description('Discover and manage the default workspace');

workspace
  .command('list')
  .description('List accessible workspaces for this CLI key')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--json', 'Emit machine-readable output')
  .option('--pretty', 'Pretty-print JSON')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleWorkspaceList, opts));

workspace
  .command('current')
  .description('Show the effective default workspace')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--json', 'Emit machine-readable output')
  .option('--pretty', 'Pretty-print JSON')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleWorkspaceCurrent, opts));

workspace
  .command('use <identifier>')
  .description('Persist a default workspace by id, slug, or exact name')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--json', 'Emit machine-readable output')
  .option('--pretty', 'Pretty-print JSON')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((identifier, opts) => runCommand(handleWorkspaceUse, { ...opts, identifier }));

workspace
  .command('clear')
  .description('Clear the locally configured default workspace')
  .option('--json', 'Emit machine-readable output')
  .option('--pretty', 'Pretty-print JSON')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleWorkspaceClear, opts));

const tools = program.command('tools').description('Call edge functions directly (tool backends)');

tools
  .command('list')
  .description('List built-in tool registry entries')
  .option('--json', 'Emit machine-readable output')
  .option('--pretty', 'Pretty-print JSON')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleToolsList, opts));

tools
  .command('schema')
  .description('Show static payload schema hints and examples for a tool')
  .option('--function <name>', 'Tool name (omit to list all schema hints)')
  .option('--json', 'Emit machine-readable output')
  .option('--pretty', 'Pretty-print JSON')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleToolsSchema, opts));

tools
  .command('call')
  .requiredOption('--function <name>', 'Tool name (see official docs)')
  .option('--method <method>', 'HTTP method', 'POST')
  .option('--body <jsonOrFile>', 'JSON body or @file.json')
  .option('--async', 'Request async execution for supported tool backends')
  .option('--no-poll', 'Return immediately after async start instead of polling to completion')
  .option('--poll-interval <ms>', 'Polling interval in milliseconds for supported async tool calls')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--pretty', 'Pretty-print JSON')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleToolsCall, opts));

tools
  .command('status <id>')
  .description('Read unified status for UUID jobs, journey run UUIDs, or numeric Google AI run ids')
  .option('--kind <kind>', 'auto|agent_job|google_ai_run|journey_run', 'auto')
  .option('--wait', 'Poll until status reaches a terminal state')
  .option('--poll-interval <ms>', 'Polling interval in milliseconds when --wait is enabled')
  .option('--include-results', 'Include Google AI summary/citation rows when reading numeric run ids')
  .option('--results-limit <n>', 'Max Google AI summary rows to include when --include-results is set')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (required for journey_run status)')
  .option('--pretty', 'Pretty-print JSON')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((id, opts) => runCommand(handleToolsStatus, { ...opts, id }));

const data = program.command('data').description('Data exports (provisional)');

data
  .command('export-options')
  .description('List export flows, when to use each, and required inputs')
  .option('--json', 'Emit machine-readable output')
  .option('--pretty', 'Pretty-print JSON')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleDataExportOptions, opts));

data
  .command('export-tracking')
  .description('Export tracking data as CSV')
  .option('--group-id <id>', 'Tracking group id')
  .option('--item-id <id>', 'Tracking item id')
  .requiredOption('--time-period <value>', '7d|30d|90d|180d|365d|mtd')
  .option('--out <path>', 'Output file path')
  .option('--stdout', 'Write to stdout')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleDataExportTracking, opts));

data
  .command('export-search-results')
  .description('Export enriched ranked search results (search_results + videos + latest metrics + analysis) as CSV')
  .requiredOption('--group-ids <ids>', 'Comma-separated tracking group ids (for example: 123,124,125)')
  .option('--tracking-item-ids <ids>', 'Optional comma-separated tracking item ids')
  .option('--date-from <iso>', 'Optional ISO datetime lower bound (inclusive)')
  .option('--date-to <iso>', 'Optional ISO datetime upper bound (inclusive)')
  .option('--filename <name>', 'Optional export filename stem (without extension)')
  .option('--out <path>', 'Output file path')
  .option('--stdout', 'Write to stdout')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--pretty', 'Pretty-print JSON metadata when no file is ready')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleDataExportSearchResults, opts));

data
  .command('export-group-evidence')
  .description('Export usable group evidence, routing social groups and Google AI groups to the correct CSV export')
  .requiredOption('--group-id <id>', 'Tracking group id')
  .option('--surface <surface>', 'auto|social|google_ai', 'auto')
  .option('--tracking-item-ids <ids>', 'Optional comma-separated tracking item ids')
  .option('--date-from <iso>', 'Optional ISO datetime lower bound for social ranked exports')
  .option('--date-to <iso>', 'Optional ISO datetime upper bound for social ranked exports')
  .option('--filename <name>', 'Optional export filename stem (without extension)')
  .option('--out <path>', 'Output file path')
  .option('--stdout', 'Write to stdout')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--pretty', 'Pretty-print JSON metadata when no file is ready')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleDataExportGroupEvidence, opts));

data
  .command('group-completeness')
  .description('Compare an expected tracking-item manifest against current group items')
  .requiredOption('--group-id <id>', 'Tracking group id')
  .requiredOption('--manifest <jsonOrFile>', 'Expected items manifest JSON or @file.json')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--pretty', 'Pretty-print JSON')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleDataGroupCompleteness, opts));

data
  .command('export-report')
  .description('Export report data via export-report (provisional)')
  .requiredOption('--report-type <type>', 'keyword_universe|cluster_insights|creator_signatures|post_publish|quick_audit|search_results_enriched')
  .option('--format <format>', 'csv|json|markdown|html|excel_data', 'csv')
  .requiredOption('--payload <jsonOrFile>', 'Payload JSON or @file.json')
  .option('--out <path>', 'Output file path')
  .option('--stdout', 'Write to stdout')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--pretty', 'Pretty-print JSON')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleDataExportReport, opts));

const video = program.command('video').description('Tracked video extraction workflows');

video
  .command('queue-analysis')
  .description('Queue video analysis for tracked videos or tracked search results')
  .option('--video-id <id>', 'Tracked video identifier (video_uid first, then platform video id; not a tracking item id)')
  .option('--search-result-id <id>', 'Tracked search result id for a ranked result row')
  .option('--video-uid <id>', 'Canonical tracked video_uid')
  .option('--platform-video-id <id>', 'Platform-native video id')
  .option('--body <jsonOrFile>', 'JSON body or @payload.json for batch queueing')
  .option('--wait', 'Poll until queued/completing analyses settle')
  .option('--poll-interval <ms>', 'Polling interval in milliseconds when --wait is enabled')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--pretty', 'Pretty-print JSON')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleVideoQueueAnalysis, opts));

video
  .command('extract')
  .description('Resolve tracked videos/results into structured analysis plus reference assets')
  .option('--video-id <id>', 'Tracked video identifier (video_uid first, then platform video id; not a tracking item id)')
  .option('--search-result-id <id>', 'Tracked search result id for a ranked result row')
  .option('--video-uid <id>', 'Canonical tracked video_uid')
  .option('--platform-video-id <id>', 'Platform-native video id')
  .option('--body <jsonOrFile>', 'JSON body or @payload.json for batch extraction')
  .option('--ensure-analysis', 'Queue analysis when it is missing')
  .option('--wait', 'Poll until queued/completing analyses settle')
  .option('--poll-interval <ms>', 'Polling interval in milliseconds when --wait is enabled')
  .option('--skip-assets', 'Skip asset URL generation')
  .option('--include-source-video', 'Include a signed source MP4 URL when available')
  .option('--frame-strategy <strategy>', 'brief_shots|quartiles')
  .option('--frame-count <n>', 'Number of still frames to return (1-5)')
  .option('--signed-url-seconds <n>', 'Signed URL TTL in seconds')
  .option('--out-dir <path>', 'Download returned assets into this local directory')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--pretty', 'Pretty-print JSON')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleVideoExtract, opts));

program.parseAsync(process.argv);
