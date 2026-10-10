import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertCurl, parseCurl, parseCurlFile, splitCommands, tokenize } from '../src/curl';
import { toCurl } from '../src/curl/toCurl';

const squash = (code: string) => code.replace(/[\s,]+/g, '');

test.describe('parseCurl', () => {
  test('method, url and headers; the method is inferred from the data', () => {
    const get = parseCurl(`curl 'https://x.test/a' -H 'Accept: application/json' -H "X-Num: 7"`);
    expect(get).toMatchObject({ method: 'GET', url: 'https://x.test/a' });
    expect(get.headers).toEqual([
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Num', value: '7' },
    ]);
    expect(parseCurl(`curl https://x.test -d a=1`).method).toBe('POST');
    expect(parseCurl(`curl https://x.test -X DELETE`).method).toBe('DELETE');
    expect(parseCurl(`curl -I https://x.test`).method).toBe('HEAD');
    expect(parseCurl(`curl -F a=b https://x.test`).method).toBe('POST');
  });

  test("quoting: single, double with escapes, ANSI-C $'...', backslashes, attached values, bundled switches", () => {
    expect(tokenize(`curl 'it'\\''s' "say \\"hi\\"" $'tab\\there\\n' a\\ b`).tokens).toEqual([
      'curl',
      "it's",
      'say "hi"',
      'tab\there\n',
      'a b',
    ]);
    expect(parseCurl(`curl -XPOST -H'X-A: 1' -d'{"a":1}' https://x.test`)).toMatchObject({
      method: 'POST',
      url: 'https://x.test',
    });
    const bundled = parseCurl(`curl -sSL -k https://x.test`);
    expect(bundled).toMatchObject({ followRedirects: true, insecure: true, url: 'https://x.test' });
    expect(bundled.warnings).toEqual([]);
    expect(parseCurl(`curl --request=PUT --header='A: b' https://x.test`)).toMatchObject({
      method: 'PUT',
      headers: [{ name: 'A', value: 'b' }],
    });
  });

  test('data: pieces are joined with &, -G moves them to the query, --json implies JSON, @file is kept as a file', () => {
    expect(parseCurl(`curl https://x.test -d a=1 -d b=2`).body).toBe('a=1&b=2');
    expect(parseCurl(`curl -G https://x.test -d a=1 --data-urlencode 'q=a b&c'`).url).toBe(
      'https://x.test?a=1&q=a%20b%26c',
    );
    const json = parseCurl(`curl https://x.test --json '{"a":1}'`);
    expect(json).toMatchObject({ method: 'POST', json: true, body: '{"a":1}' });
    expect(parseCurl(`curl https://x.test -d @body.json`).bodyFile).toBe('body.json');
    expect(parseCurl(`curl https://x.test --data-raw '@not-a-file'`).body).toBe('@not-a-file');
  });

  test('auth, cookies, user agent, referer, timeout and form uploads', () => {
    const parsed = parseCurl(
      `curl -u ada:secret -b 'a=b' -A 'agent/1' -e https://ref.test -m 2.5 -F 'name=Ada' -F 'f=@/tmp/x.txt;type=text/plain;filename=y.txt' https://x.test`,
    );
    expect(parsed.basicAuth).toEqual({ user: 'ada', password: 'secret' });
    expect(parsed.cookie).toBe('a=b');
    expect(parsed.timeoutSeconds).toBe(2.5);
    expect(parsed.headers).toEqual([
      { name: 'User-Agent', value: 'agent/1' },
      { name: 'Referer', value: 'https://ref.test' },
    ]);
    expect(parsed.form).toEqual([
      { name: 'name', value: 'Ada' },
      { name: 'f', value: '/tmp/x.txt', file: true, mimeType: 'text/plain', fileName: 'y.txt' },
    ]);
    expect(parseCurl(`curl --oauth2-bearer tok https://x.test`).headers).toEqual([
      { name: 'Authorization', value: 'Bearer tok' },
    ]);
  });

  test('$VAR and ${VAR} references are kept as placeholders and listed; single quotes keep them literal', () => {
    const parsed = parseCurl(`curl "$BASE/users?k=\${API_KEY}" -H 'X: $NOT_A_VAR'`);
    expect(parsed.url).toBe('${BASE}/users?k=${API_KEY}');
    expect(parsed.variables).toEqual(['BASE', 'API_KEY']);
    expect(parsed.headers[0]?.value).toBe('$NOT_A_VAR');
  });

  test('options that do not change the request are ignored silently; unknown ones are reported', () => {
    const quiet = parseCurl(
      `curl -s -v -i --compressed -o out.txt --retry 3 --connect-timeout 5 https://x.test`,
    );
    expect(quiet.warnings).toEqual([]);
    expect(parseCurl(`curl --frobnicate https://x.test`).warnings).toEqual([
      'Unsupported curl option --frobnicate was ignored',
    ]);
  });

  test('bad input fails with a clear message', () => {
    expect(() => parseCurl('wget https://x.test')).toThrow(/Not a curl command/);
    expect(() => parseCurl('curl -X GET')).toThrow(/no URL/);
    expect(() => parseCurl(`curl 'https://x.test`)).toThrow(/Unterminated single quote/);
    expect(() => parseCurl('curl https://x.test -H')).toThrow(/-H needs a value/);
  });

  test("Chrome's 'Copy as cURL (cmd)' form (caret escapes) is understood", () => {
    const cmd = [
      'curl ^"https://x.test/api^" ^',
      '  -H ^"content-type: application/json^" ^',
      '  --data-raw ^"^{^\\^"name^\\^":^\\^"Ada^\\^"^}^"',
    ].join('\n');
    const [command] = splitCommands(cmd);
    const parsed = parseCurl(command as string);
    expect(parsed.url).toBe('https://x.test/api');
    expect(parsed.method).toBe('POST');
    expect(JSON.parse(parsed.body as string)).toEqual({ name: 'Ada' });
  });

  test('splitCommands joins continuation lines and keeps quoted newlines inside a command', () => {
    const commands = splitCommands(
      `# note\ncurl https://a.test \\\n  -H 'X: 1'\n\ncurl https://b.test -d '{\n  "a": 1\n}'\n`,
    );
    expect(commands).toHaveLength(2);
    expect(parseCurl(commands[1] as string).body).toBe('{\n  "a": 1\n}');
  });
});

