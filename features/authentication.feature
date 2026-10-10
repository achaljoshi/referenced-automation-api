@api @regression
Feature: Authentication
  Every kind of credential the framework supports reaches the service the way the service expects it

  Scenario: Bearer token
    Given I am authenticated with the bearer token "expected-token"
    When I send a GET request to "/protected/bearer"
    Then the response status is 200
    And the response field "authenticated" is true

  Scenario: Basic authentication
    Given I am authenticated as "user" with the password "pass"
    When I send a GET request to "/protected/basic"
    Then the response status is 200

  Scenario: An API key in a header
    Given I use the API key "expected-key" in the header "X-API-Key"
    When I send a GET request to "/protected/apikey"
    Then the response status is 200

  Scenario: An API key in the query string
    Given I set the query parameter "apiKey" to "expected-key"
    When I send a GET request to "/protected/apikey"
    Then the response status is 200

  Scenario: Credentials are refused when they are wrong or missing
    When I send a GET request to "/protected/bearer"
    Then the response status is 401
    Given I am authenticated with the bearer token "not-the-token"
    When I send a GET request to "/protected/bearer"
    Then the response status is 401
    And the response field "error" equals "unauthorized"

  Scenario: Credentials can be taken away again
    Given I am authenticated with the bearer token "expected-token"
    And I am not authenticated
    When I send a GET request to "/protected/bearer"
    Then the response status is 401

  Scenario: Credentials that live in the environment are never written in the feature
    Given I set the variable "token" to "{{env:FEATURE_SAMPLE_TOKEN|expected-token}}"
    And I am authenticated with the bearer token "{{token}}"
    When I send a GET request to "/protected/bearer"
    Then the response status is 200
