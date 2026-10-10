# Changelog

## Unreleased

### Added
- **BDD (`playwright-bdd` 9.2.1, pinned)**: `registerApiSteps` (send requests, auth, headers, query, bodies, uploads, GraphQL, polling; assert status, headers, fields, JSON subset/schema, timing; remember values), `registerDataSteps` (variables, random data, dates, env), `{{placeholders}}` everywhere; `vars` and `apiScenario` fixtures; a `bdd` project and sample features in `features/`; `npm run test:bdd`.
- **`api-curl-to-playwright`**: turns curl commands (a file, a folder, or stdin; bash or Chrome "Copy as cURL" cmd form) into tests that use `apiClient`, the auth classes and the response assertions. `# name / expect / expect-json / expect-header / expect-max-ms / schema / save / flow / tag / skip / secret` comments above a command say what to check; secrets are read from the environment, never written; `--param` marks more. `toCurl()` goes the other way.
- **`ApiClient`**: retry policy with backoff and `Retry-After` (idempotent verbs; POST needs an idempotency key), `idempotencyKey`, `poll` / `pollUntil`, `download`, `getJson` / `getText`, `graphql`, `soap`, `scoped`, `setBaseUrl`, `maxRedirects` / `maxRetries` / `ignoreHTTPSErrors`, and a log of every exchange (credentials masked).
- **`ApiResponse`**: `durationMs`, `bytes`, `cookies`, `expectHeader`, `expectContentType`, `expectBodyContains`, `expectMatches`, `expectArrayLength`, `expectResponseTimeUnder`, `expectNoGraphqlErrors`, `snapshotText`.
- **`expect` matchers** for an `ApiResponse`: `toHaveStatus`, `toBeSuccessful`, `toHaveJsonPath`, `toMatchJsonSubset`, `toMatchJsonSchema`, `toHaveResponseHeader`, `toRespondWithin`.
- **Auth**: `OAuth2PasswordAuth`, `JwtAuth`, `HmacAuth`, `SessionCookieAuth`, `CompositeAuth`.
- **Fixtures**: `apiFor` (a client for another user/system), `cleanup` (newest-first undo), `attachExchangesOnFailure` (the calls a failed test made, as an attachment).
- `docs/PLAYWRIGHT_COVERAGE.md`: Playwright's API-testing capabilities against the framework, with the gaps this round closed.
- `ApiClient` sends `X-Correlation-Id` and logs each request (query stripped, secrets redacted); an auto `correlationId` fixture.
- `typecheck` script, `security` script and pipeline job (audit gate, secret scan).

### Changed
- **Playwright 1.64.0** (was 1.62.1): the `@playwright/test` / `playwright-core` floor is `^1.64.0` and the peer range is `>=1.64.0 <2.0.0` where the package declares one; run `npx playwright install chromium` after upgrading.
- `playwright.config.ts` uses the shared `createPlaywrightConfig`; the duplicated SMTP/SFTP test servers are gone (use `testing` from utils).

### Fixed
- Request/response logs in a failed test's attachment masked headers and request bodies but not response bodies, so a login response carrying `access_token` or an echoed password was written to the report; response bodies are masked too.
- **Types:** `MockServer` verb methods and `RouteMockDefinition.body` collapsed to `unknown`, so `(req) => ...` handlers were implicitly `any` under `strict`. Handlers are now typed (`MockBodyFn`, `RouteMockBodyFn`).
