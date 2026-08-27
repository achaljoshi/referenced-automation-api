import { test, expect, request as playwrightRequest } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  crypto,
  dateUtils,
  randomUtils,
  jsonUtils,
  yamlUtils,
  csvUtils,
  excelUtils,
  getPath,
  setPath,
  hasPath,
  requirePath,
  validateSchema,
  SqliteClient,
  emailUtils,
  SmtpClient,
  SftpClient,
  CommonsError,
} from '@automation/referenced-automation-utils';
import { ApiClient, MockServer } from '../src';
import { startSmtpTestServer, stopSmtpTestServer, type SmtpTestServerHandle } from './support/smtpTestServer';
import { startSftpTestServer, stopSftpTestServer, type SftpTestServerHandle } from './support/sftpTestServer';

/**
 * A demo/reference suite for every reusable method
 * @automation/referenced-automation-utils exports, framed the way this repo
 * actually uses them: generating request payloads, validating response
 * bodies, and verifying side effects (a DB row, an email, an uploaded file)
 * a mocked API call is supposed to trigger - not just "does the function
 * work in isolation" (utils' own tests already prove that), but "how does
 * an API test in this repo actually reach for it."
 */

test.describe('utils: crypto - masking sensitive fields, hashing for idempotency @smoke', () => {
  test('every crypto function, applied to API request/response data', () => {
    const cardNumber = '4111111111111111';
    // The pattern this repo actually uses crypto for: never log a raw
    // sensitive value, even in a failed-assertion message.
    expect(crypto.mask(cardNumber)).toBe('************1111');

    // A stable idempotency key derived from the request body - the same
    // body always hashes to the same key, a different one never does.
    const bodyA = jsonUtils.toJson({ orderId: 1, amount: 42 });
    const bodyB = jsonUtils.toJson({ orderId: 2, amount: 42 });
    expect(crypto.sha256Hex(bodyA)).toBe(crypto.sha256Hex(bodyA));
    expect(crypto.sha256Hex(bodyA)).not.toBe(crypto.sha256Hex(bodyB));

    expect(crypto.md5Hex('x')).toMatch(/^[0-9a-f]{32}$/);
    expect(crypto.sha1Hex('x')).toMatch(/^[0-9a-f]{40}$/);
    expect(crypto.sha512Hex('x')).toMatch(/^[0-9a-f]{128}$/);

    // HMAC-signing a request, the way many APIs require for webhooks.
    const signature = crypto.hmacSha256Hex(bodyA, 'webhook-secret');
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.hmacSha1Hex(bodyA, 'webhook-secret')).toMatch(/^[0-9a-f]{40}$/);

    const token = crypto.base64Encode('client:secret');
    expect(crypto.base64Decode(token)).toBe('client:secret');
  });
});

test.describe('utils: dateUtils - asserting on API response dates, computing expiry windows @smoke', () => {
  test('every dateUtils function', () => {
    // A typical API response field: an ISO-ish date string to parse and assert on.
    const createdAt = dateUtils.parseDateTime('2026-01-15 10:30:00');
    expect(dateUtils.formatDate(createdAt)).toBe('2026-01-15');
    expect(dateUtils.formatDateTime(createdAt)).toBe('2026-01-15 10:30:00');

    // A token that expires in an hour - compute the boundary and assert a
    // request just inside it succeeds, just outside it doesn't (the same
    // shape as testing an API's actual expiry logic).
    const expiresAt = dateUtils.addHours(createdAt, 1);
    const justBefore = dateUtils.addMinutes(expiresAt, -1);
    expect(dateUtils.isBefore(justBefore, expiresAt)).toBe(true);
    expect(dateUtils.isAfter(dateUtils.addMinutes(expiresAt, 1), expiresAt)).toBe(true);

    expect(dateUtils.formatDate(dateUtils.addDays(createdAt, 30))).toBe('2026-02-14');
    expect(dateUtils.formatDate(dateUtils.addMonths(createdAt, 1))).toBe('2026-02-15');
    expect(dateUtils.daysBetween(createdAt, dateUtils.addDays(createdAt, 7))).toBe(7);

    const millis = dateUtils.toEpochMillis(createdAt);
    expect(dateUtils.formatDateTime(dateUtils.fromEpochMillis(millis))).toBe('2026-01-15 10:30:00');

    expect(dateUtils.today().isValid()).toBe(true);
    expect(dateUtils.now().isValid()).toBe(true);
    expect(dateUtils.timestampForFileName()).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });
});