test.describe('parseCurlFile directives', () => {
  const file = `
# a plain comment is ignored
# name: Create
# expect: 201
# expect-json: name = "Ada"
# expect-json: tags = ["a","b"]
# expect-json: id
# expect-header: content-type ~ json
# expect-header: x-id = 7
# expect-body-contains: created
# expect-max-ms: 800
# schema: schemas/user.json
# save: userId = data.id
# tag: smoke regression
curl -X POST https://x.test/users -d '{}'

# flow: Onboarding
curl https://x.test/a
curl https://x.test/b
# flow: end
curl https://x.test/c
`;

  test('every directive is read, flows span the commands after them until "# flow: end"', () => {
    const { entries, problems } = parseCurlFile(file);
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(4);
    expect(entries[0]?.directives).toMatchObject({
      name: 'Create',
      expect: '201',
      maxMs: 800,
      schema: 'schemas/user.json',
      save: [{ variable: 'userId', path: 'data.id' }],
      tags: ['@smoke', '@regression'],
      expectBodyContains: ['created'],
    });
    expect(entries[0]?.directives.expectJson).toEqual([
      { path: 'name', value: 'Ada', present: false },
      { path: 'tags', value: ['a', 'b'], present: false },
      { path: 'id', present: true },
    ]);
    expect(entries[0]?.directives.expectHeader).toEqual([
      { name: 'content-type', value: 'json', contains: true },
      { name: 'x-id', value: '7', contains: false },
    ]);
    expect(entries.map((e) => e.flow)).toEqual([undefined, 'Onboarding', 'Onboarding', undefined]);
    expect(entries.map((e) => e.line)).toEqual([15, 18, 19, 21]);
  });

  test('a bad directive or an unreadable command is reported with its line, and reading continues', () => {
    const { entries, problems } = parseCurlFile(
      `# expect: banana\ncurl https://ok.test\n# expect-max-ms: -1\n# save: nope\ncurl 'unterminated\n`,
    );
    expect(entries.map((e) => e.parsed.url)).toEqual(['https://ok.test']);
    expect(problems.join('\n')).toMatch(/line 1: "# expect: banana"/);
    expect(problems.join('\n')).toMatch(/line 3: "# expect-max-ms: -1"/);
    expect(problems.join('\n')).toMatch(/line 4: "# save: nope"/);
    expect(problems.join('\n')).toMatch(/line 5: Unterminated single quote/);
  });

  test('a file with no commands is an error naming the file', () => {
    expect(() => convertCurl('# nothing here\n', { source: 'empty.curl' })).toThrow(
      /No curl commands found in empty.curl/,
    );
  });
});

