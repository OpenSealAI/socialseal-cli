# SocialSeal CLI

## Setup
- Requires Node 18+
- Global install: `npm install -g @socialseal/cli`
- Dev install: `npm install`

## Configuration
Environment variables:
- `SOCIALSEAL_API_KEY`
- `SOCIALSEAL_API_BASE` (default `https://api.socialseal.co`)
- `SOCIALSEAL_WORKSPACE_ID` (optional workspace override; takes precedence over config)
- `SOCIALSEAL_TIMEOUT_MS` (optional request timeout override)
- `SOCIALSEAL_AGENT_IDLE_TIMEOUT_MS` (optional agent WebSocket inactivity timeout override; default 300000)

Optional config file:
- `~/.config/socialseal/config.json`

```json
{
  "apiKey": "ss_cli_...",
  "apiBase": "https://api.socialseal.co",
  "workspaceId": "00000000-0000-0000-0000-000000000000",
  "timeoutMs": 30000,
  "agentIdleTimeoutMs": 300000
}
```

## Commands
- Workspace discovery/defaults:
  - `socialseal workspace list`
  - `socialseal workspace current`
  - `socialseal workspace use <workspace-id|slug|exact-name>`
  - `socialseal workspace clear`

- Agent (non-interactive, streaming):
  - `socialseal agent run --message "..." --api-base https://api.socialseal.co --api-key <key> [--workspace-id <uuid>]`
  - `socialseal agent run --message "..." --continue <token>`
  - `socialseal agent run --message "..." --timeout 60000`
  - `socialseal agent run --message "..." --idle-timeout 300000 --verbose`

- Tools list (built-in registry):
  - `socialseal tools list`
  - `socialseal tools list --json`
  - `socialseal tools schema --function search-journey-run`

- Tools (direct edge function call):
  - `socialseal tools call --function <tool> --body @payload.json --api-base https://api.socialseal.co --api-key <key>`
  - `socialseal tools call --function <tool> --body @payload.json --json`
  - `socialseal tools call --function search-journey-run --body @payload.json --async --workspace-id <uuid>`
  - `socialseal tools call --function search-journey-run --body @payload.json --async --no-poll --workspace-id <uuid>`
  - `socialseal tools status 6809 --kind google_ai_run`
  - `socialseal tools status <job-uuid> --kind agent_job`
  - `socialseal tools status <run-uuid> --kind journey_run --workspace-id <uuid>`
  - `socialseal tools status 6809 --kind google_ai_run --wait --include-results`

- Tracked video extraction:
  - `socialseal video queue-analysis --video-id 734829384 --workspace-id <uuid>`
  - `socialseal video extract --video-id 734829384 --workspace-id <uuid>`
  - `socialseal video extract --video-uid <video_uid> --wait --workspace-id <uuid>`
  - `socialseal video extract --body @payload.json --out-dir ./video-assets`

- Data exports (provisional):
  - `socialseal data export-options`
  - `socialseal data export-tracking --group-id 123 --time-period 30d --workspace-id <uuid> --out out.csv`
  - `socialseal data export-search-results --group-ids 123,124 --workspace-id <uuid> --out ranked.csv`
  - `socialseal data export-report --report-type search_results_enriched --format csv --payload @payload.json --workspace-id <uuid> --out ranked.csv`
  - `socialseal data export-report --report-type keyword_universe --format csv --payload @payload.json --out out.csv`

