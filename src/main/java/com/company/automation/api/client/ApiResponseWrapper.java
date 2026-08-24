package com.company.automation.api.client;

import com.company.automation.commons.json.JsonUtils;
import com.fasterxml.jackson.databind.JsonNode;
import com.microsoft.playwright.APIResponse;

import java.util.Map;

/**
 * Thin, easy-to-use wrapper around Playwright's {@link APIResponse}. Every
 * accessor is a plain getter or a fluent {@code shouldHave*} assertion that
 * returns {@code this}, so a whole verification reads as one chained
 * expression:
 *
 * <pre>{@code
 * ApiClient.given()
 *     .header("Authorization", "Bearer " + token)
 *     .when()
 *     .get("/users/2")
 *     .shouldHaveStatus(200)
 *     .shouldHaveHeader("content-type", "application/json; charset=utf-8")
 *     .asJson(UserResponse.class);
 * }</pre>
 */
public final class ApiResponseWrapper {

    private final APIResponse response;
    private String cachedBody;

    ApiResponseWrapper(APIResponse response) {
        this.response = response;
    }

    public int statusCode() {
        return response.status();
    }

    public String statusText() {
        return response.statusText();
    }

    public boolean isOk() {
        return response.ok();
    }

    public Map<String, String> headers() {
        return response.headers();
    }

    public String header(String name) {
        return response.headers().get(name.toLowerCase());
    }

    public String asString() {
        if (cachedBody == null) {
            cachedBody = response.text();
        }
        return cachedBody;
    }

    public byte[] asByteArray() {
        return response.body();
    }

    public <T> T asJson(Class<T> type) {
        return JsonUtils.fromJson(asString(), type);
    }

    public Map<String, Object> asMap() {
        return JsonUtils.toMap(asString());
    }

    public JsonNode asJsonNode() {
        return JsonUtils.toJsonNode(asString());
    }

    /** Reads a single value out of the response body via a JSON Pointer, e.g. {@code jsonPath("/data/id")}. */
    public JsonNode jsonPath(String pointer) {
        return JsonUtils.readAt(asString(), pointer);
    }

    // ---- fluent assertions - return `this` so verification chains with the accessors above ----

    public ApiResponseWrapper shouldHaveStatus(int expectedStatus) {
        if (statusCode() != expectedStatus) {
            throw new AssertionError("Expected status " + expectedStatus + " but got " + statusCode()
                    + ". Body: " + asString());
        }
        return this;
    }

    public ApiResponseWrapper shouldBeOk() {
        if (!isOk()) {
            throw new AssertionError("Expected a 2xx/3xx response but got " + statusCode() + ". Body: " + asString());
        }
        return this;
    }

    public ApiResponseWrapper shouldHaveHeader(String name, String expectedValue) {
        String actual = header(name);
        if (!expectedValue.equals(actual)) {
            throw new AssertionError("Expected header '" + name + "' = '" + expectedValue + "' but got '" + actual + "'");
        }
        return this;
    }

    public ApiResponseWrapper shouldContain(String expectedSubstring) {
        if (!asString().contains(expectedSubstring)) {
            throw new AssertionError("Expected body to contain '" + expectedSubstring + "'. Body: " + asString());
        }
        return this;
    }
}
