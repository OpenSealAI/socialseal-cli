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
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;
const LEGACY_ENABLED = process.env.SOCIALSEAL_ENABLE_LEGACY === '1';
const EXIT_CODES = {
  OK: 0,
  UNKNOWN: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  SERVER: 5,
};
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const KNOWN_TOOLS = [];

function loadConfig() {
  const configPath = process.env.SOCIALSEAL_CONFIG || DEFAULT_CONFIG_PATH;
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[socialseal] Failed to read config:', err.message || err);
    return {};
  }
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

function resolveTimeoutMs(opts, config) {
  const raw = opts.timeout ?? process.env.SOCIALSEAL_TIMEOUT_MS ?? config.timeoutMs;
  if (raw == null || raw === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError('Invalid timeout value. Use a positive number of milliseconds.', {
      code: 'INVALID_TIMEOUT',
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return Math.min(parsed, MAX_TIMEOUT_MS);
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

function mapStatusToExitCode(status) {
  if (status === 401 || status === 403) return EXIT_CODES.AUTH;
  if (status === 404) return EXIT_CODES.NOT_FOUND;
  if (status >= 500) return EXIT_CODES.SERVER;
  if (status >= 400) return EXIT_CODES.USAGE;
  return EXIT_CODES.UNKNOWN;
}

function buildStatusHint(status, context = {}) {
  switch (status) {
    case 401:
    case 403:
      return 'Check your CLI key and workspace access.';
    case 404:
      if (context.functionName) {
        return `Unknown function "${context.functionName}". Double-check the name and API base.`;
      }
      return 'Check the API base URL and endpoint path.';
    case 405:
      return `Method not allowed. Try --method GET or ensure the endpoint supports ${context.method || 'this method'}.`;
    case 422:
      return 'Validation error. Review the JSON payload schema.';
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
    process.stderr.write(`[socialseal] Details: ${payload.error.details}\n`);
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

async function handleAgentRun(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const agentUrl = resolveLegacyUrl(resolveAgentUrl(opts, config), 'SOCIALSEAL_AGENT_URL');
  const { resolvedApiBase, legacyUrl } = resolveApiTarget({ apiBase, legacyUrl: agentUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);

  const headers = {
    'Content-Type': 'application/json',
    [CLI_KEY_HEADER]: apiKey,
  };
  if (opts.workspaceId) headers[WORKSPACE_HEADER] = opts.workspaceId;

  const sessionUrl = resolvedApiBase
    ? `${resolvedApiBase.replace(/\/$/, '')}/cli/agent/session`
    : `${legacyUrl.replace(/\/$/, '')}/api/agent/session`;

  const sessionRes = await fetchWithTimeout(sessionUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversationId: opts.conversationId || undefined,
      createNew: !!opts.createNew,
    }),
  }, timeoutMs);

  if (!sessionRes.ok) {
    throw await buildHttpError(sessionRes, { label: 'Agent session creation' });
  }

  const sessionData = await sessionRes.json();
  const wsUrl = sessionData?.data?.websocketUrl;
  if (!wsUrl) {
    throw new CliError('Missing websocketUrl in session response.', {
      code: 'INVALID_RESPONSE',
      exitCode: EXIT_CODES.SERVER,
    });
  }

  const context = parseJsonInput(opts.context, { label: 'context', allowString: true });
  const message = opts.message;

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let finished = false;
    let inactivityTimer = null;

    const resetInactivity = () => {
      if (!timeoutMs) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new CliError('WebSocket timed out waiting for agent response.', {
          code: 'WEBSOCKET_TIMEOUT',
          exitCode: EXIT_CODES.SERVER,
          hint: 'Increase the timeout with --timeout <ms>.',
        }));
      }, timeoutMs);
    };

    ws.on('open', () => {
      resetInactivity();
      const payload = {
        type: 'user_message',
        payload: { content: message, context: context || undefined },
        timestamp: Date.now(),
      };
      ws.send(JSON.stringify(payload));
    });

    ws.on('message', (data) => {
      try {
        resetInactivity();
        const msg = JSON.parse(data.toString());
        if (opts.json) {
          process.stdout.write(JSON.stringify(msg) + '\n');
          if (msg.type === 'assistant_chunk' && msg.payload?.done) {
            finished = true;
            ws.close(1000, 'done');
          }
          return;
        }
        if (msg.type === 'assistant_chunk') {
          const chunk = msg.payload?.chunk ?? '';
          if (chunk) process.stdout.write(chunk);
          if (msg.payload?.done) {
            finished = true;
            process.stdout.write('\n');
            ws.close(1000, 'done');
          }
        } else if (msg.type === 'error') {
          process.stderr.write(`\n[socialseal] Agent error: ${msg.payload?.message || 'unknown'}\n`);
        }
      } catch (err) {
        process.stderr.write(`\n[socialseal] Failed to parse agent message: ${err.message || err}\n`);
      }
    });

    ws.on('close', () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (!finished) {
        reject(new CliError('WebSocket closed before completion.', {
          code: 'WEBSOCKET_CLOSED',
          exitCode: EXIT_CODES.SERVER,
        }));
      } else {
        resolve();
      }
    });

    ws.on('error', (err) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      reject(err);
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

  const payload = parseJsonInput(opts.body, { label: 'body' }) ?? {};
  const method = normalizeMethod(opts.method);
  const res = await callApi({
    apiBase: useGateway ? resolvedApiBase : legacyUrl,
    apiKey,
    path: useGateway ? `/cli/tools/${opts.function}` : `/functions/v1/${opts.function}`,
    method,
    body: payload,
    workspaceId: opts.workspaceId,
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
    process.stdout.write(JSON.stringify(data, null, opts.pretty ? 2 : 0) + '\n');
    return;
  }

  const text = await res.text();
  process.stdout.write(text);
}

function handleToolsList(opts) {
  const payload = {
    tools: KNOWN_TOOLS,
    note: 'Tool discovery is disabled in the OSS CLI. Refer to official docs for supported tool names.',
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, opts.pretty ? 2 : 0) + '\n');
    return;
  }

  process.stdout.write('[socialseal] Tool discovery is disabled in the OSS CLI.\n');
  process.stdout.write(`[socialseal] ${payload.note}\n`);
}

