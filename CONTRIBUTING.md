# Contributing

Thanks for contributing to the SocialSeal CLI.

## Quick start
- Use Node 18+.
- Install dependencies: `npm install`.
- Run the CLI locally: `node src/index.js --help`.

## Code style
- Keep the CLI non-interactive and automation-friendly.
- Prefer explicit error messages with actionable hints.
- Avoid adding new network endpoints without product approval.

## Testing
- Run `npm test` (covers `--help` and JSON error output).
- You can also run a manual smoke test: `node src/index.js --help`.

## Pull requests
- Keep changes small and focused.
- Update `README.md` and `CHANGELOG.md` if user-facing behavior changes.
