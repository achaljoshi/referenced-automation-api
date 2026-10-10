import type { ApiResponse } from '../client/apiResponse';
import type { QueryValue } from '../client/types';

/**
 * What one Gherkin scenario carries between steps: the query parameters set for the NEXT request, and the last
 * response. (Headers and auth live on the apiClient; remembered values live in `vars`.)
 */
export class ApiScenario {
  /** Query parameters for the next request only - cleared once it has been sent. */
  pendingQuery: Record<string, QueryValue> = {};
  lastResponse?: ApiResponse;

  /** The last response, or a clear failure when a "Then" step runs before any request was sent. */
  response(): ApiResponse {
    if (!this.lastResponse)
      throw new Error(
        'No response yet: a step that sends a request ("When I send a GET request to ...") must come first',
      );
    return this.lastResponse;
  }
}
