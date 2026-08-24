package com.company.automation.api.stepdefinitions;

import com.company.automation.api.client.ApiResponseWrapper;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import org.junit.jupiter.api.Assertions;

import static com.company.automation.api.client.ApiClient.given;

/**
 * Step definitions for posts.feature. Notice these only talk to
 * {@link com.company.automation.api.client.ApiClient} - never directly to
 * Playwright - which is exactly the point of the client: it hides the
 * underlying {@code APIRequestContext}/{@code RequestOptions} plumbing
 * behind a REST-Assured-style {@code given().when().<verb>()} chain.
 */
public class PostsApiSteps {

    private String requestBody;
    private ApiResponseWrapper response;

    @Given("I set the JSON body to:")
    public void i_set_the_json_body_to(String json) {
        this.requestBody = json;
    }

    @When("I GET {string}")
    public void i_get(String path) {
        response = given().when().get(path);
    }

    @When("I POST to {string}")
    public void i_post_to(String path) {
        response = given().header("Content-Type", "application/json; charset=UTF-8")
                .body(requestBody)
                .when()
                .post(path);
    }

    @When("I PUT to {string}")
    public void i_put_to(String path) {
        response = given().header("Content-Type", "application/json; charset=UTF-8")
                .body(requestBody)
                .when()
                .put(path);
    }

    @When("I DELETE {string}")
    public void i_delete(String path) {
        response = given().when().delete(path);
    }

    @Then("the response status should be {int}")
    public void the_response_status_should_be(int expectedStatus) {
        response.shouldHaveStatus(expectedStatus);
    }

    @Then("the response field {string} should equal {string}")
    public void the_response_field_should_equal(String fieldName, String expectedValue) {
        String actual = response.jsonPath("/" + fieldName).asText();
        Assertions.assertEquals(expectedValue, actual);
    }
}