## Notes
- `export-report`, `export_tracking_data`, and `export-data`-backed exports are provisional until CLI export specs are finalized.
- `tools list` ships a stable built-in registry of supported direct-call function targets. It is not live backend enumeration.
- `tools schema --function <name>` prints static required/optional payload fields and example bodies for high-friction tools.
- `data export-search-results` maps to `export-data` template `tracking_ranked_videos_raw` and returns enriched ranked-search rows (search fields + video metadata + latest metrics + analysis). It downloads the signed CSV artifact when available.
- `data export-report --report-type search_results_enriched` is a compatibility alias to the same `export-data` template flow.
- `data export-report` now validates report types locally and shows the allowed list immediately; run `socialseal data export-options` when choosing between export flows.
- If an export returns metadata without a file URL (for example status `processing`), the CLI prints an explicit retry hint and returns the metadata JSON so automation can branch on status.
- `--timeout <ms>` controls HTTP request timeouts. Agent runs default to a 5-minute WebSocket inactivity timeout unless you set `--idle-timeout <ms>` (or the matching env/config value).
- `search-journey-run` supports CLI-managed async polling: `--async` starts backend async mode, polling is on by default, `--no-poll` returns the initial `runId`, and `--poll-interval <ms>` controls the status polling cadence.
- `tools status <id>` is the unified read path for numeric Google AI run ids and UUID job/run ids. `--kind auto` detects numeric Google runs and UUID agent jobs, and falls back to journey status when `--workspace-id` is provided.
- `video queue-analysis` wraps the tracked-video extraction backend in queue-only mode so you can queue one or many tracked videos without downloading assets first.
- `video extract` wraps the same backend in extraction mode and returns a normalized JSON payload with resolved tracking context, structured analysis, thumbnail/frame assets, and optional local downloads under `--out-dir`.
- `--video-id` is the primary ergonomic selector for video workflows. The backend tries it as `video_uid` first, then as platform video id. It does not accept tracking item ids. `--search-result-id` remains available when you are starting from a specific tracked rank row.
- `group-management` and `export_tracking_data` now fail fast when no workspace is selected, instead of letting the backend silently fall back to the personal workspace.
- `tracking create` without a workspace now prints a warning that the backend may create a personal/null-scope item.
- Short numeric `--video-id` inputs now print a warning that they may be internal row ids and that `--search-result-id` is often the intended selector.
- `socialseal agent run` now defaults to a fresh conversation. The CLI prints a continuation token to `stderr`; pass it back with `--continue <token>` to resume the same agent conversation explicitly.
- Effective workspace precedence is: `--workspace-id` → `SOCIALSEAL_WORKSPACE_ID` → config `workspaceId`. For commands that are easy to misuse (`group-management`, `export_tracking_data`, tracked-video workflows), the CLI now requires an explicit or preconfigured workspace instead of relying on backend fallback.
- `socialseal workspace use ...` writes a local default workspace into `~/.config/socialseal/config.json`, which the CLI reuses for `agent`, `tools`, and `data` commands.
- `socialseal workspace list` discovers the workspaces accessible to the current CLI key, marks the active/suggested default, and reminds you that `workspace_id` and `brand_id` are different identifiers.
- If a scoped CLI key cannot safely infer a workspace, `agent run` now fails closed and tells you to set `--workspace-id` or configure a local default first.

## Errors and exit codes
- Exit codes: `2` (usage), `3` (auth), `4` (not found), `5` (server), `1` (unknown)
- Add `--json` to `tools call` or `data` commands to emit machine-readable errors.
- Add `--verbose` to print error details plus agent session/tool progress diagnostics.

## Troubleshooting
- `SUPABASE_ANON_KEY not configured`
  - This comes from the CLI gateway, not the local CLI install.
  - The deployed gateway is missing its `SUPABASE_ANON_KEY` secret, so `/cli/tools/*` cannot proxy to Supabase Edge Functions.
  - Fix on the server side with `wrangler secret put SUPABASE_ANON_KEY --env <staging|production>` for the gateway Worker, then re-run a `socialseal tools call ...` smoke test.
- `AI_UNSUPPORTED_LOCATION` or `The live agent is unavailable in this region right now.`
  - This is raised when the upstream Gemini API rejects the worker egress location.
  - The agent worker currently uses Google Gemini directly from Cloudflare Workers; there is no SocialSeal-side region allowlist in the CLI.
  - If this reproduces from a supported Google AI region, treat it as an infrastructure/runtime issue. Practical workarounds are to run the agent from a worker placement/egress region that Google accepts, or switch the agent runtime to Vertex AI for server-side calls.

## Smoke Test (manual)
1. `SOCIALSEAL_API_KEY=... socialseal agent run --message "ping"`
2. `SOCIALSEAL_API_KEY=... socialseal tools call --function <tool> --body @payload.json`

## Maintainers
- The public CLI base (`api.socialseal.co`) must route to the CLI gateway service.
