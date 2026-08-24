package com.company.automation.api.diagnostics;

import java.util.Map;

/**
 * Immutable snapshot of one request/response round trip, captured by
 * {@link com.company.automation.api.client.ApiClient} for every call and
 * kept as "the last exchange on this thread" so
 * {@code com.company.automation.api.hooks.ApiHooks} can attach it to the
 * Cucumber report when a scenario fails - the API-testing equivalent of a
 * UI framework's failure screenshot.
 */
public record Exchange(
        String method,
        String url,
        Map<String, String> requestHeaders,
        String requestBody,
        int status,
        Map<String, String> responseHeaders,
        String responseBody,
        long durationMillis
) {

    public String toReportString() {
        return """
                >>> %s %s
                Request headers: %s
                Request body: %s

                <<< %d
                Response headers: %s
                Response body: %s

                Duration: %dms
                """.formatted(method, url, requestHeaders, truncate(requestBody),
                status, responseHeaders, truncate(responseBody), durationMillis);
    }

    private static String truncate(String value) {
        if (value == null) {
            return "(none)";
        }
        return value.length() > 4000 ? value.substring(0, 4000) + "... (truncated)" : value;
    }
}
