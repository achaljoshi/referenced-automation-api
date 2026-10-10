# Changelog

## Unreleased

### Added
- `ApiClient` sends `X-Correlation-Id` and logs each request (query stripped, secrets redacted); an auto `correlationId` fixture.
- `typecheck` script, `security` script and pipeline job (audit gate, secret scan).

### Changed
- **Playwright 1.64.0** (was 1.62.1): the `@playwright/test` / `playwright-core` floor is `^1.64.0` and the peer range is `>=1.64.0 <2.0.0` where the package declares one; run `npx playwright install chromium` after upgrading.
- `playwright.config.ts` uses the shared `createPlaywrightConfig`; the duplicated SMTP/SFTP test servers are gone (use `testing` from utils).

### Fixed
- **Types:** `MockServer` verb methods and `RouteMockDefinition.body` collapsed to `unknown`, so `(req) => ...` handlers were implicitly `any` under `strict`. Handlers are now typed (`MockBodyFn`, `RouteMockBodyFn`).
