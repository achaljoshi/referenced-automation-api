import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { logger } from '@automation/referenced-automation-utils';
import type { MockBody, MockBodyFn, MockRequestInfo, MockRouteDefinition, MockRouteOptions } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMockRequestInfo(req: Request): MockRequestInfo {
  return {
    method: req.method,
    path: req.path,
    params: req.params as Record<string, string | string[] | undefined>,
    query: req.query as Record<string, string | string[] | undefined>,
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: req.body,
  };
}

function send(res: Response, status: number, headers: Record<string, string> | undefined, body: unknown): void {
  if (headers) res.set(headers);
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    res.status(status).send(body);
  } else {
    res.status(status).json(body ?? null);
  }
}

type ExpressMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

/**
 * A lightweight, in-process HTTP mock server for API testing: register
 * a route with a static or dynamic response and it's live on a random
 * local port, no separate mock service to run or maintain.
 *
 * ```ts
 * const server = new MockServer();
 * await server.start();
 * server.get('/users/:id', (req) => ({ id: Number(req.params.id), name: 'Ada' }));
 * server.post('/users', (req) => ({ id: 999, ...(req.body as object) }), { status: 201 });
 * // ... point an ApiClient (or anything else) at server.baseUrl
 * await server.stop();
 * ```
 *
 * `.route()` is the escape hatch for full control (custom status/headers
 * computed per-request); `.get/.post/.put/.patch/.delete()` cover the common
 * case of "just give me a body back" without that ceremony.
 */
export class MockServer {
  private router = express.Router();
  private readonly app: Express = express();
  private server?: Server;
  baseUrl = '';

  constructor() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    // Indirection through a closure (not `this.app.use(this.router)`) so
    // reset() can swap in a fresh router without re-mounting middleware.
    this.app.use((req, res, next) => this.router(req, res, next));
    this.app.use((req, res) => {
      res.status(404).json({ error: `No mock registered for ${req.method} ${req.path}` });
    });
  }

  private register(method: ExpressMethod, path: string, body: MockBody, options: MockRouteOptions = {}): this {
    this.router[method](path, async (req: Request, res: Response) => {
      const info = toMockRequestInfo(req);
      const resolvedBody = typeof body === 'function' ? await (body as (req: MockRequestInfo) => unknown)(info) : body;
      if (options.delayMs) await sleep(options.delayMs);
      const status = options.status ?? 200;
      logger.info(`[MockServer] ${req.method} ${req.path} -> ${status}`);
      send(res, status, options.headers, resolvedBody);
    });
    return this;
  }

  get(path: string, body: MockBodyFn, options?: MockRouteOptions): this;
  get(path: string, body?: MockBody, options?: MockRouteOptions): this;
  get(path: string, body: MockBody = {}, options?: MockRouteOptions): this {
    return this.register('get', path, body, options);
  }

  post(path: string, body: MockBodyFn, options?: MockRouteOptions): this;
  post(path: string, body?: MockBody, options?: MockRouteOptions): this;
  post(path: string, body: MockBody = {}, options?: MockRouteOptions): this {
    return this.register('post', path, body, options);
  }

  put(path: string, body: MockBodyFn, options?: MockRouteOptions): this;
  put(path: string, body?: MockBody, options?: MockRouteOptions): this;
  put(path: string, body: MockBody = {}, options?: MockRouteOptions): this {
    return this.register('put', path, body, options);
  }

  patch(path: string, body: MockBodyFn, options?: MockRouteOptions): this;
  patch(path: string, body?: MockBody, options?: MockRouteOptions): this;
  patch(path: string, body: MockBody = {}, options?: MockRouteOptions): this {
    return this.register('patch', path, body, options);
  }

  delete(path: string, body: MockBodyFn, options?: MockRouteOptions): this;
  delete(path: string, body?: MockBody, options?: MockRouteOptions): this;
  delete(path: string, body: MockBody = {}, options?: MockRouteOptions): this {
    return this.register('delete', path, body, options);
  }

  /** Full control: compute status/headers/body together, e.g. to vary the status by request body. */
  route(definition: MockRouteDefinition): this {
    const method = definition.method.toLowerCase() as ExpressMethod;
    this.router[method](definition.path, async (req: Request, res: Response) => {
      const info = toMockRequestInfo(req);
      if (definition.delayMs) await sleep(definition.delayMs);
      const result = await definition.handler(info);
      const status = result.status ?? 200;
      logger.info(`[MockServer] ${req.method} ${req.path} -> ${status}`);
      send(res, status, result.headers, result.body);
    });
    return this;
  }

  /** Clears every route registered so far - handy between tests sharing one server instance. */
  reset(): void {
    this.router = express.Router();
  }

  async start(port = 0): Promise<string> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        const address = this.server?.address();
        const resolvedPort = typeof address === 'object' && address ? address.port : port;
        this.baseUrl = `http://127.0.0.1:${resolvedPort}`;
        logger.info(`[MockServer] listening at ${this.baseUrl}`);
        resolve(this.baseUrl);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('[MockServer] stopped');
  }
}