test.describe('generated tests', () => {
  const convert = (text: string, options: Partial<Parameters<typeof convertCurl>[1]> = {}) =>
    convertCurl(text, { source: 'x.curl', ...options });

  test('the call maps onto the framework: verb, path, query, headers, json body; the host moves to API_BASE_URL', () => {
    const { code, origins, warnings } = convert(
      `curl -X POST 'https://api.test/v1/users?role=admin&role=dev&page=2' -H 'Content-Type: application/json' -H 'X-Trace: t1' -d '{"name":"Ada","n":3,"ok":true,"nested":{"list":[1,"a"]}}'`,
    );
    expect(code).toContain("apiClient.post('/v1/users'");
    expect(code).toContain("role: ['admin', 'dev']");
    expect(code).toContain("page: '2'");
    expect(code).toContain("'X-Trace': 't1'");
    expect(code).toContain("name: 'Ada'");
    expect(code).toContain('n: 3');
    expect(code).toContain('ok: true');
    expect(code).not.toContain("'Content-Type'");
    expect(code).toContain('maxRedirects: 0');
    expect(origins).toEqual(['https://api.test']);
    expect(warnings).toEqual([]);
    expect(code).toContain('API_BASE_URL');
  });

  test('credentials are NEVER written into the test: they come from the environment', () => {
    const secrets = ['sk-live-123', 'hunter2', 'basic-pass', 'cookie-secret', 'key-abc', 'tok-xyz'];
    const { code, envVars } = convert(
      [
        `curl https://api.test/a -H 'Authorization: Bearer sk-live-123'`,
        `curl https://api.test/b -u ada:basic-pass`,
        `curl https://api.test/c -H 'X-API-Key: key-abc'`,
        `curl https://api.test/d -b 'sid=cookie-secret'`,
        `curl https://api.test/e?access_token=tok-xyz -d '{"user":"ada","password":"hunter2","profile":{"apiKey":"nested-secret"}}' -H 'Content-Type: application/json'`,
      ].join('\n'),
    );
    for (const secret of [...secrets, 'nested-secret'])
      expect(code, `leaked ${secret}`).not.toContain(secret);
    expect(code).toContain("new BearerAuth(env.get('API_TOKEN'))");
    expect(code).toContain("new BasicAuth(env.get('API_USER'), env.get('API_PASSWORD'))");
    expect(code).toContain("new ApiKeyAuth('X-API-Key', env.get('API_KEY'))");
    expect(code).toContain("Cookie: env.get('API_COOKIE')");
    expect(code).toContain("password: env.get('API_PASSWORD')");
    expect(code).toContain("apiKey: env.get('API_KEY')");
    expect(code).toContain("access_token: env.get('API_ACCESS_TOKEN')");
    expect(envVars).toEqual(
      expect.arrayContaining([
        'API_TOKEN',
        'API_USER',
        'API_PASSWORD',
        'API_KEY',
        'API_COOKIE',
        'API_ACCESS_TOKEN',
      ]),
    );
  });

  test('a Basic Authorization header is decoded into BasicAuth with env vars - the base64 is not kept either', () => {
    const encoded = Buffer.from('ada:lovelace').toString('base64');
    const { code, warnings } = convert(
      `curl https://api.test/a -H 'Authorization: Basic ${encoded}'`,
    );
    expect(code).not.toContain(encoded);
    expect(code).toContain("new BasicAuth(env.get('API_USER'), env.get('API_PASSWORD'))");
    expect(warnings.join()).toMatch(/set API_USER and API_PASSWORD/);
  });

  test('--param names more values that must come from the environment', () => {
    const { code } = convert(
      `curl https://api.test/a -H 'X-Tenant: acme-prod' -d '{"accountNumber":"12345678"}' -H 'Content-Type: application/json'`,
      {
        params: [
          { pattern: /tenant/i, envVar: 'TENANT' },
          { pattern: /^accountNumber$/, envVar: 'ACCOUNT' },
        ],
      },
    );
    expect(code).toContain("'X-Tenant': env.get('TENANT')");
    expect(code).toContain("accountNumber: env.get('ACCOUNT')");
    expect(code).not.toContain('acme-prod');
    expect(code).not.toContain('12345678');
  });

  test('`# secret: inline` writes deliberately fake credentials into the test', () => {
    const { code } = convert(
      `# secret: inline\ncurl https://api.test/a -H 'Authorization: Bearer not-a-real-token'`,
    );
    expect(code).toContain("new BearerAuth('not-a-real-token')");
    expect(code).not.toContain('env.get');
  });

  test('shell variables become environment reads, including inside bodies and URLs', () => {
    const { code, envVars } = convert(
      `curl "https://api.test/users/$USER_ID" -H "X-Region: $REGION" -d "{\\"id\\":\\"$USER_ID\\"}" -H 'Content-Type: application/json'`,
    );
    expect(code).toContain("`/users/${env.get('USER_ID')}`");
    expect(code).toContain("'X-Region': env.get('REGION')");
    expect(code).toContain("id: env.get('USER_ID')");
    expect(envVars).toEqual(['REGION', 'USER_ID']);
  });

  test('bodies: form fields, repeated form names, XML, raw text, JSON-without-header (warned), files', () => {
    expect(convert(`curl https://api.test/f -d 'a=1&b=two%20words'`).code).toContain(
      "form: {\n        a: '1',\n        b: 'two words',",
    );
    const repeated = convert(`curl https://api.test/f -d 'a=1&a=2'`);
    expect(repeated.code).toContain("rawBody: 'a=1&a=2'");
    expect(repeated.warnings.join()).toMatch(/repeats a field name/);
    expect(
      convert(`curl https://api.test/x -H 'Content-Type: application/xml' -d '<a/>'`).code,
    ).toContain("xml: '<a/>'");
    expect(
      convert(`curl https://api.test/x -H 'Content-Type: application/soap+xml' -d '<a/>'`).code,
    ).toContain("'Content-Type': 'application/soap+xml'");
    expect(
      convert(`curl https://api.test/t -H 'Content-Type: text/plain' -d 'hello'`).code,
    ).toContain("rawBody: 'hello'");
    const guessed = convert(`curl https://api.test/j -d '{"a":1}'`);
    expect(guessed.code).toContain('json: {');
    expect(guessed.warnings.join()).toMatch(
      /looks like JSON but the command has no JSON Content-Type/,
    );
    const file = convert(
      `curl https://api.test/j -H 'Content-Type: application/json' -d @payload.json`,
    );
    expect(file.code).toContain("json: JSON.parse(fs.readFileSync('payload.json', 'utf8'))");
    expect(file.code).toContain("import * as fs from 'node:fs';");
    expect(
      convert(`curl https://api.test/u -F 'a=b' -F 'f=@./x.bin;type=application/zip'`).code,
    ).toContain("f: { filePath: './x.bin', mimeType: 'application/zip' }");
  });

  test('browser noise headers are dropped (and said so); --keep-all-headers keeps them', () => {
    const text = `curl https://api.test/a -H 'accept: application/json' -H 'user-agent: Mozilla' -H 'sec-fetch-mode: cors' -H 'accept-language: en' -H 'x-keep: yes'`;
    const dropped = convert(text);
    expect(dropped.code).toContain("accept: 'application/json'");
    expect(dropped.code).toContain("'x-keep': 'yes'");
    expect(dropped.code).not.toContain('Mozilla');
    expect(dropped.warnings.join()).toMatch(/Dropped 3 header/);
    expect(convert(text, { keepAllHeaders: true }).code).toContain('Mozilla');
  });

  test('redirects: -L follows, otherwise maxRedirects 0 like curl; --follow-redirects overrides', () => {
    expect(convert('curl -L https://api.test/a').code).not.toContain('maxRedirects');
    expect(convert('curl https://api.test/a').code).toContain('maxRedirects: 0');
    expect(convert('curl https://api.test/a', { followRedirects: true }).code).not.toContain(
      'maxRedirects',
    );
  });

  test('timeout, insecure TLS, unusual methods and path braces are carried or flagged', () => {
    const result = convert(`curl -k -m 3 -X PROPFIND 'https://api.test/a/{id}'`);
    expect(result.code).toContain("apiClient.request('PROPFIND'");
    expect(result.code).toContain('timeoutMs: 3000');
    expect(result.warnings.join('\n')).toMatch(/IGNORE_HTTPS_ERRORS/);
    expect(result.warnings.join('\n')).toMatch(/not one of the ApiClient's verbs/);
    expect(result.warnings.join('\n')).toMatch(/path contains \{name\}/);
  });

  test('more than one host keeps full URLs (API_BASE_URL cannot stand for both); --keep-host forces it', () => {
    const two = convert(`curl https://one.test/a\ncurl https://two.test/b`);
    expect(two.code).toContain("apiClient.get('https://one.test/a'");
    expect(two.code).toContain("apiClient.get('https://two.test/b'");
    expect(two.warnings.join()).toMatch(/2 different hosts/);
    expect(convert('curl https://one.test/a', { keepHost: true }).code).toContain(
      "apiClient.get('https://one.test/a'",
    );
    expect(convert('curl localhost:3000/a').origins).toEqual(['http://localhost:3000']);
  });

  test('assertions from directives: status forms, json, header, body, timing, schema, default 2xx', () => {
    const { code } = convert(
      [
        '# expect: 201',
        '# expect-json: a.b = 1',
        '# expect-json: list = [1,2]',
        '# expect-json: flag = true',
        '# expect-json: gone = null',
        '# expect-json: present',
        '# expect-header: etag ~ W/',
        '# expect-body-contains: ok',
        '# expect-max-ms: 250',
        '# schema: s.json',
        'curl https://api.test/a',
        '# expect: 200,204',
        'curl https://api.test/b',
        '# expect: 4xx',
        'curl https://api.test/c',
        '# expect: 2xx',
        'curl https://api.test/d',
        'curl https://api.test/e',
      ].join('\n'),
    );
    expect(code).toContain(').toBe(201);');
    expect(code).toContain("expect(response.get('a.b')).toBe(1);");
    expect(code).toContain("expect(response.get('list')).toEqual([1, 2]);");
    expect(code).toContain("expect(response.get('flag')).toBe(true);");
    expect(code).toContain("expect(response.get('gone')).toBe(null);");
    expect(code).toContain("expect(response.has('present')).toBe(true);");
    expect(code).toContain("expect(response.header('etag')).toContain('W/');");
    expect(code).toContain("expect(response.text()).toContain('ok');");
    expect(code).toContain('expect(response.durationMs).toBeLessThan(250);');
    expect(code).toContain("response.expectSchema(JSON.parse(fs.readFileSync('s.json', 'utf8')));");
    expect(code).toContain('expect([200, 204]).toContain(response.status());');
    expect(code).toContain('expect(Math.floor(response.status() / 100)).toBe(4);');
    expect(squash(code)).toContain(
      squash('expect(response.ok(), `Expected a 2xx response but got ${response.status()}'),
    );
  });

  test('flows: saved values flow into later commands; unknown {{names}} are flagged; save outside a flow is ignored; titles stay unique', () => {
    const { code, warnings, tests } = convert(
      [
        '# flow: Onboarding',
        '# name: Create',
        '# save: id = data.id',
        'curl -X POST https://api.test/users',
        '# name: Read',
        'curl "https://api.test/users/{{id}}?x={{nope}}"',
        '# flow: end',
        '# save: ignored = a',
        'curl https://api.test/same',
        'curl https://api.test/same',
      ].join('\n'),
    );
    expect(tests).toBe(3);
    expect(code).toContain("let id = '';");
    expect(code).toContain("id = String(response.require('data.id'));");
    expect(code).toContain('`/users/${id}`');
    expect(code).toContain("await test.step('Create'");
    expect(warnings.join('\n')).toMatch(/\{\{nope\}\} is not a variable saved by an earlier/);
    expect(warnings.join('\n')).toMatch(/"# save: ignored" above the command on line 9 was ignored/);
    expect(code).toContain("test('GET /same @api'");
    expect(code).toMatch(/test\('GET \/same \(line 10\) @api'/);
  });

  test('--flow makes everything one test; skip becomes test.skip; tags and the import modules are applied', () => {
    const { code, tests } = convert(
      '# tag: smoke\n# skip: later\ncurl https://api.test/a\ncurl https://api.test/b',
      {
        singleFlow: true,
        title: 'My API',
        tag: '@contract',
        testImport: './base',
        apiImport: './framework',
      },
    );
    expect(tests).toBe(1);
    expect(code).toContain("test.describe('My API'");
    expect(code).toContain("test.skip('My API @contract @smoke'");
    expect(code).toContain("import { expect, test } from './base';");
    expect(code).not.toContain('./framework'); // no auth class used, so nothing to import from it
  });

  test('titles and strings with quotes, backslashes and template markers are escaped', () => {
    const { code } = convert(
      "# name: it's `odd`\ncurl https://api.test/a -H 'X-T: a\\b ${notvar} `tick`' -d '{\"s\":\"it'\\''s\"}'",
    );
    expect(code).toContain("test('it\\'s `odd` @api'");
    expect(code).toContain("'X-T': 'a\\\\b ${notvar} `tick`'");
  });

  test('toCurl output is read back by parseCurl to the same request (round trip)', () => {
    const original = {
      method: 'POST',
      url: 'https://x.test/a?b=1',
      headers: { Accept: 'application/json', 'X-N': "it's" },
      body: '{"a":"it\'s"}',
    };
    const parsed = parseCurl(toCurl(original, { redact: false }));
    expect(parsed).toMatchObject({ method: 'POST', url: original.url, body: original.body });
    expect(parsed.headers).toEqual([
      { name: 'Accept', value: 'application/json' },
      { name: 'X-N', value: "it's" },
    ]);
  });

  test('the committed generated example is exactly what the converter produces from curl/examples.curl', () => {
    const root = path.join(__dirname, '..');
    const regenerated = convertCurl(
      fs.readFileSync(path.join(root, 'curl', 'examples.curl'), 'utf8'),
      {
        source: 'curl/examples.curl',
        testImport: '../support/generatedTest',
        apiImport: '../../src/index',
      },
    );
    const committed = fs.readFileSync(
      path.join(root, 'tests', 'generated', 'examples.spec.ts'),
      'utf8',
    );
    // the committed file is formatted by prettier; compare ignoring whitespace and commas
    expect(squash(committed)).toBe(squash(regenerated.code));
  });
});

test.describe('api-curl-to-playwright command', () => {
  const cli = path.join(__dirname, '..', 'dist', 'cli', 'curlToTests.js');
  const run = (args: string[], input?: string, cwd?: string) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, cwd });

  test('writes a spec file, reports what to set, and exits 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-cli-'));
    const input = path.join(dir, 'orders.curl');
    fs.writeFileSync(
      input,
      `# name: List\ncurl https://api.test/orders -H 'Authorization: Bearer abc'\n`,
    );
    const out = path.join(dir, 'out');
    const result = run([input, '--out', out]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('wrote');
    expect(result.stderr).toContain('API_TOKEN');
    expect(result.stderr).toContain('API_BASE_URL should be https://api.test');
    const generated = fs.readFileSync(path.join(out, 'orders.spec.ts'), 'utf8');
    expect(generated).toContain("test('List @api'");
    expect(generated).not.toContain('abc');
  });

  test('--stdout, standard input and a folder of files', () => {
    const fromStdin = run(['-', '--stdout'], 'curl https://api.test/a\n');
    expect(fromStdin.status).toBe(0);
    expect(fromStdin.stdout).toContain("apiClient.get('/a'");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-cli-'));
    fs.writeFileSync(path.join(dir, 'a.curl'), 'curl https://api.test/a\n');
    fs.writeFileSync(path.join(dir, 'b.sh'), 'curl https://api.test/b\n');
    fs.writeFileSync(path.join(dir, 'ignored.md'), 'curl https://api.test/c\n');
    const out = path.join(dir, 'out');
    expect(run([dir, '--out', out]).status).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual(['a.spec.ts', 'b.spec.ts']);
  });

  test('--strict fails when something could not be converted exactly; usage errors say what is wrong', () => {
    const strict = run(['-', '--stdout', '--strict'], 'curl --frobnicate https://api.test/a\n');
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('--strict');
    expect(run([]).stderr).toContain('Give a curl file');
    expect(run(['x.curl', '--nope']).stderr).toContain('Unknown option --nope');
    expect(run(['x.curl', '--param', 'broken']).stderr).toContain(
      '--param needs <name-regex>=<ENV_VAR>',
    );
    expect(run(['/no/such/file.curl']).status).toBe(1);
    expect(run(['--help']).stdout).toContain('api-curl-to-playwright');
    expect(run(['-', '--stdout'], '# nothing\n').stderr).toContain('No curl commands found');
  });
});
