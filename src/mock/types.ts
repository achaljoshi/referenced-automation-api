import type { HttpMethod } from '../client/types';

export interface MockRequestInfo {
  method: string;
  path: string;
  params: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MockRouteOptions {
  status?: number;
  headers?: Record<string, string>;
  /** Artificial latency, for testing loading states/timeouts against a mock. */
  delayMs?: number;
}

/**
 * A static value, or a function computing one per-request from its params/
 * query/headers/body - e.g. `(req) => ({ id: Number(req.params.id) })`.
 */
export type MockBody = unknown | ((req: MockRequestInfo) => unknown | Promise<unknown>);

export interface MockResult {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface MockRouteDefinition {
  method: HttpMethod;
  path: string;
  handler: (req: MockRequestInfo) => MockResult | Promise<MockResult>;
  delayMs?: number;
}
