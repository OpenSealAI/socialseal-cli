# OSS Release Checklist

## Pre-release
- Confirm `package.json` is `@socialseal/cli@0.1.14`, public, and points to
  `OpenSealAI/socialseal-cli`.
- Confirm the public base domain (`https://api.socialseal.co`) routes to the
  server-side CLI gateway.
- Run the local gates (GitHub CI is unavailable for this release):
  - `npm test`
  - `npm pack --dry-run`
  - `node src/entry.js --version`
  - `EXPLORE_FEATURE_POLICY='{"mode":"live","allowedChannels":["cli"]}' node src/entry.js --help`
- Confirm the installed help does not advertise `agent` and does advertise
  `explore` when the CLI policy allows it.
- Validate an authenticated production `tools call` smoke when credentials and
  the gateway are available; record any unavailable external check separately.
- Update `CHANGELOG.md` before changing the package version for a later release.

## Publish
- `npm publish --access public` (scoped package).
- Tag the release (`v0.1.14`) and publish release notes.
