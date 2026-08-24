package com.company.automation.api.client;

import com.company.automation.api.config.ConfigReader;
import com.company.automation.api.context.ApiContextManager;
import com.company.automation.api.diagnostics.Exchange;
import com.microsoft.playwright.APIRequestContext;
import com.microsoft.playwright.APIResponse;
import com.microsoft.playwright.options.RequestOptions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Fluent request builder - the "given()" half of the
 * {@code given().when().<verb>(path)} style this client is deliberately
 * modelled on, so testers already familiar with REST Assured feel at home
 * immediately while the request actually executes through Playwright's
 * {@link APIRequestContext}.
 *
 * <p>Obtain one via {@link ApiClient#given()}, chain {@code .header(...)},
 * {@code .queryParam(...)}, {@code .body(...)} as needed, then call one of
 * the HTTP verb methods to execute and get back an {@link ApiResponseWrapper}.
 * {@code when()} is provided purely for readability - it is a no-op that
 * returns {@code this}.
 */
public final class ApiRequestSpec {

    private static final Logger LOG = LoggerFactory.getLogger(ApiRequestSpec.class);

    private final Map<String, String> headers = new LinkedHashMap<>();
    private final Map<String, String> queryParams = new LinkedHashMap<>();
    private String body;

    ApiRequestSpec() {
    }

    public ApiRequestSpec header(String name, String value) {
        headers.put(name, value);
        return this;
    }

    public ApiRequestSpec bearerToken(String token) {
        return header("Authorization", "Bearer " + token);
    }

    public ApiRequestSpec queryParam(String name, String value) {
        queryParams.put(name, value);
        return this;
    }

    /** Sets a raw request body string. Pair with {@code .header("Content-Type", "application/json")} as needed,
     *  or use {@link #jsonBody(Object)} to do both at once. */
    public ApiRequestSpec body(String rawBody) {
        this.body = rawBody;
        return this;
    }

    /** Serializes {@code payload} to JSON (via referenced-automation-utils' JsonUtils) and sets the Content-Type header. */
    public ApiRequestSpec jsonBody(Object payload) {
        this.body = com.company.automation.commons.json.JsonUtils.toJson(payload);
        return header("Content-Type", "application/json");
    }

    /** Purely for readability - {@code given()....when().get(path)} reads better than {@code given()....get(path)}. */
    public ApiRequestSpec when() {
        return this;
    }

    public ApiResponseWrapper get(String path) {
        return execute("GET", path);
    }

    public ApiResponseWrapper post(String path) {
        return execute("POST", path);
    }

    public ApiResponseWrapper put(String path) {
        return execute("PUT", path);
    }

    public ApiResponseWrapper patch(String path) {
        return execute("PATCH", path);
    }

    public ApiResponseWrapper delete(String path) {
        return execute("DELETE", path);
    }

    private ApiResponseWrapper execute(String method, String path) {
        APIRequestContext context = ApiContextManager.getContext();

        RequestOptions options = RequestOptions.create();
        headers.forEach(options::setHeader);
        queryParams.forEach(options::setQueryParam);
        if (body != null) {
            options.setData(body);
        }

        long start = System.currentTimeMillis();
        APIResponse response = context.fetch(path, options.setMethod(method));
        long duration = System.currentTimeMillis() - start;

        ApiResponseWrapper wrapper = new ApiResponseWrapper(response);
        Exchange exchange = new Exchange(method, path, Map.copyOf(headers), body,
                wrapper.statusCode(), wrapper.headers(), wrapper.asString(), duration);
        ApiContextManager.recordExchange(exchange);

        if (ConfigReader.logAllExchanges()) {
            LOG.info(exchange.toReportString());
        } else {
            LOG.debug(exchange.toReportString());
        }
        LOG.info("{} {} -> {} ({}ms)", method, path, wrapper.statusCode(), duration);

        return wrapper;
    }
}
