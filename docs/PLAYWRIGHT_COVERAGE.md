# Playwright API testing: what the framework covers

Read against the Playwright documentation (intro, API testing, authentication, network, mocking, test assertions,
annotations, parameterization, best practices). For every capability: **has** (was already here), **added** (the gap this
round closed), **native** (use Playwright's own - nothing to wrap), or **n/a** (browser-only).

## Requests

| Playwright capability | Framework | |
|---|---|---|
| `request.get/post/put/patch/delete/head/fetch` | `ApiClient.get/post/put/patch/delete/head/options/request` | has |
| `data` JSON / `form` / `multipart` bodies | `json` / `form` / `multipart` / `xml` / `rawBody` options | has |
| `params`, `headers`, `timeout`, `failOnStatusCode` | `queryParams` (arrays repeat), `headers`, `timeoutMs`, `failOnStatusCode` | has |
| `maxRedirects` | `RequestOptions.maxRedirects` (`0` = what curl does without `-L`) | **added** |
| `maxRetries` (network-level retries) | `RequestOptions.maxRetries` | **added** |
| `ignoreHTTPSErrors` per call | `RequestOptions.ignoreHTTPSErrors` | **added** |
| `extraHTTPHeaders`, `baseURL` | `setHeader(s)` persist on the client; `ApiClient(context, baseUrl)`, `setBaseUrl()` | has / **added** |
| `storageState` (API <-> browser) | `apiFor({ storageState })`; ui-api's `authState` | **added** |
| `request.newContext()` per user | `apiFor({ auth, headers, baseUrl })` fixture - disposed after the test | **added** |
| Path parameters | `pathParams` with `{placeholders}` | has |
| Response body: `json()`, `text()`, `body()` | `response.body()`, `.text()`, `.bytes()`, `.get(path)`, `.require(path)`, `.has(path)` | has / **added** (`bytes`) |
| `response.headersArray()` / `Set-Cookie` | `response.cookies()` parsed | **added** |
| `response.ok()`, `status()` | `response.ok()`, `.status()`, `.statusText()` | has |
| Not in Playwright: retrying 429/503, `Retry-After` | `RequestOptions.retry` / `setRetryPolicy` (idempotent verbs only; POST needs an idempotency key) | **added** |
| Not in Playwright: idempotency keys | `idempotencyKey: true | 'my-key'` | **added** |
| Not in Playwright: waiting for background work | `client.poll(...)`, `pollUntil`, `PollTimeoutError` carrying the last response | **added** |
| Downloads / binary | `client.download(path, { saveTo })` | **added** |
| GraphQL | `client.graphql(query, variables)`, `response.expectNoGraphqlErrors()` | **added** |
| SOAP | `client.soap(path, { action, body, version })` | **added** |
| Concurrency for bulk setup | `mapConcurrent(items, limit, fn)` | **added** |
| One client "as another user" | `client.scoped({ headers, auth, baseUrl })` shares the connection and log | **added** |

## Authentication

| Strategy | Framework | |
|---|---|---|
| Basic, Bearer, API key (header or query) | `BasicAuth`, `BearerAuth`, `ApiKeyAuth` | has |
| OAuth2 client credentials | `OAuth2ClientCredentials` (cached, refreshed before expiry) | has |
| OAuth2 password grant + refresh token | `OAuth2PasswordAuth` | **added** |
| Self-signed JWT (test environments) | `JwtAuth` (HS256) | **added** |
| Request signing | `HmacAuth` (method + path + query + body hash) | **added** |
| Session cookie from a login form | `SessionCookieAuth` | **added** |
| Several at once | `CompositeAuth` | **added** |
| Shared login state per worker / roles | `apiFor()`; storage state files (see the UI repo) | **added** |

## Assertions

| Playwright | Framework | |
|---|---|---|
| `expect(response).toBeOK()` | native (raw `APIResponse` via `response.raw`) | native |
| `expect(value).toBe/toEqual/toMatchObject/...`, `expect.soft`, `expect.poll`, `toPass`, custom messages | native - `expect` is Playwright's, exported unchanged plus matchers | native |
| `expect.extend` custom matchers | `toHaveStatus`, `toBeSuccessful`, `toHaveJsonPath`, `toMatchJsonSubset`, `toMatchJsonSchema`, `toHaveResponseHeader`, `toRespondWithin` on an `ApiResponse` | **added** |
| Fluent checks for helpers/fixtures | `expectStatus`, `expectHeader`, `expectContentType`, `expectBodyContains`, `expectMatches`, `expectArrayLength`, `expectResponseTimeUnder`, `expectSchema` | has / **added** |
| `toMatchSnapshot` for stable bodies | `response.snapshotText(maskKeys)` (sorted keys, volatile fields masked) | **added** |

## Test structure

| Playwright | Framework | |
|---|---|---|
| Fixtures | `apiClient`, `apiFor`, `cleanup`, `vars`, `apiScenario`, `mockServer`, `correlationId`, `attachExchangesOnFailure` | has / **added** |
| Teardown of what a test created | `cleanup.add(name, undo)` - newest first, runs on failure, one failing undo does not stop the rest | **added** |
| Trace / report evidence on failure | every call (credentials masked) attached as `api-exchanges.txt` when a test fails; `toCurl()` to reproduce | **added** |
| Parameterized tests | plain `for` loops in specs, `csvUtils` from utils; Gherkin `Scenario Outline` | has / **added** |
| Annotations, tags, `--grep` | native (`@smoke`, `@regression` in titles; the converter adds `@api`) | native |
| Projects / sharding / retries / reporters | `createPlaywrightConfig` in utils | has |
| Mocking | `MockServer`, `mockApiRoute`, `recordApiTraffic` / `playApiRecording` | has |
| Gherkin | `registerApiSteps`, `registerDataSteps` (playwright-bdd 9.2.1); sample features in `features/` | **added** |
| Record and play | no recorder for APIs - give `api-curl-to-playwright` your curl commands | **added** |

## Browser-only (see the UI repo)

Locators, actions, dialogs, frames, clock, emulation, screenshots, ARIA snapshots, HAR, WebSocket mocking, service workers:
`n/a` here - the UI framework covers them.

## Deliberately not wrapped

- **`expect.poll` / `toPass`**: Playwright's own are right for polling a value inside a test. `client.poll` exists for the
  case where the thing polled is "a request until its response says done", with the last response in the error.
- **A load-test runner**: `expectResponseTimeUnder` is a coarse SLA check, not performance testing. Use k6/Gatling.
- **Digest authentication**: Playwright's `httpCredentials` (a context option) covers it; pass it through `apiFor` if needed.
