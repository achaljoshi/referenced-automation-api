# referenced-automation-api

Reusable Playwright-based API testing framework. Every HTTP method, header/body CRUD (JSON, XML, form, multipart+files), query/path params, every common auth strategy, pagination, and a response wrapper you traverse like `response.get('data[0].name')`.

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

## Environments

Same pattern as every other repo in this family: `.env.<name>` files + `ENV=<name>`. See `.env.qa`/`.env.stage`/`.env.dev` here, and `referenced-automation-utils`' README for the full explanation. `playwright.config.ts` reads `API_BASE_URL` from the active env file and uses it as `use.baseURL`.

```bash
ENV=stage npx playwright test
```

## Distributing this package

Same as `referenced-automation-utils` - build a local tarball until a private registry is available:

```bash
./scripts/create-package.sh   # writes ../shared-packages/referenced-automation-api-<version>.tgz
```

## IDE setup

Same as `referenced-automation-utils`: VS Code prompts for the recommended extensions on open; IntelliJ/WebStorm ships ESLint/Prettier wired in plus an `npm: test` run configuration. No plugin installs needed for either IDE.

## Testing this package itself

`tests/support/testServer.ts` spins up a tiny in-process Express server exposing every feature above (all methods, auth-protected routes, paginated endpoints, an XML echo endpoint, a multipart upload endpoint). It's intentionally not a live third-party API - fast, deterministic, and works offline/in CI without flaking on network conditions outside this repo's control.
