# referenced-automation-api

Reusable Playwright-based API testing framework. Every HTTP method, header/body CRUD (JSON, XML, form, multipart+files), query/path params, every common auth strategy, pagination, a response wrapper you traverse like `response.get('data[0].name')`, and three ways to mock an API - see [Mocking](#mocking).

Built on `@playwright/test`'s `APIRequestContext` - no separate HTTP client library. Depends on [`referenced-automation-utils`](../referenced-automation-utils) for env config, logging, object-path traversal, and JSON Schema validation.

## Quick start

```bash
./scripts/setup.sh      # npm ci (scripts/setup.bat on Windows)
npm test                 # runs this package's own test suite against an in-process mock server
```

`setup.sh`/`setup.bat` work from a completely fresh clone of the whole repo family, in any order: this repo depends on `referenced-automation-utils`, so if `../shared-packages/automation-referenced-automation-utils-*.tgz` doesn't exist yet, setup builds it automatically from `../referenced-automation-utils` (cloning nothing on its own - that sibling repo must already be checked out next to this one). See [Distributing this package](#distributing-this-package) for the layout this assumes.

```ts
import { ApiClient, BearerAuth } from '@automation/referenced-automation-api';
import { request } from '@playwright/test';

const context = await request.newContext();
const client = new ApiClient(context, 'https://api.example.com')
  .setHeader('X-Client', 'my-suite')
  .setAuth(new BearerAuth('my-token'));

const response = await client.get('/users/{id}', { pathParams: { id: 42 } });
response.expectStatus(200);
console.log(response.get('data.name'));       // dot/bracket path traversal
console.log(response.get('data.roles[0]'));
```

Or use the ready-made Playwright Test fixture and skip context/client setup entirely:

```ts
import { test, expect } from '@automation/referenced-automation-api';

test('gets a user', async ({ apiClient }) => {
  const response = await apiClient.get('/users/{id}', { pathParams: { id: 42 } });
  expect(response.status()).toBe(200);
});
```

## What's included

| Capability | How |
|---|---|
| All HTTP methods | `client.get/post/put/patch/delete/head/options(path, options)` |
| Header CRUD | `setHeader`/`setHeaders`/`getHeader`/`removeHeader`/`clearHeaders` on the client (persists across calls); per-call `options.headers` overrides without mutating the client |
| Query params | `options.queryParams` - array values are sent as repeated `key=a&key=b` |
| Path params | `options.pathParams` substitutes `{name}` placeholders, e.g. `/users/{id}` |
| JSON body | `options.json` |
| XML body | `options.xml` - pass an object (serialized via `fast-xml-parser`) or a raw string |
| Form body | `options.form` - `application/x-www-form-urlencoded` |
| Multipart body | `options.multipart` - text fields and files (`buffer` or `filePath`) in the same object |
| Auth | `BasicAuth`, `BearerAuth` (static token or async supplier), `ApiKeyAuth` (header or query), `OAuth2ClientCredentials` (fetches + caches + auto-refreshes a token) |
| Pagination | `paginateByPageNumber()` and `paginateByCursor()` - collect every page into one array |
| Response traversal | `response.get('data.users[0].name')`, `.has(path)`, `.require(path)` |
| Response validation | `response.expectStatus()`, `.expectValue()`, `.expectSchema()` (JSON Schema via `ajv`), or just assert on `.status()`/`.get()`/`.body()` with Playwright's own `expect` |
| Response format handling | Body is parsed based on `Content-Type` - JSON and XML both come back as a traversable object; anything else stays as text |

## Mocking

Three separate tools, for three separate situations - all under `src/mock/`, all exported from the package root.

### 1. `MockServer` - a real HTTP server for API-level tests

For testing an `ApiClient` (or anything else that makes real HTTP calls) against a backend that doesn't exist yet, or one you don't want a test depending on. It's a real Express server on a random local port - no browser involved, so it's equally useful outside Playwright's browser-based tests.

```ts
import { MockServer } from '@automation/referenced-automation-api';

const server = new MockServer();
await server.start();

server.get('/users/:id', (req) => ({ id: Number(req.params.id), name: 'Ada' }));
server.post('/users', (req) => ({ id: 999, ...(req.body as object) }), { status: 201 });
server.route({
  method: 'POST',
  path: '/orders',
  handler: (req) => ({ status: 201, headers: { 'X-Created': 'true' }, body: { id: 1, ...(req.body as object) } }),
});

// point an ApiClient (or anything else) at server.baseUrl
await server.stop();
```

`.get/.post/.put/.patch/.delete(path, body, options?)` cover the common case - `body` can be a static value or `(req) => value`; `options` sets `status`/`headers`/`delayMs`. `.route()` is the escape hatch when status/headers need to be computed together with the body. Unregistered routes get a JSON 404 automatically; `.reset()` clears everything registered so far. A `mockServer` fixture is also available from this package's own `test` (`import { test } from '@automation/referenced-automation-api'`) - started before the test, stopped after, only paid for by tests that ask for it.

### 2. `mockApiRoute` - runtime data mocking for UI tests, via `page.route()`

For a UI test where the page fetches data at runtime and you want to control what it gets back, without standing up a backend at all. This is a thin, ergonomic wrapper around Playwright's own `page.route()` - built here so it's one `import` away from any UI project that depends on this package (`referenced-automation-ui`, `referenced-automation-sap`, `referenced-automation-ui-api`, or any consuming project's own UI suite):

```ts
import { mockApiRoute } from '@automation/referenced-automation-api';

await mockApiRoute(page, {
  url: '**/api/profile',
  method: 'GET',
  body: { name: 'Mocked Ada' }, // or a function: (request) => ({...})
});

await page.goto('/profile');
// the page's own fetch('/api/profile') resolves with the mocked body above
```

`url` takes the same glob/regex `page.route()` does; `method` (optional) scopes the mock to one HTTP method - a different method on the same URL falls through to the real network untouched (`route.fallback()`), rather than being silently swallowed. `mockApiRoutes(page, [...])` registers several at once; `unmockApiRoute(page, url)` removes one. See `referenced-automation-ui-api`'s `tests/mockedProfile.spec.ts` for a full working example - the same page rendered once against its real `/api/profile` endpoint and once with `mockApiRoute` overriding it.

### 3. `recordApiTraffic` / `playApiRecording` - record real traffic once, replay it forever

For turning a real session against a real backend into a deterministic, offline test fixture. `recordApiTraffic` intercepts requests matching a pattern, lets them reach the real network unchanged (so the test's behaviour during recording is genuinely real), and captures every request/response pair; `playApiRecording` replays a saved recording later with no backend involved at all.

```ts
import { recordApiTraffic, playApiRecording } from '@automation/referenced-automation-api';

// once, against the real backend:
const handle = await recordApiTraffic(page, 'https://api.example.com/**', 'recordings/checkout.json');
await page.goto('https://example.com/checkout');
// ... exercise the flow you want captured ...
await handle.save(); // writes recordings/checkout.json

// later, offline, no real backend needed:
await playApiRecording(page, 'recordings/checkout.json', 'https://api.example.com/**');
await page.goto('https://example.com/checkout'); // served entirely from the recording
```

Matching during playback defaults to method + exact URL (including query string); pass `{ matchBy: 'url' }` to ignore method. A request inside the pattern with no matching recorded entry falls through to the real network by default (`route.fallback()`) - pass `onUnmatched` to handle that case yourself instead (e.g. fail the test loudly rather than silently hitting a real backend). Response bodies are stored base64-encoded, so binary responses (images, gzip) round-trip correctly.

## Environments

Same pattern as every other repo in this family: `.env.<name>` files + `ENV=<name>`. See `.env.qa`/`.env.stage`/`.env.dev` here, and `referenced-automation-utils`' README for the full explanation. `playwright.config.ts` reads `API_BASE_URL` from the active env file and uses it as `use.baseURL`.

```bash
ENV=stage npx playwright test
```

## Allure reporting

Every test run writes raw results to `allure-results/` via the `allure-playwright` reporter (pure JS/TS, no extra runtime needed). Turning those into the viewable HTML report needs a JRE on `PATH` (Allure's report generator is a Java tool) - that's why it's a separate step, not part of `npm test` itself:

```bash
npm test               # also writes allure-results/
npm run allure:report  # generates allure-report/ and opens it in a browser
```

Or split the two steps (e.g. to generate in CI and open locally): `npm run allure:generate`, then `npm run allure:open`.

## Distributing this package

Same as `referenced-automation-utils` - build a local tarball until a private registry is available:

```bash
./scripts/create-package.sh   # writes ../shared-packages/referenced-automation-api-<version>.tgz
```

## IDE setup

Same as `referenced-automation-utils`: VS Code prompts for the recommended extensions on open; IntelliJ/WebStorm ships ESLint/Prettier wired in plus an `npm: test` run configuration. No plugin installs needed for either IDE.

## Testing this package itself

`tests/support/testServer.ts` spins up a tiny in-process Express server exposing every feature above (all methods, auth-protected routes, paginated endpoints, an XML echo endpoint, a multipart upload endpoint). It's intentionally not a live third-party API - fast, deterministic, and works offline/in CI without flaking on network conditions outside this repo's control.

`tests/mock/` is the working test suite for the three mocking tools themselves: `mockServer.spec.ts` (static/dynamic bodies, custom status/headers, `reset()`, `delayMs`), `routeMock.spec.ts` (`mockApiRoute` against a `*.invalid` host, so a pass genuinely proves interception rather than a lucky real response), and `recorder.spec.ts` (records against the real `testServer`, stops it, then proves playback still works with no backend at all).

`tests/utilsMethods.spec.ts` demos every reusable method `@automation/referenced-automation-utils` exports, framed the way this repo actually uses them - generating request payloads (`randomUtils`), masking/hashing sensitive data (`crypto`), asserting on response dates (`dateUtils`), traversing/validating a real response body (`getPath`/`validateSchema`), and verifying a mocked endpoint's side effects against a real DB row (`SqliteClient`), a real sent email (`SmtpClient`), and a real uploaded file (`SftpClient`) - not just "does the function work in isolation." (No `referenced-automation-sap` demo here - its Fiori/UI5 helpers are `Page`-based and this repo's tests don't drive a browser, so there's no real use case for it.)
