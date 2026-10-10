import express, { type Express } from 'express';
import multer from 'multer';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import { createHash, createHmac } from 'node:crypto';

/** One request the server received - what a test checks to prove a call did (or did not) reach it, and with which headers. */
export interface ReceivedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface TestServerHandle {
  app: Express;
  server: Server;
  /** What a client uses as its base URL: the origin plus the `prefix`, when there is one. */
  baseUrl: string;
  /** Scheme, host and port only. */
  origin: string;
  /** Every request received so far, newest last. */
  requests: ReceivedRequest[];
  /** Open connections, so stopTestServer can drop them. */
  sockets: Set<Socket>;
}

export interface TestServerOptions {
  /** Mount every route under this path (`/api/v1`), the way a gateway does. Requests outside it are 404. */
  prefix?: string;
}

const xmlParser = new XMLParser();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * A tiny, in-process HTTP server exercising every feature the ApiClient
 * needs to prove: all methods, header/query/path params, JSON/XML/form/
 * multipart bodies, pagination (both styles), and every auth strategy.
 * Deliberately not a live third-party API - fast, deterministic, and
 * offline, unlike hitting a real public API from CI.
 */
export function startTestServer(options: TestServerOptions = {}): Promise<TestServerHandle> {
  const app = express();
  const prefix = options.prefix ?? '';
  const router = express.Router();
  const requests: ReceivedRequest[] = [];
  app.use((req, res, next) => {
    requests.push({ method: req.method, url: req.originalUrl, headers: { ...req.headers } });
    next();
  });
  app.use((req, res, next) => {
    // Accept JSON, form, and XML bodies without express.json() rejecting
    // the non-JSON content types.
    express.json()(req, res, () => express.urlencoded({ extended: true })(req, res, next));
  });
  app.use(express.text({ type: ['application/xml', 'text/xml'] }));

  const users = [
    { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 2, name: 'Grace Hopper', email: 'grace@example.com' },
    { id: 3, name: 'Katherine Johnson', email: 'katherine@example.com' },
  ];

  // HEAD must be registered before GET on the same path - Express falls
  // through to a matching GET handler for HEAD requests otherwise, which
  // would silently serve the GET response body/headers instead of this
  // handler's (no x-total-count, and a real body on a request that should
  // have none).
  router.head('/users', (req, res) => {
    res.setHeader('X-Total-Count', String(users.length));
    res.status(200).send();
  });

  router.get('/users', (req, res) => {
    res.json({ data: users });
  });

  router.get('/users/:id', (req, res) => {
    const user = users.find((u) => u.id === Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json(user);
  });

  router.post('/users', (req, res) => {
    const created = { id: 999, ...req.body };
    res.status(201).json(created);
  });

  router.put('/users/:id', (req, res) => {
    res.json({ id: Number(req.params.id), ...req.body });
  });

  router.patch('/users/:id', (req, res) => {
    res.json({ id: Number(req.params.id), patched: true, ...req.body });
  });

  router.delete('/users/:id', (req, res) => {
    res.status(204).send();
  });

  router.options('/users', (req, res) => {
    res.setHeader('Allow', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS');
    res.status(204).send();
  });

  router.get('/search', (req, res) => {
    res.json({ query: req.query });
  });

  router.get('/headers-echo', (req, res) => {
    res.json({ headers: req.headers });
  });

  router.post('/xml-echo', (req, res) => {
    const parsed = xmlParser.parse(req.body as string);
    res.set('Content-Type', 'application/xml');
    res.send(`<echo><received>${JSON.stringify(parsed)}</received></echo>`);
  });

  router.post('/form-echo', (req, res) => {
    res.json({ received: req.body });
  });

  router.post('/upload', upload.single('file'), (req, res) => {
    res.json({
      fields: req.body,
      file: req.file ? { originalname: req.file.originalname, size: req.file.size } : null,
    });
  });

  router.get('/protected/basic', (req, res) => {
    const header = req.headers.authorization ?? '';
    if (header !== `Basic ${Buffer.from('user:pass').toString('base64')}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ authenticated: true });
  });

  router.get('/protected/bearer', (req, res) => {
    if (req.headers.authorization !== 'Bearer expected-token') {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ authenticated: true });
  });

  router.get('/protected/apikey', (req, res) => {
    const key = req.headers['x-api-key'] ?? req.query.apiKey;
    if (key !== 'expected-key') {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ authenticated: true });
  });

  router.post('/oauth/token', (req, res) => {
    if (req.body.client_id !== 'client' || req.body.client_secret !== 'secret') {
      return res.status(401).json({ error: 'invalid_client' });
    }
    res.json({ access_token: 'issued-token', expires_in: 3600, token_type: 'Bearer' });
  });

  router.get('/protected/oauth', (req, res) => {
    if (req.headers.authorization !== 'Bearer issued-token') {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ authenticated: true });
  });

  router.get('/page-items', (req, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 2);
    const start = (page - 1) * pageSize;
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })).slice(
      start,
      start + pageSize,
    );
    res.json({ items });
  });

  router.get('/cursor-items', (req, res) => {
    const cursor = Number(req.query.cursor ?? 0);
    const pageSize = 2;
    const all = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const items = all.slice(cursor, cursor + pageSize);
    const next = cursor + pageSize < all.length ? cursor + pageSize : null;
    res.json({ items, next });
  });

  // ---- behaviours for retry, polling, downloads, GraphQL/SOAP, sessions and signed requests ----

  const counters = new Map<string, number>();
  const bump = (key: string) => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  };

  // Answers 503 (with Retry-After: 0) until it has been asked `fail` times for the same key, then 200.
  router.get('/flaky/:key', (req, res) => {
    const calls = bump(`flaky:${req.params.key}`);
    if (calls <= Number(req.query.fail ?? 2)) {
      res.setHeader('Retry-After', '0');
      return res.status(503).json({ error: 'try again', calls });
    }
    res.json({ ok: true, calls });
  });

  router.post('/flaky-post/:key', (req, res) => {
    const calls = bump(`flaky-post:${req.params.key}`);
    if (calls <= 1) return res.status(503).json({ error: 'try again', calls });
    res
      .status(201)
      .json({ created: true, calls, idempotencyKey: req.headers['idempotency-key'] ?? null });
  });

  router.get('/always-503', (req, res) => {
    bump('always-503');
    res.status(503).json({ error: 'down' });
  });

  router.get('/calls/:key', (req, res) => {
    res.json({ calls: counters.get(req.params.key) ?? 0 });
  });

  // A background job: PENDING for the first N reads, then DONE.
  router.get('/jobs/:id', (req, res) => {
    const reads = bump(`job:${req.params.id}`);
    res.json({
      id: req.params.id,
      state: reads > Number(req.query.after ?? 2) ? 'DONE' : 'PENDING',
      reads,
    });
  });

  router.get('/download/bytes', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="blob.bin"');
    res.send(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]));
  });

  router.post('/graphql', (req, res) => {
    const { query, variables, operationName } = req.body as {
      query?: string;
      variables?: Record<string, unknown>;
      operationName?: string;
    };
    if (!query || /broken/.test(query)) return res.json({ errors: [{ message: 'Syntax Error' }] });
    res.json({
      data: { echo: { query, variables: variables ?? null, operationName: operationName ?? null } },
    });
  });

  router.post('/soap', (req, res) => {
    const text = typeof req.body === 'string' ? req.body : '';
    res.set('Content-Type', 'text/xml');
    res.send(
      `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Echo><action>${String(req.headers.soapaction ?? '')}</action><contentType>${String(req.headers['content-type'] ?? '')}</contentType><length>${text.length}</length></Echo></soap:Body></soap:Envelope>`,
    );
  });

  router.get('/cookies/set', (req, res) => {
    res.setHeader('Set-Cookie', [
      'session=abc123; Path=/; HttpOnly; Secure',
      'theme=dark; Path=/; Max-Age=3600',
    ]);
    res.json({ set: true });
  });

  router.post('/session/login', (req, res) => {
    if (req.body.username !== 'ada' || req.body.password !== 'lovelace')
      return res.status(401).json({ error: 'bad login' });
    res.setHeader('Set-Cookie', 'sid=session-token; Path=/; HttpOnly');
    res.json({ loggedIn: true });
  });

  router.get('/protected/session', (req, res) => {
    if (!String(req.headers.cookie ?? '').includes('sid=session-token'))
      return res.status(401).json({ error: 'no session' });
    res.json({ authenticated: true });
  });

  router.get('/protected/hmac', (req, res) => hmacCheck(req, res));
  router.post('/protected/hmac', (req, res) => hmacCheck(req, res));

  function hmacCheck(req: express.Request, res: express.Response) {
    const timestamp = String(req.headers['x-timestamp'] ?? '');
    const raw = req.method === 'GET' ? '' : JSON.stringify(req.body);
    const canonical = `${timestamp}\n${req.method}\n${req.originalUrl}\n${createHash('sha256').update(raw).digest('hex')}`;
    const expected = createHmac('sha256', 'hmac-secret').update(canonical).digest('hex');
    if (req.headers['x-key-id'] !== 'key-1' || req.headers['x-signature'] !== expected)
      return res.status(401).json({ error: 'bad signature' });
    res.json({ authenticated: true });
  }

  router.get('/protected/jwt', (req, res) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', 'jwt-secret')
      .update(`${header}.${payload}`)
      .digest('base64url');
    if (!header || !payload || signature !== expected)
      return res.status(401).json({ error: 'bad token' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      sub?: string;
      exp: number;
    };
    if (claims.exp < Math.floor(Date.now() / 1000))
      return res.status(401).json({ error: 'expired' });
    res.json({ authenticated: true, sub: claims.sub });
  });

  router.post('/oauth/password-token', (req, res) => {
    const body = req.body as Record<string, string>;
    if (body.grant_type === 'refresh_token') {
      if (body.refresh_token !== 'refresh-1')
        return res.status(400).json({ error: 'invalid_grant' });
      return res.json({
        access_token: 'refreshed-token',
        refresh_token: 'refresh-1',
        expires_in: 3600,
      });
    }
    if (body.username !== 'ada' || body.password !== 'lovelace')
      return res.status(401).json({ error: 'invalid_grant' });
    res.json({ access_token: 'password-token', refresh_token: 'refresh-1', expires_in: 1 });
  });

  router.get('/protected/oauth-password', (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== 'Bearer password-token' && auth !== 'Bearer refreshed-token')
      return res.status(401).json({ error: 'unauthorized' });
    res.json({ authenticated: true, token: auth });
  });

  router.get('/redirect', (req, res) => {
    res.redirect(302, '/users/1');
  });

  router.get('/echo-idempotency', (req, res) => {
    res.json({ key: req.headers['idempotency-key'] ?? null });
  });

  router.get('/secrets-echo', (req, res) => {
    res.json({ ok: true });
  });

  // ---- behaviours for the auth, pagination, GraphQL, XML and redaction tests ----

  // Counts every token request per `tenant`, so a test can prove a token was fetched once (see GET /calls/<key>).
  router.post('/oauth/token-counted', (req, res) => {
    bump(`token:${String(req.query.tenant ?? '')}`);
    if (req.body.client_id !== 'client' || req.body.client_secret !== 'secret') {
      return res.status(401).json({ error: 'invalid_client' });
    }
    res.json({ access_token: 'issued-token', expires_in: 3600, token_type: 'Bearer' });
  });

  // An identity provider that never answers.
  router.post('/oauth/hang', () => undefined);

  // An identity provider whose error body repeats what it was sent and carries extra detail.
  router.post('/oauth/token-error', (req, res) => {
    res.status(400).json({
      error: 'invalid_client',
      error_description: `client secret ${String(req.body.client_secret)} is not valid`,
      debug: `received: ${JSON.stringify(req.body)}`,
    });
  });
  router.post('/oauth/token-html', (req, res) => {
    res.status(502).type('html').send(`<html>gateway error for ${JSON.stringify(req.body)}</html>`);
  });

  // Refresh tokens that rotate: each can be used once, and the grant that used it gets the next one.
  const rotating = new Map<string, { n: number; current: string }>();
  router.post('/oauth/rotating-token', (req, res) => {
    const tenant = String(req.query.tenant ?? '');
    const body = req.body as Record<string, string>;
    if (body.grant_type === 'refresh_token') {
      bump(`rot:${tenant}:refresh`);
      const state = rotating.get(tenant);
      if (!state || body.refresh_token !== state.current)
        return res.status(400).json({ error: 'invalid_grant' });
      state.n += 1;
      state.current = `r${state.n}`;
      return res.json({ access_token: `rot-a${state.n}`, refresh_token: state.current, expires_in: 1 });
    }
    bump(`rot:${tenant}:password`);
    if (body.username !== 'ada' || body.password !== 'lovelace')
      return res.status(401).json({ error: 'invalid_grant' });
    rotating.set(tenant, { n: 0, current: 'r0' });
    res.json({ access_token: 'rot-a0', refresh_token: 'r0', expires_in: 1 });
  });
  router.get('/protected/rotating', (req, res) => {
    if (!String(req.headers.authorization ?? '').startsWith('Bearer rot-a'))
      return res.status(401).json({ error: 'unauthorized' });
    res.json({ authenticated: true });
  });

  // Sessions that can expire: every login makes a new session id, and /session/expire invalidates them all.
  const sessions = new Map<string, Set<string>>();
  router.post('/session/login-counted', (req, res) => {
    const tenant = String(req.query.tenant ?? '');
    if (req.body.username !== 'ada' || req.body.password !== 'lovelace')
      return res.status(401).json({ error: 'bad login', echoed: req.body });
    const sid = `s${bump(`login:${tenant}`)}`;
    sessions.set(tenant, (sessions.get(tenant) ?? new Set()).add(sid));
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`);
    res.json({ loggedIn: true });
  });
  router.get('/session/expire', (req, res) => {
    sessions.delete(String(req.query.tenant ?? ''));
    res.json({ expired: true });
  });
  router.get('/protected/session-counted', (req, res) => {
    const valid = sessions.get(String(req.query.tenant ?? '')) ?? new Set();
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    if (!sid || !valid.has(sid)) return res.status(401).json({ error: 'no session' });
    res.json({ authenticated: true, sid });
  });

  // Pages: `mode` picks the way the API misbehaves.
  router.get('/paged/:mode', (req, res) => {
    const mode = req.params.mode;
    const page = Number(req.query.page ?? 1);
    const cursor = String(req.query.cursor ?? '');
    const items = (n: number) => [{ id: n * 10 + 1 }, { id: n * 10 + 2 }];
    switch (mode) {
      case 'fail-on-2':
        if (page === 2) return res.status(500).json({ error: 'boom' });
        return res.json({ items: page < 4 ? items(page) : [] });
      case 'endless':
        return res.json({ items: items(page) });
      case 'cursor-empty-end':
        return res.json({ items: items(cursor === '' ? 1 : 2), next: cursor === '' ? 'c2' : '' });
      case 'cursor-loop':
        return res.json({ items: items(1), next: 'same' });
      case 'cursor-401':
        if (cursor === 'c2') return res.status(401).json({ error: 'expired' });
        return res.json({ items: items(1), next: 'c2' });
      case 'cursor-endless':
        return res.json({ items: items(1), next: `c${Number(cursor.slice(1) || 0) + 1}` });
      default:
        return res.status(404).json({ error: 'unknown mode' });
    }
  });

  router.post('/graphql-html', (req, res) => {
    res.status(502).type('html').send('<html><body>Bad Gateway</body></html>');
  });
  router.post('/graphql-empty', (req, res) => {
    res.status(200).type('json').send('');
  });
  router.post('/graphql-no-shape', (req, res) => {
    res.json({ ok: true });
  });
  router.post('/graphql-null-data', (req, res) => {
    res.json({ data: null });
  });
  router.post('/graphql-json-502', (req, res) => {
    res.status(502).json({ message: 'bad gateway' });
  });

  // A response that carries credentials in a header, a cookie and the body.
  router.get('/me-secrets', (req, res) => {
    res.setHeader('Set-Cookie', 'session=live-session-cookie; Path=/; HttpOnly');
    res.setHeader('X-Api-Key', 'live-api-key-value');
    res.json({ name: 'Ada', password: 'hunter2-live', access_token: 'live-access-token', query: req.query });
  });

  router.get('/reset/:token', (req, res) => {
    res.json({ reset: true });
  });

  router.get('/xml-ids', (req, res) => {
    res.type('application/xml').send('<order id="007"><ref>00123</ref><phone>+4412</phone><qty>7</qty></order>');
  });

  // A login that answers with a session cookie and credentials in an XML body.
  router.post('/login-xml', (req, res) => {
    res.setHeader('Set-Cookie', ['session=live-session-value; Path=/; HttpOnly']);
    res.type('application/xml').send('<LoginResponse><Token>live-token-value</Token><User>ada</User></LoginResponse>');
  });

  app.use(prefix || '/', router);
  // Anything a handler throws is a 500 with the message, never a hung request.
  app.use((error: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });

  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const origin = `http://127.0.0.1:${port}`;
      resolve({ app, server, baseUrl: `${origin}${prefix}`, origin, requests, sockets });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  });
}

/** Stops the server and drops every open connection, so a hung request or a keep-alive socket cannot keep it up. */
export function stopTestServer(handle: TestServerHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    handle.server.close((err) => (err ? reject(err) : resolve()));
    handle.server.closeAllConnections?.();
    for (const socket of handle.sockets) socket.destroy();
  });
}
