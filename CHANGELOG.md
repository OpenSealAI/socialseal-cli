# Changelog

## Unreleased

- Remove the conversational agent command from the installed CLI and agent execution from MCP discovery; conversational agent workflows remain in the web app.

## 0.1.14 - 2026-08-30

- Ship the first-class Explore command family through the standalone CLI entrypoint, including static discovery/schema metadata, canonical actions and limits, policy-gated registration, polling, and exact selection validation.
- Remove the unpublished `@socialseal/contracts` runtime dependency so packed installs run independently of the SocialSeal monorepo.

## 0.1.12 - 2026-06-23

- Expose Asset Studio and video production tool surfaces through CLI discovery/schema output.
- Add category-filtered tool discovery for users and agents.

## 0.1.11 - 2026-06-12

- Add ad hoc public video URL analysis parity for queue and extract workflows, including `--url` and `--allow-untracked` support.

## 0.1.10 - 2026-06-10

- Clarify ranked search exports now include publish/observed dates and scoped tracked-search resurfacing history fields when the backend export template is deployed.
- Update `data export-options` metadata to distinguish search capture, metrics capture, platform publish, and SocialSeal observed-history timestamps.

## 0.1.9 - 2026-05-13

- Fail `group-management add_items` on backend partial failures, expected-count mismatches, and failed backend verification.
- Add `data export-group-evidence` to route social ranked evidence and Google AI evidence to the right raw export template with metadata.
- Add `data group-completeness` with backend-first completeness checks, manifest fallback, and refresh status visibility.
- Harden `tools status --wait` terminal failure handling and empty group refresh guardrails.

## 0.1.8 - 2026-04-13

- Increase default CLI timeout from 30s to 5m to reduce false timeout failures on heavy tool/export workflows.
- Harden async `search-journey-run` polling to accept additional active/terminal status labels (`queued`, `in_progress`, `running`, `succeeded`, `error`) instead of failing on unexpected variants.
- Fix async `search-journey-run` polling workspace propagation to always reuse the resolved effective workspace scope.

## 0.1.7 - 2026-03-20

- Add `socialseal data export-search-results` for CLI-first enriched ranked-search exports, including direct CSV download handling.
- Add `search_results_enriched` as an alias on `socialseal data export-report` to map to the ranked-search export template.
- Add `socialseal data export-options` to make available export workflows discoverable from the CLI.
- Improve export ergonomics with local report-type validation and instructive failure guidance for processing, failed, and expired-download states.

## 0.1.6 - 2026-03-19

- Fix runtime version reporting so `socialseal --version` reads from package metadata instead of a hardcoded source string.
- Fix `tracking` create request translation so `--workspace-id` is sent on the REST query path the backend uses for workspace binding.
- Improve tracked-video extraction failure messages by avoiding `[object Object]` item errors and returning explicit guidance when `videoId` is actually a search-result id or tracking item id.
- Fail fast for `group-management` and `export_tracking_data` when no workspace is selected, instead of silently relying on backend personal-workspace fallback.
- Warn when `tracking create` runs without a workspace and when short numeric `--video-id` values look like internal row ids.
- Clarify in workspace discovery output and docs that `workspace_id` and `brand_id` are different identifiers.

## 0.1.5 - 2026-03-19

- Add first-class tracked-video workflows with `video queue-analysis` and `video extract`.
- Make `--video-id` the primary ergonomic selector for tracked-video analysis and asset extraction, while keeping `--search-result-id` as a fallback selector.
- Support batch queueing/extraction payloads plus optional asset downloads for thumbnails, source video, and extracted key frames.

## 0.1.4 - 2026-03-19

- Add explicit `group_add_item` / `group_add_items` CLI aliases for tracking-group membership workflows.
- Add `tracking resolve` / `get_by_value` so existing tracked searches can be resolved by value using the same duplicate-detection semantics as create.
- Return operational duplicate metadata for tracking conflicts, including `existing_item_id`, `member_of_group_ids`, platform, region, workspace, and active state.

## 0.1.3 - 2026-03-19

- Republish the current CLI release line after the successful `0.1.2` npm publish, keeping the internal and OSS package versions aligned.

## 0.1.2 - 2026-03-18

- Add `search-journey-run` async CLI ergonomics: `--async` starts the backend async mode, polling is on by default, and `--no-poll` returns the initial `runId` immediately.
- Add `--poll-interval <ms>` for async `search-journey-run` status polling.
- Treat terminal async `search-journey-run` failures as non-zero CLI exits instead of silent `200` JSON output.

## 0.1.1 - 2026-03-13

- Document public base URL and CLI error output.
- Add request timeouts, verbose error output, and OSS-safe tool discovery behavior.
- Ship a stable built-in tool registry for `tools list` instead of the hard-disabled discovery message.
- Fail fast on agent WebSocket `error` events and surface session/tool progress diagnostics in `--verbose` mode.

## 0.1.0

- Initial CLI with agent streaming, tools calls, and provisional data exports.
