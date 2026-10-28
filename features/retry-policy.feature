@api
Feature: Retry policy
  A throttled or unavailable service is tried again where that is safe, and never where doing a thing twice would be worse than failing once

  Scenario: When the attempts run out the last answer is returned, not an error
    Given I retry throttled and unavailable responses up to 1 times
    When I send a GET request to "/always-503"
    Then the response status is 503

  Scenario: A POST is not repeated by default
    Given I generate a random uuid called "key"
    And I retry throttled and unavailable responses up to 2 times
    When I send a POST request to "/flaky-post/{{key}}" with JSON:
      """
      {}
      """
    Then the response status is 503
    And the test service has seen 1 call to "flaky-post:{{key}}"

  Scenario: An idempotency key makes a POST safe to repeat and is sent as a header
    Given I generate a random uuid called "key"
    And I retry throttled and unavailable responses up to 2 times
    When I send a POST request to "/flaky-post/{{key}}" with JSON "{}" and the idempotency key "order-42"
    Then the response status is 201
    And the response field "idempotencyKey" equals "order-42"
    When I send a GET request to "/echo-idempotency" with a generated idempotency key
    Then the response field "key" matches "[0-9a-f-]{36}"

  Scenario: A policy for the whole scenario can be turned off for one call
    Given I generate a random uuid called "first"
    And I generate a random uuid called "second"
    And I retry throttled and unavailable responses up to 2 times
    When I send a GET request to "/flaky/{{first}}"
    Then the response status is 200
    When I send a GET request to "/flaky/{{second}}" without retrying
    Then the response status is 503

  Scenario: Network errors are retried too, then reported when they keep happening
    Given the API base URL is "http://127.0.0.1:1"
    And I retry throttled and unavailable responses up to 1 times
    When I try to send a GET request to "/x"
    Then the request fails
    And the call was attempted 2 times, every one ending in a network error