test.describe('utils: randomUtils - generating request payloads @smoke', () => {
  let server: MockServer;
  let client: ApiClient;

  test.beforeAll(async () => {
    server = new MockServer();
    await server.start();
    server.post('/users', (req) => ({ id: 999, ...(req.body as object) }), { status: 201 });
    const context = await playwrightRequest.newContext();
    client = new ApiClient(context, server.baseUrl);
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test('every randomUtils function, generating a realistic request payload', async () => {
    const payload = {
      firstName: randomUtils.firstName(),
      lastName: randomUtils.lastName(),
      fullName: randomUtils.fullName(),
      email: randomUtils.email('qa'),
      phone: randomUtils.phoneNumber(),
      address: randomUtils.streetAddress(),
      city: randomUtils.city(),
      country: randomUtils.country(),
      company: randomUtils.companyName(),
      jobTitle: randomUtils.jobTitle(),
      externalId: randomUtils.uuid(),
      age: randomUtils.number(18, 90),
      referralCode: randomUtils.alphaNumeric(8),
      pin: randomUtils.numericString(4),
    };

    expect(payload.email).toMatch(/^qa/);
    expect(payload.externalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.age).toBeGreaterThanOrEqual(18);
    expect(payload.referralCode).toHaveLength(8);
    expect(payload.pin).toMatch(/^\d{4}$/);

    const response = await client.post('/users', { json: payload });
    expect(response.status()).toBe(201);
    expect(response.get('email')).toBe(payload.email);

    expect(randomUtils.futureDate(30).isAfter(dateUtils.now())).toBe(true);
    expect(randomUtils.pastDate(30).isBefore(dateUtils.now())).toBe(true);
    expect(randomUtils.creditCardNumber().replace(/\D/g, '').length).toBeGreaterThanOrEqual(12);
    expect(typeof randomUtils.faker.string.uuid).toBe('function');
  });
});

test.describe('utils: jsonUtils / yamlUtils / csvUtils / excelUtils @smoke', () => {
  let tmpDir: string;

  test.beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'api-utils-demo-'));
  });

  test.afterAll(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  test('every jsonUtils function', async () => {
    const data = { user: { name: 'Ada', roles: ['admin', 'qa'] } };
    const json = jsonUtils.toJson(data);
    expect(jsonUtils.fromJson(json)).toEqual(data);
    expect(jsonUtils.toPrettyJson(data)).toContain('\n');
    expect(jsonUtils.readAt<string>(json, 'user.name')).toBe('Ada');

    const filePath = path.join(tmpDir, 'data.json');
    await fs.promises.writeFile(filePath, json);
    expect(jsonUtils.fromJsonFile(filePath)).toEqual(data);
  });

  test('every yamlUtils function', async () => {
    const data = { environment: 'qa', retries: 2 };
    const yaml = yamlUtils.toYaml(data);
    expect(yamlUtils.fromYaml(yaml)).toEqual(data);

    const filePath = path.join(tmpDir, 'data.yaml');
    await fs.promises.writeFile(filePath, yaml);
    expect(yamlUtils.fromYamlFile(filePath)).toEqual(data);
  });

  test('every csvUtils function - a data-driven test-case source', async () => {
    const rows = [
      { username: 'ada', expectedStatus: '200' },
      { username: 'bad-user', expectedStatus: '404' },
    ];
    const csv = csvUtils.toCsv(rows);
    expect(csvUtils.parseCsv(csv)).toEqual(rows);

    const filePath = path.join(tmpDir, 'cases.csv');
    csvUtils.writeCsvFile(filePath, rows);
    expect(csvUtils.parseCsvFile(filePath)).toEqual(rows);
  });

  test('every excelUtils function', async () => {
    const rows = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ];
    const filePath = path.join(tmpDir, 'data.xlsx');
    await excelUtils.writeSheet(filePath, rows);
    expect(await excelUtils.readSheet(filePath)).toEqual(rows);
  });
});

