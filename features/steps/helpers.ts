import type { placeholders } from '@automation/referenced-automation-utils';
import type { ApiClient } from '../../src/client/apiClient';
import type { ApiResponse } from '../../src/client/apiResponse';
import type { HttpMethod, RequestOptions } from '../../src/client/types';
import type { ApiScenario } from '../../src/bdd/scenario';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** The pieces of the test a sending step needs (the package's steps use the same three fixtures). */
export interface Sender {
  apiClient: ApiClient;
  vars: placeholders.ScenarioVariables;
  apiScenario: ApiScenario;
}

export function httpMethod(word: string): HttpMethod {
  const upper = word.toUpperCase();
  if (!METHODS.includes(upper))
    throw new Error(
      `"${word}" is not an HTTP method the client can send. Use one of: ${METHODS.join(', ')}`,
    );
  return upper as HttpMethod;
}

/**
 * Sends one request the way the package's "I send a GET request to ..." step does (placeholders in the path, the
 * pending query parameters, a full URL allowed because the author wrote it) and remembers the response for the "Then" steps.
 */
export async function sendRequest(
  { apiClient, vars, apiScenario }: Sender,
  verb: string,
  path: string,
  extra: RequestOptions = {},
): Promise<ApiResponse> {
  const resolved = vars.interpolate(path);
  const query = { ...apiScenario.pendingQuery, ...extra.queryParams };
  apiScenario.pendingQuery = {};
  const response = await apiClient.request(httpMethod(verb), resolved, {
    ...(/^[a-z][a-z0-9+.-]*:\/\//i.test(resolved) ? { absoluteUrl: true } : {}),
    ...extra,
    ...(Object.keys(query).length > 0 ? { queryParams: query } : {}),
  });
  apiScenario.lastResponse = response;
  return response;
}
