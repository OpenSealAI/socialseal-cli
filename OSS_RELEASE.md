# OSS Release Checklist

## Pre-release
- Confirm public base domain (`https://api.socialseal.co`) resolves and routes to the CLI gateway.
- Validate CLI smoke against production (agent run, tools call).
- Run `npm test`.
- Update `CHANGELOG.md`.
- Bump version in `package.json`.

## Publish
- `npm publish --access public` (scoped package).
- Tag the release (e.g. `v0.1.1`) and publish release notes.
