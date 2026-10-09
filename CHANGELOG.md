# Changelog

## Unreleased

### Added
- `ApiClient` sends `X-Correlation-Id` and logs each request (query stripped, secrets redacted); an auto `correlationId` fixture.
- `typecheck` script, `security` script and pipeline job (audit gate, secret scan).

### Changed
- `playwright.config.ts` uses the shared `createPlaywrightConfig`; the duplicated SMTP/SFTP test servers are gone (use `testing` from utils).

### Fixed
- **Types:** `MockServer` verb methods and `RouteMockDefinition.body` collapsed to `unknown`, so `(req) => ...` handlers were implicitly `any` under `strict`. Handlers are now typed (`MockBodyFn`, `RouteMockBodyFn`).
