@api @regression
Feature: Background work and flaky services
  The framework waits for slow things and survives brief outages, without a sleep in the feature

  Scenario: Wait for a background job to finish
    Given I generate a random uuid called "jobId"
    When I wait until a GET request to "/jobs/{{jobId}}" returns "state" equal to "DONE" within 10 seconds
    Then the response field "state" equals "DONE"
    And the response field "reads" equals 3

  Scenario: A brief outage is retried
    Given I generate a random uuid called "key"
    And I retry throttled and unavailable responses up to 3 times
    When I send a GET request to "/flaky/{{key}}"
    Then the response status is 200
    And the response field "ok" is true
    And the response field "calls" equals 3
    And the call was attempted 3 times with the answers "503, 503, 200"

  Scenario: Without a retry policy the failure is visible
    Given I generate a random uuid called "key"
    When I send a GET request to "/flaky/{{key}}"
    Then the response status is 503

  Scenario: A call that needed retries is noted in the test report
    Given I generate a random uuid called "key"
    And I retry throttled and unavailable responses up to 3 times
    When I send a GET request to "/flaky/{{key}}?fail=2"
    Then the response status is 200
    And the test report carries 1 retry note
    And the retry note reads like "GET .*/flaky/.*: 2 retries \(503, 503, 200\)"

  Scenario: A call that did not need a retry adds no note
    Given I retry throttled and unavailable responses up to 3 times
    When I send a GET request to "/users"
    Then the response status is 200
    And the test report carries 0 retry notes

  Scenario: Retries that end in a network error are noted too
    Given the API base URL is "http://127.0.0.1:1"
    And I retry throttled and unavailable responses up to 1 times
    When I try to send a GET request to "/x"
    Then the request fails
    And the retry note reads like "1 retry \(network error, network error\)"
