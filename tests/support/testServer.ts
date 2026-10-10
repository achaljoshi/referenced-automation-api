import express, { type Express } from 'express';
import multer from 'multer';
import type { Server } from 'node:http';
import { XMLParser } from 'fast-xml-parser';
import { createHash, createHmac } from 'node:crypto';

export interface TestServerHandle {
  app: Express;
  server: Server;
  baseUrl: string;
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
export function startTestServer(): Promise<TestServerHandle> {
  const app = express();
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
  app.head('/users', (req, res) => {
    res.setHeader('X-Total-Count', String(users.length));
    res.status(200).send();
  });

  app.get('/users', (req, res) => {
    res.json({ data: users });
  });

  app.get('/users/:id', (req, res) => {
    const user = users.find((u) => u.id === Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json(user);
  });

  app.post('/users', (req, res) => {
    const created = { id: 999, ...req.body };
    res.status(201).json(created);
  });

  app.put('/users/:id', (req, res) => {
    res.json({ id: Number(req.params.id), ...req.body });
  });

  app.patch('/users/:id', (req, res) => {
    res.json({ id: Number(req.params.id), patched: true, ...req.body });
  });

  app.delete('/users/:id', (req, res) => {
    res.status(204).send();
  });

  app.options('/users', (req, res) => {
    res.setHeader('Allow', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS');
    res.status(204).send();
  });

  app.get('/search', (req, res) => {
    res.json({ query: req.query });
  });

  app.get('/headers-echo', (req, res) => {
    res.json({ headers: req.headers });
  });

  app.post('/xml-echo', (req, res) => {
    const parsed = xmlParser.parse(req.body as string);
    res.set('Content-Type', 'application/xml');
    res.send(`<echo><received>${JSON.stringify(parsed)}</received></echo>`);
  });

  app.post('/form-echo', (req, res) => {
    res.json({ received: req.body });
  });

  app.post('/upload', upload.single('file'), (req, res) => {
    res.json({
      fields: req.body,
      file: req.file ? { originalname: req.file.originalname, size: req.file.size } : null,
    });
  });

  app.get('/protected/basic', (req, res) => {
    const header = req.headers.authorization ?? '';
    if (header !== `Basic ${Buffer.from('user:pass').toString('base64')}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ authenticated: true });
  });

  app.get('/protected/bearer', (req, res) => {
    if (req.headers.authorization !== 'Bearer expected-token') {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ authenticated: true });
  });

  app.get('/protected/apikey', (req, res) => {
    const key = req.headers['x-api-key'] ?? req.query.apiKey;
    if (key !== 'expected-key') {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ authenticated: true });
  });

  app.post('/oauth/token', (req, res) => {
    if (req.body.client_id !== 'client' || req.body.client_secret !== 'secret') {
      return res.status(401).json({ error: 'invalid_client' });
    }
    res.json({ access_token: 'issued-token', expires_in: 3600, token_type: 'Bearer' });
  });

  app.get('/protected/oauth', (req, res) => {
    if (req.headers.authorization !== 'Bearer issued-token') {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ authenticated: true });
  });

  app.get('/page-items', (req, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 2);
    const start = (page - 1) * pageSize;
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })).slice(
      start,
      start + pageSize,
    );
    res.json({ items });
  });

  app.get('/cursor-items', (req, res) => {
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
  app.get('/flaky/:key', (req, res) => {
    const calls = bump(`flaky:${req.params.key}`);
    if (calls <= Number(req.query.fail ?? 2)) {
      res.setHeader('Retry-After', '0');
      return res.status(503).json({ error: 'try again', calls });
    }
    res.json({ ok: true, calls });
  });

  app.post('/flaky-post/:key', (req, res) => {
    const calls = bump(`flaky-post:${req.params.key}`);
    if (calls <= 1) return res.status(503).json({ error: 'try again', calls });
    res
      .status(201)
      .json({ created: true, calls, idempotencyKey: req.headers['idempotency-key'] ?? null });
  });

  app.get('/always-503', (req, res) => {
    bump('always-503');
    res.status(503).json({ error: 'down' });
  });

  app.get('/calls/:key', (req, res) => {
    res.json({ calls: counters.get(req.params.key) ?? 0 });
  });

  // A background job: PENDING for the first N reads, then DONE.
  app.get('/jobs/:id', (req, res) => {
    const reads = bump(`job:${req.params.id}`);
    res.json({
      id: req.params.id,
      state: reads > Number(req.query.after ?? 2) ? 'DONE' : 'PENDING',
      reads,
    });
  });

  app.get('/download/bytes', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="blob.bin"');
    res.send(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]));
  });

  app.post('/graphql', (req, res) => {
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

  app.post('/soap', (req, res) => {
    const text = typeof req.body === 'string' ? req.body : '';
    res.set('Content-Type', 'text/xml');
    res.send(
      `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Echo><action>${String(req.headers.soapaction ?? '')}</action><contentType>${String(req.headers['content-type'] ?? '')}</contentType><length>${text.length}</length></Echo></soap:Body></soap:Envelope>`,
    );
  });

  app.get('/cookies/set', (req, res) => {
    res.setHeader('Set-Cookie', [
      'session=abc123; Path=/; HttpOnly; Secure',
      'theme=dark; Path=/; Max-Age=3600',
    ]);
    res.json({ set: true });
  });

  app.post('/session/login', (req, res) => {
    if (req.body.username !== 'ada' || req.body.password !== 'lovelace')
      return res.status(401).json({ error: 'bad login' });
    res.setHeader('Set-Cookie', 'sid=session-token; Path=/; HttpOnly');
    res.json({ loggedIn: true });
  });

  app.get('/protected/session', (req, res) => {
    if (!String(req.headers.cookie ?? '').includes('sid=session-token'))
      return res.status(401).json({ error: 'no session' });
    res.json({ authenticated: true });
  });

  app.get('/protected/hmac', (req, res) => hmacCheck(req, res));
  app.post('/protected/hmac', (req, res) => hmacCheck(req, res));

  function hmacCheck(req: express.Request, res: express.Response) {
    const timestamp = String(req.headers['x-timestamp'] ?? '');
    const raw = req.method === 'GET' ? '' : JSON.stringify(req.body);
    const canonical = `${timestamp}\n${req.method}\n${req.originalUrl}\n${createHash('sha256').update(raw).digest('hex')}`;
    const expected = createHmac('sha256', 'hmac-secret').update(canonical).digest('hex');
    if (req.headers['x-key-id'] !== 'key-1' || req.headers['x-signature'] !== expected)
      return res.status(401).json({ error: 'bad signature' });
    res.json({ authenticated: true });
  }

  app.get('/protected/jwt', (req, res) => {
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

  app.post('/oauth/password-token', (req, res) => {
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

  app.get('/protected/oauth-password', (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== 'Bearer password-token' && auth !== 'Bearer refreshed-token')
      return res.status(401).json({ error: 'unauthorized' });
    res.json({ authenticated: true, token: auth });
  });

  app.get('/redirect', (req, res) => {
    res.redirect(302, '/users/1');
  });

  app.get('/echo-idempotency', (req, res) => {
    res.json({ key: req.headers['idempotency-key'] ?? null });
  });

  app.get('/secrets-echo', (req, res) => {
    res.json({ ok: true });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ app, server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

export function stopTestServer(handle: TestServerHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    handle.server.close((err) => (err ? reject(err) : resolve()));
  });
}
