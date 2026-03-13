# SocialSeal CLI

## Setup
- Requires Node 18+
- Global install: `npm install -g @socialseal/cli`
- Dev install: `npm install`

## Configuration
Environment variables:
- `SOCIALSEAL_API_KEY`
- `SOCIALSEAL_API_BASE` (default `https://api.socialseal.co`)
- `SOCIALSEAL_TIMEOUT_MS` (optional request timeout override)
- `SOCIALSEAL_AGENT_IDLE_TIMEOUT_MS` (optional agent WebSocket inactivity timeout override; default 300000)

Optional config file:
- `~/.config/socialseal/config.json`

```json
{
  "apiKey": "ss_cli_...",
  "apiBase": "https://api.socialseal.co",
  "timeoutMs": 30000,
  "agentIdleTimeoutMs": 300000
}
```

## Commands
- Agent (non-interactive, streaming):
  - `socialseal agent run --message "..." --api-base https://api.socialseal.co --api-key <key> [--workspace-id <uuid>]`
  - `socialseal agent run --message "..." --timeout 60000`
  - `socialseal agent run --message "..." --idle-timeout 300000 --verbose`

- Tools list (built-in registry):
  - `socialseal tools list`
  - `socialseal tools list --json`

- Tools (direct edge function call):
  - `socialseal tools call --function <tool> --body @payload.json --api-base https://api.socialseal.co --api-key <key>`
  - `socialseal tools call --function <tool> --body @payload.json --json`

- Data exports (provisional):
  - `socialseal data export-tracking --group-id 123 --time-period 30d --out out.csv`
  - `socialseal data export-report --report-type keyword_universe --format csv --payload @payload.json --out out.csv`

## Notes
- `export-report` and `export_tracking_data` are provisional until CLI export specs are finalized.
- `tools list` ships a stable built-in registry of supported direct-call function targets. It is not live backend enumeration.
- `--timeout <ms>` controls HTTP request timeouts. Agent runs default to a 5-minute WebSocket inactivity timeout unless you set `--idle-timeout <ms>` (or the matching env/config value).

## Errors and exit codes
- Exit codes: `2` (usage), `3` (auth), `4` (not found), `5` (server), `1` (unknown)
- Add `--json` to `tools call` or `data` commands to emit machine-readable errors.
- Add `--verbose` to print error details plus agent session/tool progress diagnostics.

## Smoke Test (manual)
1. `SOCIALSEAL_API_KEY=... socialseal agent run --message "ping"`
2. `SOCIALSEAL_API_KEY=... socialseal tools call --function <tool> --body @payload.json`

## Maintainers
- The public CLI base (`api.socialseal.co`) must route to the CLI gateway service.
