import express, { type Express } from 'express';
import multer from 'multer';
import type { Server } from 'node:http';
import { XMLParser } from 'fast-xml-parser';

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
