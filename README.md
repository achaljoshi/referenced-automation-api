# referenced-automation-api

Reusable Playwright-based API testing framework. Every HTTP method, header/body CRUD (JSON, XML, form, multipart+files), query/path params, every common auth strategy, pagination, a response wrapper you traverse like `response.get('data[0].name')`, and three ways to mock an API - see [Mocking](#mocking).

Built on `@playwright/test`'s `APIRequestContext` - no separate HTTP client library. Depends on [`referenced-automation-utils`](../referenced-automation-utils) for env config, logging, object-path traversal, and JSON Schema validation.

## Quick start

```bash
./scripts/setup.sh      # npm ci (scripts/setup.bat on Windows)
npm test                 # runs this package's own test suite against an in-process mock server
```

`setup.sh`/`setup.bat` run `npm ci`. They first run `npm config set registry "$NPM_REGISTRY_URL"` when that variable is set, so every package - the `@automation/*` ones too (`referenced-automation-utils`), each **by the version in `package.json`** - is fetched from your organisation's npm registry. If those packages are not published there yet, or you want to try a change you have not published, run `./scripts/setup.sh --local` (`scripts\setup.bat --local` on Windows): it builds the sibling repos this one depends on - they must be checked out next to this one - into `../shared-packages` and installs those instead, without touching `package.json` or the lockfile. See [Publishing a package](#publishing-a-package-to-the-registry-jfrog-artifactory) and [Using a package without a registry](#using-a-package-without-a-registry-local-generation).

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
| Base URL and paths | A path is joined to the client's base URL and keeps the base URL's own path: base `https://gw/api/v1` + `/users` is `https://gw/api/v1/users`. A full URL in place of a path is refused (it would take the client's auth and headers to another host) unless the call says `absoluteUrl: true` |
| Query params | `options.queryParams` - array values are sent as repeated `key=a&key=b`; a query written in the path (`/search?a=1`) is merged with them |
| Path params | `options.pathParams` substitutes `{name}` placeholders, e.g. `/users/{id}`; a placeholder with no value throws instead of being sent as `{id}` |
| JSON body | `options.json` |
| XML body | `options.xml` - pass an object (serialized via `fast-xml-parser`) or a raw string |
| Form body | `options.form` - `application/x-www-form-urlencoded` |
| Multipart body | `options.multipart` - text fields and files (`buffer` or `filePath`) in the same object |
| Auth | `BasicAuth`, `BearerAuth` (static token or async supplier), `ApiKeyAuth` (header or query), `OAuth2ClientCredentials` (fetches + caches + auto-refreshes a token), `OAuth2PasswordAuth`, `SessionCookieAuth`. Token and login calls go through the client's own connection (proxy, TLS, timeout; they show in `exchanges()` with credentials masked), parallel requests share ONE token request / login, a `401` makes `SessionCookieAuth` log in again and resend once, and a failure message never repeats the identity provider's body |
| Pagination | `paginateByPageNumber()` and `paginateByCursor()` - collect every page into one array. Every page must be 2xx (a failing page throws with its number and status); reaching `maxPages` with more data left throws unless `allowTruncation: true`; an empty-string cursor ends the loop; a cursor that repeats throws |
| Response traversal | `response.get('data.users[0].name')`, `.has(path)`, `.require(path)` |
| Response validation | `response.expectStatus()`, `.expectValue()`, `.expectSchema()` (JSON Schema via `ajv`), or just assert on `.status()`/`.get()`/`.body()` with Playwright's own `expect` |
| Response format handling | Body is parsed based on `Content-Type` - JSON and XML both come back as a traversable object; anything else stays as text. XML values stay TEXT (`<ref>00123</ref>` is `'00123'`, not `123`) - convert in the test when you need a number |
| GraphQL | `expectNoGraphqlErrors()` needs a JSON response with `data` or `errors`: an HTML 502, an empty body or `{ "data": null }` fails instead of passing |

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

`MockServer` listens on `127.0.0.1` only (a mock must not be reachable from the runner's network); a handler that throws or rejects answers `500 { error: "Mock handler threw: ..." }` instead of leaving the request hanging; `stop()` drops open connections, so it never waits for a slow or keep-alive request, and `start()` rejects when the port is taken.

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

Credentials are redacted **as the traffic is recorded**: Authorization/Cookie/API-key style headers are masked and `Set-Cookie` is not stored, `password` / `token` / `secret` fields in JSON, form and XML bodies (request and response) are masked, and so are credentials in the URL query and token-like path segments - the file is safe to commit, and a replayed login returns the masked value. (Other secrets under names the redaction does not know are stored as they came: look at a recording before committing it.)

Matching during playback defaults to method + exact URL (including query string, compared with credentials masked on both sides); pass `{ matchBy: 'url' }` to ignore method and `{ ignoreQueryParams: ['_', /^ts/] }` to leave volatile parameters out of the comparison. A request inside the pattern with no matching recorded entry **fails** by default (`onMiss: 'fail'`): it is refused (the page sees a network error), logged, and listed in the `unmatched` array of the handle `playApiRecording` returns - it never reaches the live network, so a replay cannot quietly depend on a real backend. `onMiss: 'continue'` sends it to the real network (`route.fallback()`); `onUnmatched` handles it yourself. Response bodies are stored base64-encoded, so binary responses (images, gzip) round-trip correctly.

## Gherkin / BDD (`playwright-bdd` 9.2.1)

Business-readable API tests, with the vocabulary in this package so every project uses the same sentences:

```gherkin
Scenario: Create a user and read it back
  Given I am authenticated with the bearer token "{{env:API_TOKEN}}"
  When I send a POST request to "/users" with JSON:
    """
    { "name": "{{random:first-name}}", "roles": ["admin"] }
    """
  Then the response status is 201
  And I remember the response field "id" as "userId"
  When I send a GET request to "/users/{{userId}}"
  Then the response field "roles" contains "admin"
```

```ts
// features/steps/steps.ts
import { createBdd } from 'playwright-bdd';
import { registerApiSteps, registerDataSteps } from '@automation/referenced-automation-api';
import { test } from './fixtures';           // mergeTests(bddTest, apiTest) - see features/steps/fixtures.ts

const { Given, When, Then } = createBdd(test);
registerDataSteps({ Given, Then });          // variables, random data, dates, env
registerApiSteps({ Given, When, Then });     // requests, auth, headers, bodies, assertions, polling
```

`npm test` runs `bddgen && playwright test`; `npm run test:bdd` only the features; `BDD_TAGS` is not needed - use `--grep @smoke`.
Every string, docstring and table cell understands `{{placeholders}}` (saved values, `{{env:X|fallback}}`, `{{uuid}}`, `{{random:email}}`, `{{date:+7d}}`);
an unresolvable one fails the step. The sample features in `features/` run against the in-process server in `tests/support/testServer.ts`.
`registerDataSteps` is also in the UI package, with the SAME step texts - when a project's features use both, register it once (from either package), or the BDD tool reports ambiguous steps.

Equality steps are typed: `the response field "id" equals "1"` matches only the JSON *string* `"1"`; use `equals 1` for a number, `is true` / `is false` for booleans, and `equals "1" as text` to compare the text form of any value. `is not empty` rejects `null`, `""`, `[]` and `{}`; a number (`0` included) or `false` is a value - assert those with `equals 0` / `is false`. The polling step (`returns "x" equal to "y"`) compares the text form.

## curl in, tests out (`api-curl-to-playwright`)

There is no record-and-play for APIs, so give it the requests instead: any curl command from Postman, Chrome ("Copy as cURL"), API docs
or a terminal, in a file, with optional `# key: value` lines saying what to check.

```bash
npx api-curl-to-playwright curl/examples.curl            # writes tests/generated/examples.spec.ts
npx api-curl-to-playwright curl/ --out tests/api --flow   # a folder of curl files, each one a single flow
pbpaste | npx api-curl-to-playwright - --stdout           # straight from the clipboard (macOS)
```

```bash
# name: Create a user
# expect: 201
# expect-json: name = Ada
# save: userId = id
# flow: Onboarding
curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' -d '{"name":"Ada"}'
```

becomes - with every value in one place at the top, and the steps only referring to it:

```ts
const CONSTANTS = {                                   // what every command sends and expects
  bodies: { createAUser: { name: 'Ada' } },
  expected: { createAUser: { status: 201, json: { name: 'Ada' } } },
};
const ENDPOINTS = { users: '/users' };                // where each call goes

test('Create a user @api', async ({ apiClient }) => {
  apiClient.setAuth(new BearerAuth(env.get('API_TOKEN')));          // the token is read from the environment, not written into the test
  const response = await apiClient.post(ENDPOINTS.users, { json: CONSTANTS.bodies.createAUser, maxRedirects: 0 });
  expect(response.status(), `Unexpected status; body: ${response.text().slice(0, 500)}`).toBe(CONSTANTS.expected.createAUser.status);
  expect(response.get('name')).toBe(CONSTANTS.expected.createAUser.json.name);
});
```

Change a body, a query parameter, a header or an expected value in `CONSTANTS`; move an endpoint in `ENDPOINTS` - every step that uses it follows. Values that read the environment (passwords, tokens, anything named like a secret) are getters, so a missing variable names itself when it is used; values that only exist while a flow runs (`{{userId}}` saved from an earlier step) stay in the step. `--inline` writes everything in the steps instead.

- Calls map onto the framework: `apiClient.get/post/...`, `queryParams`, `json` / `form` / `xml` / `multipart` / `rawBody`, `BearerAuth` / `BasicAuth` / `ApiKeyAuth`, `timeoutMs`; the host moves to `API_BASE_URL` (kept in full when the commands call several hosts, or with `--keep-host`).
- **Secrets the converter recognises are read from the environment, not written into the file** - it is not a guarantee that no secret is written. Recognised: anything NAMED like a password (`password`, `passwd`, `pwd`), `pin`, `otp`, token, secret (`client_secret`), credential, api key (`x-api-key`), authorization, signature, session or cookie - in a header, query, form field, JSON key or XML element/attribute - plus `-u user:pass`, and a token-looking URL path segment (a JWT, a long opaque string, the value after `/token/`). They become `env.get('API_...')` getters; the command prints which variables to set. A secret under any OTHER name, or one in free text, is written as it was in the curl command - `--param 'accountNumber=ACCOUNT'` adds names, and **review the generated file before committing it**. `# secret: inline` writes deliberately fake credentials (a wrong-password test) as they are.
- The command **will not overwrite** an existing spec (it may hold edits): it stops with a message and writes nothing unless you pass `--force`. A spec written inside a Playwright project reads its `.env.<ENV>` files from that project's folder, whatever directory the run starts in. A full URL (several hosts, `--keep-host`) is sent with `absoluteUrl: true`.
- Without `-L` curl does not follow redirects, so the test sets `maxRedirects: 0` (`--follow-redirects` changes that). `$VAR` / `${VAR}` in a command become environment reads. Browser-added headers (sec-fetch-*, user-agent, accept-language) are dropped unless `--keep-all-headers`.
- Anything that could not be converted exactly is listed (`note:`), and `--strict` turns that into a failure. `toCurl(request)` goes the other way - a pasteable command from a request, credentials masked.

`curl/examples.curl` is a worked example; `tests/generated/examples.spec.ts` is what it produces and runs in this repo's suite (a test fails if the committed file drifts from the converter's output).

## Reusable helpers beyond the basics

`docs/PLAYWRIGHT_COVERAGE.md` maps Playwright's own API-testing capabilities to this framework and lists what was added:

```ts
await client.get('/flaky', { retry: { attempts: 4 } });                          // 429/502/503/504 with backoff and Retry-After
await client.post('/orders', { json, idempotencyKey: true, retry: { attempts: 3 } }); // safe to repeat
const done = await client.poll('GET', '/jobs/{id}', { pathParams: { id }, until: (r) => r.get('state') === 'DONE' });
// poll's default limit is 30 s, but never more than 80% of what is left of the test's timeout, and a timeout reads "Poll timed out ...; last response: ..."
await expect(response).toMatchJsonSubset({ name: 'Ada' });                       // extra matchers on an ApiResponse
const admin = await apiFor({ auth: new BearerAuth(adminToken) });                // a client for another user (keeps the project's proxy/TLS/headers; does NOT inherit the main client's Authorization/Cookie headers)
cleanup.add('order', () => client.delete('/orders/{id}', { pathParams: { id } })); // undone after the test, newest first
```

A failed test attaches every call it made as `api-exchanges.txt`; `response.exchange` and `toCurl()` reproduce one in a terminal. Credentials are masked in what is stored: header values (response `Set-Cookie` included), JSON / form / **XML** fields and elements by name (numbers too - `password: 123456`), query values and token-like URL path segments, and URLs in error messages. A call that needed the client's retry policy leaves an `api-retries` annotation on the test (`GET /flaky/x: 2 retries (503, 503, 200)`), so a green test that leaned on retries shows in the report.

## Correlation and logging

The built-in `test` has an auto fixture that gives every test a correlation ID. `ApiClient` sends it as the `X-Correlation-Id` header on every request and logs each call (e.g. `GET /users/1 -> 200 (41ms) cid=ad9e928b` - query strings stripped, secrets redacted), so one failing test can be traced from the CI log into the API gateway's logs by grepping a single value. Use `CORRELATION_HEADER` to read the header name.

## Environments

Same pattern as every other repo in this family: `.env.<name>` files + `ENV=<name>`. See `.env.qa`/`.env.stage`/`.env.dev` here, and `referenced-automation-utils`' README for the full explanation. `playwright.config.ts` reads `API_BASE_URL` from the active env file and uses it as `use.baseURL`. The `apiClient` fixture is built on Playwright's own `request` fixture, so the project's `use` options (`ignoreHTTPSErrors`, `proxy`, `extraHTTPHeaders`, `httpCredentials`, `clientCertificates`, timeouts) apply to it and to `apiFor` clients, and its base URL is `use.baseURL`, else `API_BASE_URL` from the `.env.<ENV>` files next to the Playwright config (not the working directory, so an IDE run and CI agree).

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

## Publishing a package to the registry (JFrog Artifactory)

The other repos install `@automation/referenced-automation-api` **by version** from your organisation's npm registry, so each new version has to be published there. In order:

1. **Know the registry URL.** It is the npm registry URL of your Artifactory - the one in your `~/.npmrc` and in the `NPM_REGISTRY_URL` CI/CD variable. This repo never hard-codes it; ask your platform team if you do not have it.
2. **Be allowed to publish.** Publishing needs an npm identity with deploy permission on that repository. How you authenticate npm against your Artifactory is your organisation's own procedure and is not covered here - the scripts in this repo never log in for you.
3. **Choose the version and record it.** A version can be published only once:
   ```bash
   npm version patch --no-git-tag-version      # or minor / major - changes package.json only
   ```
   Add the change to `CHANGELOG.md` and commit both.
4. **Point the scripts at the registry** (once per terminal):
   ```bash
   export NPM_REGISTRY_URL="<your registry URL>"        # Windows cmd: set NPM_REGISTRY_URL=<your registry URL>
   ```
5. **Publish** - a dry run first:
   ```bash
   ./scripts/publish-package.sh --dry-run     # builds the package and lists what would be uploaded
   ./scripts/publish-package.sh               # uploads it            (Windows: scripts\publish-package.bat)
   ```
   The script runs `npm config set registry "$NPM_REGISTRY_URL"`, builds with `create-package.sh` (clean, build, `npm pack`) and runs `npm publish <the .tgz> --registry "$NPM_REGISTRY_URL"`.
6. **Check it arrived:** `npm view @automation/referenced-automation-api versions --registry "$NPM_REGISTRY_URL"` lists the new version.

**Without the script.** `./scripts/create-package.sh` leaves `../shared-packages/automation-referenced-automation-api-<version>.tgz`, the exact file `npm publish` uploads. Publish that file yourself (`npm publish ../shared-packages/<file>.tgz --registry "$NPM_REGISTRY_URL"`), or deploy the `.tgz` into the npm repository through the Artifactory web UI (the repository's **Deploy** action - Artifactory takes the package name and version from the tarball; check with your platform team how your repository is set up), or hand it to whoever manages the repository.

**Order matters.** Publish what a package depends on first: `utils` -> `api` and `ui` -> `sap` -> the consuming repos.

## Upgrading a package: change one version

This repo lists the `@automation/*` packages it uses in `package.json` with a version range, like any other dependency:

```jsonc
"dependencies": {
  "@automation/referenced-automation-utils": "^1.0.0"
}
```

To take a newer version, **change that number** (say `"^1.3.0"`), run `npm install`, run the tests and commit `package.json` and `package-lock.json`. npm downloads the new version from the registry in `NPM_REGISTRY_URL`; nothing is built, copied or placed by hand.

- `^1.3.0` accepts any `1.x` from 1.3.0 up (what `npm update` moves to); write `1.3.0` to pin exactly.
- `npm ci` (CI, `setup.sh`) installs exactly what the lockfile records, so a version only changes when someone commits a change.
- The lockfile in this repo records the version of each `@automation/*` package but not where it came from. The first `npm install` against the real registry adds that (`resolved` and `integrity`); commit the result.
- A package that is itself depended on (`utils`, `api`, `ui`, `sap`) must be published again before its consumers can ask for the new version - see [Publishing a package](#publishing-a-package-to-the-registry-jfrog-artifactory) in that repo.

## First rollout: publish, then install from the registry

To see the whole chain work from the registry (no `--local`): set `NPM_REGISTRY_URL`, publish `utils`, `api`, `ui`, `sap` **in that order** (`./scripts/publish-package.sh --dry-run`, then without `--dry-run`, in each repo; the first publish uses the current version, 1.0.0), confirm with `npm view @automation/referenced-automation-<name> versions --registry "$NPM_REGISTRY_URL"`, then in a consumer run `rm -rf node_modules && ./scripts/setup.sh` and check `npm ls @automation/referenced-automation-utils` and the `resolved` address in `package-lock.json`. The full walkthrough is [section 4.3 of the cross-repo guide](https://github.com/achaljoshi/referenced-automation-utils/blob/master/CROSS_REPO_GUIDE.md#43-first-rollout-publish-everything-then-install-from-the-registry).

## Using a package without a registry (local generation)

Use this when the packages are not in a registry yet, or you want to try a change before publishing it. Nothing in `package.json` or the lockfile changes.

**Automatic - when the repos are checked out next to each other:**

```bash
./scripts/setup.sh --local          # Windows: scripts\setup.bat --local
```

It builds the sibling repos this one depends on (`referenced-automation-utils`) with their own `scripts/create-package.sh --local`, keeps the `.tgz` files in `../shared-packages` and installs them.

**Manual - generating a tarball and placing it yourself** (for example when the consuming repo is on another machine):

1. Generate a tarball of each package this repo needs, in that package's own repo (`--local` builds what it depends on in turn, without needing the registry):
   ```bash
   (cd ../referenced-automation-utils && ./scripts/create-package.sh --local)
   ```
   Each file is named `automation-<package>-<version>.tgz` after the version in that repo's `package.json` and lands in `../shared-packages`.
2. Leave the files in `../shared-packages`, or copy them into the consuming repo (any folder works, for example `libs/` - keep it out of git).
3. Install them, all in one command (change the folder if you copied the files elsewhere):
   ```bash
   npm install --no-save ../shared-packages/automation-referenced-automation-utils-<version>.tgz
   ```
   `--no-save` keeps `package.json` and the lockfile unchanged. Run it again after every `npm ci`, because `npm ci` removes what is not in the lockfile. When you rebuild a tarball with the same version, run the command again to pick up the new contents.
4. Build and test as usual (`npm run build`, `npm test`).

When you are done experimenting, run `npm ci` to go back to what the registry provides.

## IDE setup

Same as `referenced-automation-utils`: VS Code prompts for the recommended extensions on open; IntelliJ/WebStorm ships ESLint/Prettier wired in plus an `npm: test` run configuration. No plugin installs needed for either IDE.

## Testing this package itself

`tests/support/testServer.ts` spins up a tiny in-process Express server exposing every feature above (all methods, auth-protected routes, paginated endpoints, an XML echo endpoint, a multipart upload endpoint). It's intentionally not a live third-party API - fast, deterministic, and works offline/in CI without flaking on network conditions outside this repo's control.

`tests/mock/` is the working test suite for the three mocking tools themselves: `mockServer.spec.ts` (static/dynamic bodies, custom status/headers, `reset()`, `delayMs`), `routeMock.spec.ts` (`mockApiRoute` against a `*.invalid` host, so a pass genuinely proves interception rather than a lucky real response), and `recorder.spec.ts` (records against the real `testServer`, stops it, then proves playback still works with no backend at all).

`tests/utilsContract.spec.ts` is a thin check that what this package imports from `@automation/referenced-automation-utils` is still exported there; the behaviour of utils itself (crypto, dates, random data, DB, e-mail, SFTP ...) is tested in the utils package, which owns it.
