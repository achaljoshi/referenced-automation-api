# referenced-automation-api

Reusable Playwright-based API testing framework. Every HTTP method, header/body CRUD (JSON, XML, form, multipart+files), query/path params, every common auth strategy, pagination, a response wrapper you traverse like `response.get('data[0].name')`, and three ways to mock an API - see [Mocking](#mocking).

Built on `@playwright/test`'s `APIRequestContext` - no separate HTTP client library. Depends on [`referenced-automation-utils`](../referenced-automation-utils) for env config, logging, object-path traversal, and JSON Schema validation.

## Quick start

```bash
./scripts/setup.sh      # npm ci
npm test                 # runs this package's own test suite against an in-process mock server
```

```powershell
.\scripts\setup.bat     # Windows PowerShell: npm ci (plain `scripts\setup.bat` works only in cmd.exe)
npm test
```

First time on Windows? Read [Windows first run](#windows-first-run) - it lists the errors a fresh checkout usually hits and what fixes each. Every environment variable is listed in the [Configuration reference](#configuration-reference).

`setup.sh`/`setup.bat` run `npm ci`. They first run `npm config set registry "$NPM_REGISTRY_URL"` when that variable is set, so every package - the `@automation/*` ones too (`referenced-automation-utils`), each **by the version in `package.json`** - is fetched from your organisation's npm registry. If those packages are not published there yet, or you want to try a change you have not published, run `./scripts/setup.sh --local` (`.\scripts\setup.bat --local` in PowerShell): it builds the sibling repos this one depends on - they must be checked out next to this one - into `../shared-packages` and installs those instead, without touching `package.json` or the lockfile. See [Publishing a package](#publishing-a-package-to-the-registry-jfrog-artifactory) and [Using a package without a registry](#using-a-package-without-a-registry-local-generation).

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

## Windows first run

Everything below is PowerShell, started in the folder this repo is checked out in (`cd C:\Projects\referenced-automation-api`). Pure API tests need no browser; the few tests that use a Playwright `page` (`tests/mock/routeMock.spec.ts`, `tests/mock/recorder.spec.ts`) need Chromium once.

```powershell
.\scripts\setup.bat                    # npm ci. In PowerShell the .\ is required; scripts\setup.bat works only in cmd.exe
# or, when the packages are not in your registry yet and referenced-automation-utils is checked out NEXT TO this repo:
.\scripts\setup.bat --local            # builds ..\referenced-automation-utils, keeps its .tgz in ..\shared-packages, installs it
npm run build                          # tsc -> dist/ (npm test does this too, through "pretest")
npx playwright install chromium        # once, for the tests that use a page
npm test                               # bddgen + every test; all of them should pass
```

Run less than everything (forward slashes, also on Windows):

```powershell
npx playwright test tests/baseUrl.spec.ts          # one file
npx playwright test tests/baseUrl.spec.ts:25       # the test at line 25
npx playwright test -g "joinUrl"                   # by (part of) the test title
npx playwright test --project=chromium             # one project
npm run test:bdd                                   # only the Gherkin features (it runs bddgen first)
```

Set an environment variable for one run, then undo it (`ENV=stage npx playwright test` is bash syntax and fails in PowerShell):

```powershell
$env:ENV = "stage"; $env:LOG_LEVEL = "debug"; npx playwright test tests/baseUrl.spec.ts
Remove-Item Env:ENV, Env:LOG_LEVEL
```

Turn curl commands into tests, inside this repo (after `npm run build`; see [curl in, tests out](#curl-in-tests-out-api-curl-to-playwright)):

```powershell
npm run curl-to-tests -- curl/examples.curl
Get-Clipboard | npm run curl-to-tests -- - --stdout
```

Common first errors:

| What you see | Why | Fix |
|---|---|---|
| `'tsc' is not recognized as an internal or external command` (or `'playwright'`, `'eslint'`, `'rimraf'`, `'bddgen'`) | There is no `node_modules`: the install did not run or stopped with an error. | Run `.\scripts\setup.bat` again and read the **first** error it prints (registry not reachable, `NPM_REGISTRY_URL` wrong, an `@automation/*` version not published - then use `--local`). `Test-Path node_modules\.bin\tsc.cmd` must say `True`. |
| `Cannot find module '...\dist\...'` (`dist\index.js`, `dist\cli\curlToTests.js`) | The TypeScript has not been compiled yet: `dist/` is git-ignored and built on demand. | `npm run build`. (`npm test` builds first on its own.) If the path is inside `node_modules\@automation\referenced-automation-utils\dist`, that dependency was installed without being built: build and pack it by running `.\scripts\setup.bat --local` (needs `..\referenced-automation-utils` checked out next to this repo). |
| `Error: No tests found` | The file pattern matched nothing. Backslash paths (`tests\baseUrl.spec.ts`) are the usual cause: Playwright takes the argument as a regular expression, where `\b` is not a path separator. Running from another folder, or a file that is not under `tests/` and named `*.spec.ts`, does the same. | `npx playwright test tests/baseUrl.spec.ts` (forward slashes), from the repo root; or select by title with `-g "title"`. |
| `Illegal characters in path` mentioning `*.tgz` | An old `clean` script (`rimraf dist *.tgz`): Windows does not expand the `*` and rimraf passed it on as a file name. | Fixed: the script is `rimraf --glob dist "*.tgz"`. Pull the latest version of the repo and run `npm run clean` again. |
| `'api-curl-to-playwright' is not recognized as an internal or external command` | A package's own `bin` commands are not linked into its own `node_modules/.bin`; `npx api-curl-to-playwright` works only in a project that **depends on** this package. | Inside this repo use `npm run curl-to-tests -- curl/examples.curl` (note the `--`) or `node dist/cli/curlToTests.js curl/examples.curl` after `npm run build`. |
| `'ENV' is not recognized` / `The term 'ENV=qa' is not recognized` | `NAME=value command` is bash syntax. | PowerShell: `$env:ENV = "qa"; npx playwright test`. cmd.exe: `set ENV=qa && npx playwright test`. |
| `browserType.launch: Executable doesn't exist at ...\ms-playwright\chromium-...` | Chromium was never downloaded; a test that uses a `page` needs it. | `npx playwright install chromium` (behind a mirror: set `PLAYWRIGHT_DOWNLOAD_HOST`). |
| `npm.ps1 cannot be loaded because running scripts is disabled on this system` | PowerShell's execution policy blocks npm's `.ps1` launcher. | Run `npm.cmd run build` (or use cmd.exe), or ask your administrator about the execution policy - this repo does not change it. |
| A setting in a `.env` file seems ignored | Either the file name is wrong (the secret file for `ENV=qa` is `.env.qa.local`; a file called `.env.local` is never read) or the variable is one that is read from the **real environment only**. | Check the "Read from" line of that variable in [`.env.example`](.env.example) and the [Configuration reference](#configuration-reference). |
| `LOG_LEVEL=debug` in `.env.qa` changes nothing | The logger reads `LOG_LEVEL` (and `LOG_TO_FILE`, `LOG_FILE`, `LOG_FILE_PER_WORKER`, `NO_COLOR`, `FORCE_COLOR`, `RANDOM_SEED`, `CI`) from `process.env` once, when it starts; `.env` files are not read for them. | Set it where the process starts: `$env:LOG_LEVEL = "debug"; npm test` (undo: `Remove-Item Env:LOG_LEVEL`), or a CI variable. |

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

Inside this repo run the converter through the npm script `curl-to-tests` (everything after `--` goes to the tool):

```bash
npm run curl-to-tests -- curl/examples.curl             # writes tests/generated/examples.spec.ts
npm run curl-to-tests -- curl/ --out tests/api --flow    # a folder of curl files, each one a single flow
pbpaste | npm run curl-to-tests -- - --stdout            # straight from the clipboard (macOS)
```

```powershell
npm run curl-to-tests -- curl/examples.curl
npm run curl-to-tests -- curl/ --out tests/api --flow
Get-Clipboard | npm run curl-to-tests -- - --stdout     # straight from the clipboard (Windows PowerShell)
```

`node dist/cli/curlToTests.js <arguments>` does the same without npm; both need `npm run build` first (`npm test` builds on its own). **Why not `npx api-curl-to-playwright`?** A package's own `bin` commands are not linked into its own `node_modules/.bin`, so that form works only from a project that depends on this package (it then finds the command in that project's `node_modules/.bin`); run inside this repo it fails with `'api-curl-to-playwright' is not recognized as an internal or external command` on Windows. A project that depends on this package runs `npx api-curl-to-playwright curl/my-api.curl`.

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
- **Secrets the converter recognises are read from the environment, not written into the file** - it is not a guarantee that no secret is written. Recognised: anything NAMED like a password (`password`, `passwd`, `pwd`), `pin`, `otp`, token, secret (`client_secret`), credential, api key (`x-api-key`), authorization, signature, session or cookie - in a header, query, form field, JSON key or XML element/attribute - plus `-u user:pass`, and a token-looking URL path segment (a JWT, a long opaque string, the value after `/token/`). They become `env.get('API_...')` getters; the command prints which variables to set (the names and the rule behind them are in [`.env.example`](.env.example): `API_USER`, `API_PASSWORD`, `API_TOKEN`, `API_KEY`, and `API_<NAME>` for any other, such as `API_COOKIE`; keep them in `.env.<ENV>.local`, template [`.env.local.example`](.env.local.example)). A secret under any OTHER name, or one in free text, is written as it was in the curl command - `--param 'accountNumber=ACCOUNT'` adds names, and **review the generated file before committing it**. `# secret: inline` writes deliberately fake credentials (a wrong-password test) as they are.
- The command **will not overwrite** an existing spec (it may hold edits): it stops with a message and writes nothing unless you pass `--force`. A spec written inside a Playwright project reads its `.env.<ENV>` files from that project's folder, whatever directory the run starts in. A full URL (several hosts, `--keep-host`) is sent with `absoluteUrl: true`.
- Without `-L` curl does not follow redirects, so the test sets `maxRedirects: 0` (`--follow-redirects` changes that). `$VAR` / `${VAR}` in a command become environment reads. Browser-added headers (sec-fetch-*, user-agent, accept-language) are dropped unless `--keep-all-headers`.
- Anything that could not be converted exactly is listed (`note:`), and `--strict` turns that into a failure. `toCurl(request)` goes the other way - a pasteable command from a request, credentials masked.

`curl/examples.curl` is a worked example (`npm run curl-to-tests -- curl/examples.curl`); `tests/generated/examples.spec.ts` is what it produces and runs in this repo's suite (a test fails if the committed file drifts from the converter's output).

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

## Calling the API from the remote desktop

> **Status: NOT VERIFIED on a real RDP host.** This was only tested against the stand-in agent from `@automation/referenced-automation-utils` (`testing.StandInAgent`, a Node program that speaks the same protocol over the same mailbox folder). The Windows parts - `mstsc`, the PowerShell agent, the redirected drive - have never run for this feature. The first run on a real host is the verification (`automation-remote doctor`, then `automation-remote check`).

**What it is.** The tests run on a test machine (for example an AWS WorkSpace) where the UI app is reachable, but the APIs are reachable only from a remote Windows desktop host that you reach by RDP. With the remote host enabled, `ApiClient` sends each HTTP call through `remote.RemoteHost.http()`: the request is written as a file into a mailbox folder that is redirected into the RDP session, an agent there makes the call and writes the answer back. Auth providers (bearer, API key, OAuth2 token calls ...), retries, polling, pagination, the correlation id header and the masked exchange log work unchanged.

**Keys** (`.env.<env>`; secrets only in `.env.<env>.local`):

| Key | Meaning |
|---|---|
| `REMOTE_*` (`REMOTE_ENABLED=true`, `REMOTE_RDP_HOST`, `REMOTE_RDP_USER`, `REMOTE_RDP_PASSWORD`, `REMOTE_ALLOW` ...) | The RDP host and the agent: the main ones are in [`.env.example`](.env.example), all of them in the [utils `.env.example`](https://github.com/achaljoshi/referenced-automation-utils/blob/master/.env.example) and utils `docs/REMOTE_DESKTOP.md`. `REMOTE_ALLOW` must include `http` (it does by default). |
| `REMOTE_API_BASE_URL` | The API's base URL **as seen from the remote host** (it may differ from the one the test machine uses). Falls back to `API_BASE_URL`. |
| `API_VIA_REMOTE` | `true`: the `apiClient` and `apiFor` fixtures call from the remote host. Default `false`. |

**An explicit remote client** (the normal `apiClient` stays local):

```ts
import { test, expect } from '@automation/referenced-automation-api';

test('the order API answers on the internal network', async ({ remoteApiClient }) => {
  const response = await remoteApiClient.get('/orders/{id}', { pathParams: { id: 42 } });
  expect(response).toHaveStatus(200);
  expect(response.get('status')).toBe('SHIPPED');
});
```

`remoteApiClient` fails with a message naming the `REMOTE_*` keys when `REMOTE_ENABLED` is not `true`. The `remoteHost` fixture (worker-scoped, closed when the worker ends) gives the `RemoteHost` itself, or `undefined` when the remote host is off, for DB or other steps next to the API calls. Without the fixtures: `new ApiClient(new RemoteRequestContext(host, { baseURL }).asApiRequestContext(), baseUrl)`.

**BDD features and generated tests need no change**: run them with `API_VIA_REMOTE=true` and every step that uses `apiClient` calls from the remote host. (The sample features in this repo override `apiClient` to hit an in-process server; your own project does not.)

**Failures name the remote operation**: `remote host operation "http" ...` with `AGENT_STALE` (the RDP session or agent is gone), `TIMEOUT`, or `DENIED` (`REMOTE_ALLOW must include http`); the error has a `code` and the original `RemoteError` as `cause`.

**Limits**
- No multipart/file uploads, `storageState`, client certificates or `httpCredentials` on the remote path: they throw an error that says to run that call from the test machine (use the normal `apiClient`, or `apiFor` without `API_VIA_REMOTE`).
- Request and response bodies cross the mailbox as files (base64 inside JSON) and every request waits for a poll cycle (about 0.2-0.5 s). Keep JSON/text bodies modest; do not download large files this way.
- The agent handles one request at a time, so parallel calls queue; use few workers.
- `maxRedirects: 0` returns the 3xx itself; any other value follows redirects (the agent cannot cap their number). The host's proxy is not used. A repeated `Set-Cookie` crosses as one joined header and is split again, which is best effort.
- Tokens and headers in flight are readable in the mailbox folder (`.remote-mailbox/`, git-ignored) on the test machine: keep it in a folder only the test user can read.
- Details of the transport, security trade-offs and troubleshooting: utils `docs/REMOTE_DESKTOP.md`.

## Correlation and logging

The built-in `test` has an auto fixture that gives every test a correlation ID. `ApiClient` sends it as the `X-Correlation-Id` header on every request and logs each call (e.g. `GET /users/1 -> 200 (41ms) cid=ad9e928b` - query strings stripped, secrets redacted), so one failing test can be traced from the CI log into the API gateway's logs by grepping a single value. Use `CORRELATION_HEADER` to read the header name.

## Environments

Same pattern as every other repo in this family: `.env.<name>` files + `ENV=<name>`. See `.env.qa`/`.env.stage`/`.env.dev` here, and `referenced-automation-utils`' README for the full explanation. `playwright.config.ts` reads `API_BASE_URL` from the active env file and uses it as `use.baseURL`. The `apiClient` fixture is built on Playwright's own `request` fixture, so the project's `use` options (`ignoreHTTPSErrors`, `proxy`, `extraHTTPHeaders`, `httpCredentials`, `clientCertificates`, timeouts) apply to it and to `apiFor` clients, and its base URL is `use.baseURL`, else `API_BASE_URL` from the `.env.<ENV>` files next to the Playwright config (not the working directory, so an IDE run and CI agree).

```bash
ENV=stage npx playwright test                       # bash / zsh
```

```powershell
$env:ENV = "stage"; npx playwright test             # PowerShell (NAME=value command is bash syntax)
Remove-Item Env:ENV                                 # undo it for the rest of this window
```

`ENV=stage npx playwright test` fails in PowerShell and cmd.exe (`set ENV=stage && npx playwright test`). Not every key can live in a `.env` file: `LOG_LEVEL`, `RANDOM_SEED`, `CI` and the other **real environment only** keys are read straight from `process.env` - the [Configuration reference](#configuration-reference) and [`.env.example`](.env.example) say which. The secret file for `ENV=stage` is `.env.stage.local` (never `.env.local`); the template is [`.env.local.example`](.env.local.example).

## Configuration reference

Every environment variable this repo reads - directly, or through the shared `createPlaywrightConfig` / `loadEnv` / logger code of [`referenced-automation-utils`](https://github.com/achaljoshi/referenced-automation-utils) - in the order of [`.env.example`](.env.example), which documents each one in full (valid values, whether a `.env` file or only the real environment is read, an example). `tests/envDocs.spec.ts` fails when this table, `.env.example` and the code drift apart. Secrets (the **YES** rows) belong in `.env.<ENV>.local` (template: [`.env.local.example`](.env.local.example)) or the CI secret store, never in a committed file.

**Shared keys** (marked "shared" below) are implemented in utils and mean the same in every repo of the family: the Playwright run settings, logging, `ENV`, the `REMOTE_*` keys. Utils documents them in its own [`.env.example`](https://github.com/achaljoshi/referenced-automation-utils/blob/master/.env.example) and README ("Configuration reference"), together with the keys this repo does not use (`BASE_URL`, the mainframe `S3270_PATH` / `TN3270_TIMEOUT_MS`, the `REMOTE_*` keys not listed here). **Repo-specific keys** (marked "repo-specific") exist only in this API suite: `API_VIA_REMOTE`, `REMOTE_API_BASE_URL`, the converter credentials `API_USER` / `API_PASSWORD` / `API_TOKEN` / `API_KEY` / `API_COOKIE` (any other secret the converter finds is `API_<NAME>`), the sample-feature keys and the script and pipeline keys. `API_BASE_URL` is the shared base-URL key under this repo's name.

"Read from: real environment only" keys (`ENV`, the logging keys, `RANDOM_SEED`, `CI`, `TZ` ...) are read straight from `process.env`: a line for one of them in a `.env` file has no effect. PowerShell: `$env:LOG_LEVEL = "debug"; npm test`, undo with `Remove-Item Env:LOG_LEVEL`; bash: `LOG_LEVEL=debug npm test`.

### Environment selection (shared)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `ENV` | Which environment to run against = which .env.&lt;name&gt; files are loaded and what is shown as "env" in the report | qa | no | no |
| `ENVIRONMENT` | Fallback name for ENV, for machines where another tool already owns ENV. ENV wins when both are set | unset (then qa) | no | no |

### Target API (shared key)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `API_BASE_URL` | Base URL of the API under test. createPlaywrightConfig makes it Playwright's baseURL (use.baseURL), which the apiClient fixture and the Gherkin steps use; the curl converter moves the host of your curl commands here. A base URL with a path (https://gw.example.com/api/v1) keeps that path in front of every request path | unset | no for the config itself; yes for any test that calls a relative path | no |

### Run selection (shared)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `BROWSER` | Which browser(s) to run. An unknown value fails at start-up with the list of valid names | chromium | no | no |
| `DEVICE` | Emulate one Playwright device instead of a desktop browser; wins over BROWSER. An unknown name fails at start-up | unset (then BROWSER decides) | no | no |
| `HEADLESS` | Run the browser without a window | true | no | no |
| `WORKERS` | How many test files run at the same time. With API_VIA_REMOTE=true the remote agent handles one request at a time, so use few workers | unset (Playwright uses half of the logical cores) | no | no |
| `RETRIES` | How often a failed test is run again before it counts as failed (a test that passes on a retry is reported as flaky) | 0 on a developer machine; 1 when the CI variable is set | no | no |
| `MAX_FAILURES` | Stop the whole run after this many failed tests | 0 | no | no |
| `SLOW_MO_MS` | Slow every browser action down so a person can watch (debugging only; browser tests, not apiClient calls) | 0 | no | no |
| `VIEWPORT_WIDTH` | Width of the browser window for desktop projects | 1280 | no | no |
| `VIEWPORT_HEIGHT` | Height of the browser window for desktop projects | 800 | no | no |
| `LOCALE` | Browser language (navigator.language, Accept-Language, date and number formats) | unset (the browser's own) | no | no |
| `TIMEZONE_ID` | Browser time zone, so date assertions do not depend on where the test machine is | unset (the machine's own) | no | no |
| `COLOR_SCHEME` | Emulated prefers-color-scheme | unset (the browser's own) | no | no |
| `IGNORE_HTTPS_ERRORS` | Accept invalid or self-signed HTTPS certificates (test environments only). Applies to the browser and to apiClient / apiFor | false | no | no |
| `TEST_ID_ATTRIBUTE` | The attribute getByTestId() looks at | data-testid | no | no |

### Timeouts, all in milliseconds (shared)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `TEST_TIMEOUT_MS` | How long one whole test may take | 30000 | no | no |
| `EXPECT_TIMEOUT_MS` | How long a web-first assertion (expect(...)) waits for its condition | 10000 | no | no |
| `ACTION_TIMEOUT_MS` | Playwright's default timeout for one action (a browser click or fill); a single API call can set its own timeoutMs | 15000 | no | no |
| `NAVIGATION_TIMEOUT_MS` | How long a browser navigation (page.goto, link clicks) waits | 30000 | no | no |
| `GLOBAL_TIMEOUT_MS` | How long the whole run may take before Playwright stops it | 0 | no | no |

### Logging (shared, real environment only)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `LOG_LEVEL` | Minimum level written to the console and the log file | info | no | no |
| `LOG_TO_FILE` | Also write the JSON-lines log file (a CI artifact). If the file cannot be created the logger carries on with the console only | true | no | no |
| `LOG_FILE` | Where the log file is written | logs/automation.log | no | no |
| `LOG_FILE_PER_WORKER` | One log file per Playwright worker (logs/automation-w2.log) instead of every worker appending to one file | false | no | no |
| `NO_COLOR` | Switch coloured console output off. Colour is already off when CI is set or the output is not a terminal | unset | no | no |
| `FORCE_COLOR` | Switch coloured console output on even in CI or when the output is piped | unset | no | no |

### Test data (shared, real environment only)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `RANDOM_SEED` | Seeds the random-data generators (the {{random:...}} placeholders in Gherkin steps, randomUtils) for every Playwright worker, so a failing run can be replayed with the same data. The seed in use is logged at start-up | unset (a different random seed every run) | no | no |

### Credentials of the curl converter and the generated tests (repo-specific)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `API_USER` | Login name for HTTP Basic auth (curl -u user:pass, or an Authorization: Basic header, which is decoded into BasicAuth) | unset | yes for a generated test that uses Basic auth | no |
| `API_PASSWORD` | Password for HTTP Basic auth, and the value of any form field / JSON key named password / passwd / pwd | unset | yes for a generated test that uses Basic auth or sends a password | YES |
| `API_TOKEN` | Bearer token (curl -H 'Authorization: Bearer ...'), sent by BearerAuth | unset | yes for a generated test that uses a Bearer token | YES |
| `API_KEY` | API key (curl -H 'X-API-Key: ...'), sent by ApiKeyAuth under the header name the command used | unset | yes for a generated test that uses an API key | YES |
| `API_COOKIE` | Cookie header (curl -b ... or -H 'Cookie: ...'): a derived name, the converter's rule applied to the header Cookie | unset | yes for a generated test that sends a cookie | YES |

### Calling the API from the remote desktop host

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `API_VIA_REMOTE` | Make the apiClient and apiFor fixtures (so Gherkin features and generated tests too) call from the remote host, with no code change | false | no (needs REMOTE_ENABLED=true) | no |
| `REMOTE_API_BASE_URL` | The API's base URL AS SEEN FROM THE REMOTE HOST (it may differ from the one the test machine uses); used by the remoteApiClient fixture | unset (then API_BASE_URL) | no | no |
| `REMOTE_ENABLED` | Master switch for the remote host | false | no | no |
| `REMOTE_RDP_HOST` | Host name or address of the RDP host (no scheme, path or spaces) | unset | yes when REMOTE_ENABLED=true | no |
| `REMOTE_RDP_PORT` | RDP port of the host | 3389 | no | no |
| `REMOTE_RDP_USER` | Login for the RDP host. May carry the domain as DOMAIN\user (do not double-quote a value with backslashes, see the TIP above) | unset | yes with REMOTE_AGENT_START=alternate-shell (this machine logs in for you); no for startup / manual | no |
| `REMOTE_RDP_PASSWORD` | Password for REMOTE_RDP_USER. Handed to mstsc through cmdkey only while it connects | unset | yes with REMOTE_AGENT_START=alternate-shell | YES |
| `REMOTE_DB_PROVIDER` | The .NET DbProviderFactories invariant name used for database steps on the host (an API suite does not need it unless your own code runs DB steps there) | unset | yes for database steps on the host | no |
| `REMOTE_DB_CONNECTION_STRING` | The database connection string AS THE HOST uses it | unset | yes for database steps on the host | YES |

### Sample features (repo-specific)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `FEATURE_SAMPLE_TOKEN` | The bearer token the sample feature features/authentication.feature sends (the in-process test server accepts the fallback) | expected-token (the fallback written in the feature) | no | no |
| `FEATURE_SAMPLE_REGION` | The region the sample feature features/scenario-data.feature reads to show the {{env:NAME\|fallback}} placeholder | eu-west (the fallback written in the feature) | no | no |

### Set by the machine, not by you (shared)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `CI` | CI systems set this (GitLab: CI=true). It raises the retries default, forbids test.only, keeps all test output and turns console colour off | unset | no (do not set it by hand unless you want the CI behaviour locally) | no |
| `TEST_WORKER_INDEX` | Playwright sets this for every worker (0, 1, 2, ...); the logger prints it as [w2] and uses it for LOG_FILE_PER_WORKER. Do not set it yourself | unset outside a Playwright worker | no | no |
| `TZ` | The time zone of the Node process (dates, logs). Node itself reads it, and only from the real environment - a line in a .env file is NOT applied | the machine's own time zone | no | no |

### Setup scripts and the CI pipeline (repo-specific)

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `NPM_REGISTRY_URL` | The npm registry that scripts/setup, create-package and publish-package install from. They run `npm config set registry` with it; the pipeline does the same | unset (npm keeps the registry it already uses; publish-package refuses to run without it) | no for setup, yes for publish-package and for the pipeline | no |
| `USE_LOCAL_PACKAGES` | Same as passing --local to scripts/setup: build the sibling repos (referenced-automation-utils) and install their .tgz files instead of the registry versions | unset | no | no |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | Set BY scripts/create-package --local for its own npm commands so no browser binaries are downloaded; Playwright's installer reads it. You can set it yourself to skip the download in any install | unset (set to 1 by create-package --local) | no | no |
| `PLAYWRIGHT_DOWNLOAD_HOST` | CI/CD variable of the pipeline: a mirror of Playwright's browser download host, for networks that cannot reach the real one | unset (Playwright uses its own CDN) | no | no |
| `AUDIT_RUN_GATES` | CI/CD variable of the manual `audit` job: when set, the audit also runs lint, typecheck, test and security (slow) | unset | no | no |

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
   export NPM_REGISTRY_URL="<your registry URL>"
   ```
   ```powershell
   $env:NPM_REGISTRY_URL = "<your registry URL>"        # PowerShell; cmd.exe: set NPM_REGISTRY_URL=<your registry URL>
   ```
5. **Publish** - a dry run first:
   ```bash
   ./scripts/publish-package.sh --dry-run     # builds the package and lists what would be uploaded
   ./scripts/publish-package.sh               # uploads it
   ```
   ```powershell
   .\scripts\publish-package.bat --dry-run     # Windows PowerShell (in cmd.exe: scripts\publish-package.bat)
   .\scripts\publish-package.bat
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

To see the whole chain work from the registry (no `--local`): set `NPM_REGISTRY_URL`, publish `utils`, `api`, `ui`, `sap` **in that order** (`./scripts/publish-package.sh --dry-run`, then without `--dry-run`, in each repo - PowerShell: `.\scripts\publish-package.bat --dry-run`; the first publish uses the current version, 1.0.0), confirm with `npm view @automation/referenced-automation-<name> versions --registry "$NPM_REGISTRY_URL"`, then in a consumer run `rm -rf node_modules && ./scripts/setup.sh` (PowerShell: `Remove-Item -Recurse -Force node_modules` and then `.\scripts\setup.bat`) and check `npm ls @automation/referenced-automation-utils` and the `resolved` address in `package-lock.json`. The full walkthrough is [section 4.3 of the cross-repo guide](https://github.com/achaljoshi/referenced-automation-utils/blob/master/CROSS_REPO_GUIDE.md#43-first-rollout-publish-everything-then-install-from-the-registry).

## Using a package without a registry (local generation)

Use this when the packages are not in a registry yet, or you want to try a change before publishing it. Nothing in `package.json` or the lockfile changes.

**Automatic - when the repos are checked out next to each other:**

```bash
./scripts/setup.sh --local
```

```powershell
.\scripts\setup.bat --local          # Windows PowerShell (in cmd.exe: scripts\setup.bat --local)
```

It builds the sibling repos this one depends on (`referenced-automation-utils`) with their own `scripts/create-package.sh --local`, keeps the `.tgz` files in `../shared-packages` and installs them.

**Manual - generating a tarball and placing it yourself** (for example when the consuming repo is on another machine):

1. Generate a tarball of each package this repo needs, in that package's own repo (`--local` builds what it depends on in turn, without needing the registry):
   ```bash
   (cd ../referenced-automation-utils && ./scripts/create-package.sh --local)
   ```
   ```powershell
   Push-Location ..\referenced-automation-utils; .\scripts\create-package.bat --local; Pop-Location
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

`tests/envDocs.spec.ts` keeps [`.env.example`](.env.example), the [Configuration reference](#configuration-reference) table and [`.env.local.example`](.env.local.example) in step with the code (every variable the code or the shared utils config reads is documented, nothing else is), and `tests/windowsDocs.spec.ts` checks that every `bin` of this package has an npm script, that no document shows `npx <this package's own command>` without saying it is for a dependent project, that the Windows first-run section exists, and runs `npm run curl-to-tests -- --help` for real.

`tests/utilsContract.spec.ts` is a thin check that what this package imports from `@automation/referenced-automation-utils` is still exported there; the behaviour of utils itself (crypto, dates, random data, DB, e-mail, SFTP ...) is tested in the utils package, which owns it.
