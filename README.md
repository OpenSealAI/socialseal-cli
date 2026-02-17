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

Optional config file:
- `~/.config/socialseal/config.json`

```json
{
  "apiKey": "ss_cli_...",
  "apiBase": "https://api.socialseal.co",
  "timeoutMs": 30000
}
```

## Commands
- Agent (non-interactive, streaming):
  - `socialseal agent run --message "..." --api-base https://api.socialseal.co --api-key <key> [--workspace-id <uuid>]`
  - `socialseal agent run --message "..." --timeout 60000`

- Tools list (limited):
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
- `tools list` does not enumerate internal endpoints in the OSS build. Refer to official docs for supported tool names.
- Use `--timeout <ms>` to override the default 30s timeout for network calls.

## Errors and exit codes
- Exit codes: `2` (usage), `3` (auth), `4` (not found), `5` (server), `1` (unknown)
- Add `--json` to `tools call` or `data` commands to emit machine-readable errors.
- Add `--verbose` to print error details (suppressed by default).

## Smoke Test (manual)
1. `SOCIALSEAL_API_KEY=... socialseal agent run --message "ping"`
2. `SOCIALSEAL_API_KEY=... socialseal tools call --function <tool> --body @payload.json`

## Maintainers
- The public CLI base (`api.socialseal.co`) must route to the CLI gateway service.
