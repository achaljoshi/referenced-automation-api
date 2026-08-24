package com.company.automation.api.client;

/**
 * Entry point into the fluent API client. This is the only class most step
 * definitions ever need to import:
 *
 * <pre>{@code
 * import static com.company.automation.api.client.ApiClient.given;
 *
 * ApiResponseWrapper response = given()
 *     .header("Authorization", "Bearer " + token)
 *     .queryParam("page", "2")
 *     .when()
 *     .get("/users");
 *
 * response.shouldHaveStatus(200);
 * List<User> users = response.asJson(UserListResponse.class).getData();
 * }</pre>
 *
 * <p>Requests run against the {@code APIRequestContext} that
 * {@code com.company.automation.api.hooks.ApiHooks} creates once per
 * scenario (base URL, default timeout and TLS settings come from
 * {@code com.company.automation.api.config.ConfigReader}) - {@link #given()}
 * always picks up the context for the calling thread, so this class needs
 * no setup call of its own.
 */
public final class ApiClient {

    private ApiClient() {
    }

    /** Starts a new request. Named to read naturally as {@code given().header(...).when().get(path)}. */
    public static ApiRequestSpec given() {
        return new ApiRequestSpec();
    }
}
