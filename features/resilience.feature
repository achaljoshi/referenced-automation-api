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

  Scenario: Without a retry policy the failure is visible
    Given I generate a random uuid called "key"
    When I send a GET request to "/flaky/{{key}}"
    Then the response status is 503