test.describe('utils: object-path traversal and schema validation - applied directly to a real API response body @smoke', () => {
  let server: MockServer;
  let client: ApiClient;

  test.beforeAll(async () => {
    server = new MockServer();
    await server.start();
    server.get('/orders/1', { order: { id: 1, items: [{ sku: 'ABC', qty: 2 }] } });
    const context = await playwrightRequest.newContext();
    client = new ApiClient(context, server.baseUrl);
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test('every getPath/setPath/hasPath/requirePath function against response.body()', async () => {
    const response = await client.get('/orders/1');
    const body = response.body();

    expect(getPath<string>(body, 'order.items[0].sku')).toBe('ABC');
    expect(getPath(body, 'order.missing', 'fallback')).toBe('fallback');
    expect(hasPath(body, 'order.items[0].sku')).toBe(true);
    expect(hasPath(body, 'order.missing')).toBe(false);
    expect(requirePath<string>(body, 'order.items[0].sku')).toBe('ABC');

    const target = { a: { b: 1 } };
    setPath(target, 'a.c', 2);
    expect(target).toEqual({ a: { b: 1, c: 2 } });
  });

  test('validateSchema against a real response body', async () => {
    const response = await client.get('/orders/1');
    const schema = {
      type: 'object',
      required: ['order'],
      properties: {
        order: {
          type: 'object',
          required: ['id', 'items'],
          properties: { id: { type: 'number' }, items: { type: 'array' } },
        },
      },
    };
    expect(validateSchema(response.body(), schema).valid).toBe(true);
    const invalid = validateSchema({}, schema);
    expect(invalid.valid).toBe(false);
    expect(invalid.errorsText.length).toBeGreaterThan(0);
  });
});

test.describe('utils: CommonsError @smoke', () => {
  test('a typed error consuming code can catch by class, with a wrapped cause', () => {
    const cause = new Error('root cause');
    expect(() => {
      throw new CommonsError('something specific to this framework went wrong', { cause });
    }).toThrow(CommonsError);

    try {
      throw new CommonsError('wrapped', { cause });
    } catch (err) {
      expect(err).toBeInstanceOf(CommonsError);
      expect((err as CommonsError).name).toBe('CommonsError');
      expect((err as CommonsError).cause).toBe(cause);
    }
  });
});

test.describe('utils: DbClient / SqliteClient - verifying a DB side effect of a mocked API call @smoke', () => {
  let db: SqliteClient;
  let server: MockServer;
  let client: ApiClient;

  test.beforeAll(async () => {
    db = new SqliteClient(':memory:');
    await db.update('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');

    server = new MockServer();
    await server.start();
    // The mock's own handler performs the "real" side effect a live API
    // would - this is the pattern for testing "does calling this endpoint
    // actually write the row it's supposed to."
    server.route({
      method: 'POST',
      path: '/signup',
      handler: async (req) => {
        const body = req.body as { email: string };
        await db.update('INSERT INTO users (email) VALUES (?)', [body.email]);
        return { status: 201, body: { email: body.email } };
      },
    });

    const context = await playwrightRequest.newContext();
    client = new ApiClient(context, server.baseUrl);
  });

  test.afterAll(async () => {
    await server.stop();
    await db.close();
  });

  test('every SqliteClient method, verifying the API call actually persisted a row', async () => {
    const email = randomUtils.email('dbcheck');
    const response = await client.post('/signup', { json: { email } });
    expect(response.status()).toBe(201);

    const rows = await db.query<{ id: number; email: string }>('SELECT * FROM users WHERE email = ?', [email]);
    expect(rows).toHaveLength(1);

    const count = await db.queryScalar<number>('SELECT COUNT(*) FROM users');
    expect(count).toBe(1);

    const updated = await db.update('UPDATE users SET email = ? WHERE email = ?', [`updated-${email}`, email]);
    expect(updated).toBe(1);
  });
});

test.describe('utils: emailUtils / SmtpClient - verifying a notification email side effect @smoke', () => {
  let smtpServer: SmtpTestServerHandle;
  let smtp: SmtpClient;
  let server: MockServer;
  let client: ApiClient;

  test.beforeAll(async () => {
    smtpServer = await startSmtpTestServer();
    smtp = new SmtpClient({
      host: smtpServer.host,
      port: smtpServer.port,
      secure: false,
      auth: { user: smtpServer.username, pass: smtpServer.password },
    });

    server = new MockServer();
    await server.start();
    server.route({
      method: 'POST',
      path: '/signup',
      handler: async (req) => {
        const body = req.body as { email: string };
        // The "side effect" a real signup endpoint would trigger.
        await smtp.send({ from: 'noreply@example.com', to: body.email, subject: 'Welcome', text: 'Thanks for signing up' });
        return { status: 201, body: { email: body.email } };
      },
    });
    const context = await playwrightRequest.newContext();
    client = new ApiClient(context, server.baseUrl);
  });

  test.afterAll(async () => {
    await server.stop();
    smtp.close();
    await stopSmtpTestServer(smtpServer);
  });

  test('SmtpClient.verify/send and emailUtils.sendEmail, verifying the API call actually sent an email', async () => {
    await expect(smtp.verify()).resolves.toBe(true);

    const email = randomUtils.email('emailcheck');
    const response = await client.post('/signup', { json: { email } });
    expect(response.status()).toBe(201);
    expect(smtpServer.received.some((m) => m.to?.text.includes(email) && m.subject === 'Welcome')).toBe(true);

    // emailUtils.sendEmail - the one-shot alternative to SmtpClient, for a
    // test that just needs to trigger one email rather than hold a pooled
    // connection open.
    await emailUtils.sendEmail(
      { host: smtpServer.host, port: smtpServer.port, secure: false, auth: { user: smtpServer.username, pass: smtpServer.password } },
      { from: 'qa@example.com', to: 'reviewer@example.com', subject: 'One-shot', text: 'via emailUtils.sendEmail' },
    );
    expect(smtpServer.received.some((m) => m.subject === 'One-shot')).toBe(true);
  });
});

test.describe('utils: SftpClient - verifying an uploaded-file side effect @smoke', () => {
  test.describe.configure({ mode: 'serial' });

  let sftpServer: SftpTestServerHandle;
  let sftp: SftpClient;
  let mockServer: MockServer;
  let client: ApiClient;

  test.beforeAll(async () => {
    sftpServer = await startSftpTestServer();
    sftp = new SftpClient();
    await sftp.connect({ host: sftpServer.host, port: sftpServer.port, username: sftpServer.username, password: sftpServer.password });
    await sftp.mkdir('/exports');

    mockServer = new MockServer();
    await mockServer.start();
    mockServer.route({
      method: 'POST',
      path: '/reports/export',
      handler: async (req) => {
        const body = req.body as { reportId: string };
        // The side effect a real "export report" endpoint would trigger:
        // writing the file to an SFTP drop location.
        const buffer = Buffer.from(`report,${body.reportId}\n1,generated\n`);
        const localTmp = path.join(os.tmpdir(), `${body.reportId}.csv`);
        await fs.promises.writeFile(localTmp, buffer);
        await sftp.upload(localTmp, `/exports/${body.reportId}.csv`);
        await fs.promises.rm(localTmp, { force: true });
        return { status: 202, body: { reportId: body.reportId, path: `/exports/${body.reportId}.csv` } };
      },
    });
    const context = await playwrightRequest.newContext();
    client = new ApiClient(context, mockServer.baseUrl);
  });

  test.afterAll(async () => {
    await mockServer.stop();
    await sftp.close();
    await stopSftpTestServer(sftpServer);
  });

  test('every SftpClient method, verifying the API call actually uploaded the report', async () => {
    const reportId = randomUtils.alphaNumeric(8);
    const response = await client.post('/reports/export', { json: { reportId } });
    expect(response.status()).toBe(202);
    const remotePath = response.get<string>('path');

    expect(await sftp.exists(remotePath)).toBe('-');

    const localDownload = path.join(os.tmpdir(), `downloaded-${reportId}.csv`);
    await sftp.download(remotePath, localDownload);
    expect(await fs.promises.readFile(localDownload, 'utf-8')).toContain(reportId);
    await fs.promises.rm(localDownload, { force: true });

    const entries = await sftp.list('/exports');
    expect(entries.some((e) => e.name === `${reportId}.csv`)).toBe(true);

    await sftp.mkdir('/exports/archive');
    expect(await sftp.exists('/exports/archive')).toBe('d');

    await sftp.delete(remotePath);
    expect(await sftp.exists(remotePath)).toBe(false);

    await sftp.rmdir('/exports/archive');
    expect(await sftp.exists('/exports/archive')).toBe(false);
  });
});