async function handleDataExportTracking(opts) {
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);

  if (!opts.groupId && !opts.itemId) {
    throw new CliError('Provide --group-id or --item-id.', {
      code: 'MISSING_ARGUMENT',
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const payload = {
    tracking_item_id: opts.itemId || undefined,
    group_id: opts.groupId || undefined,
    time_period: opts.timePeriod,
  };

  const res = await callApi({
    apiBase: useGateway ? resolvedApiBase : legacyUrl,
    apiKey,
    path: useGateway ? '/cli/tools/export_tracking_data' : '/functions/v1/export_tracking_data',
    method: 'POST',
    body: payload,
    workspaceId: opts.workspaceId,
    timeoutMs,
  });

  if (!res.ok) {
    throw await buildHttpError(res, { label: 'Tracking export' });
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
  const config = loadConfig();
  const apiKey = requireApiKey(opts, config);
  const apiBase = resolveApiBase(opts, config);
  const supabaseUrl = resolveLegacyUrl(resolveSupabaseUrl(opts, config), 'SOCIALSEAL_SUPABASE_URL');
  const { resolvedApiBase, legacyUrl, useGateway } = resolveApiTarget({ apiBase, legacyUrl: supabaseUrl });
  const timeoutMs = resolveTimeoutMs(opts, config);

  const payload = ensureJsonObject(parseJsonInput(opts.payload, { label: 'payload' }), 'payload');

  const res = await callApi({
    apiBase: useGateway ? resolvedApiBase : legacyUrl,
    apiKey,
    path: useGateway ? '/cli/tools/export-report' : '/functions/v1/export-report',
    method: 'POST',
    body: {
      reportType: opts.reportType,
      format: opts.format,
      payload,
    },
    workspaceId: opts.workspaceId,
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

const program = new Command();
program
  .name('socialseal')
  .description('SocialSeal CLI (non-interactive)')
  .version('0.1.0');

if (typeof program.showHelpAfterError === 'function') {
  program.showHelpAfterError(true);
}
if (typeof program.showSuggestionAfterError === 'function') {
  program.showSuggestionAfterError(true);
}
program.addHelpText('after', `\nExamples:\n  socialseal agent run --message \"ping\"\n  socialseal tools list\n  socialseal tools call --function <tool> --body @payload.json\n  socialseal data export-tracking --group-id 123 --time-period 30d\n`);

program
  .command('agent')
  .description('Agent operations')
  .command('run')
  .requiredOption('-m, --message <text>', 'Message to send to the agent')
  .option('--context <jsonOrFile>', 'Context JSON or @file.json')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--conversation-id <id>', 'Conversation id to resume')
  .option('--create-new', 'Create a new conversation')
  .option('--json', 'Emit NDJSON events')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleAgentRun, opts));

const tools = program.command('tools').description('Call edge functions directly (tool backends)');

tools
  .command('list')
  .description('List tools (discovery disabled in OSS build)')
  .option('--json', 'Emit machine-readable output')
  .option('--pretty', 'Pretty-print JSON')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleToolsList, opts));

tools
  .command('call')
  .requiredOption('--function <name>', 'Tool name (see official docs)')
  .option('--method <method>', 'HTTP method', 'POST')
  .option('--body <jsonOrFile>', 'JSON body or @file.json')
  .option('--api-base <url>', 'API base URL (default https://api.socialseal.co)')
  .option('--api-key <key>', 'CLI API key')
  .option('--workspace-id <id>', 'Workspace id (for scoped keys)')
  .option('--pretty', 'Pretty-print JSON')
  .option('--json', 'Emit machine-readable errors')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .option('--verbose', 'Show error details')
  .action((opts) => runCommand(handleToolsCall, opts));

const data = program.command('data').description('Data exports (provisional)');

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
  .command('export-report')
  .description('Export report data via export-report (provisional)')
  .requiredOption('--report-type <type>', 'keyword_universe|cluster_insights|creator_signatures|post_publish|quick_audit')
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

program.parseAsync(process.argv);
