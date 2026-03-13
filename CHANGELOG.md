# Changelog

## Unreleased

## 0.1.1 - 2026-03-13
- Document public base URL and CLI error output.
- Add request timeouts, verbose error output, and OSS-safe tool discovery behavior.
- Ship a stable built-in tool registry for `tools list` instead of the hard-disabled discovery message.
- Fail fast on agent WebSocket `error` events and surface session/tool progress diagnostics in `--verbose` mode.

## 0.1.0
- Initial CLI with agent streaming, tools calls, and provisional data exports.
