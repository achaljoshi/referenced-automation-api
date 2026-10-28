@api
Feature: Every HTTP method
  Each method reaches the service with its body and comes back the way the method promises

  Scenario: A created user is returned with its new id
    When I send a POST request to "/users" with JSON:
      """
      { "name": "New User" }
      """
    Then the response status is 201
    And the response field "name" equals "New User"
    And the response field "id" equals 999

  Scenario: A user is replaced
    When I send a PUT request to "/users/5" with JSON:
      """
      { "name": "Replaced" }
      """
    Then the response field "id" equals 5
    And the response field "name" equals "Replaced"

  Scenario: A user is partly changed
    When I send a PATCH request to "/users/5" with JSON:
      """
      { "name": "Patched" }
      """
    Then the response field "patched" is true
    And the response field "name" equals "Patched"

  Scenario: HEAD answers with headers and no body
    When I send a HEAD request to "/users"
    Then the response status is 200
    And the response header "x-total-count" is "3"

  Scenario: OPTIONS reports which methods are allowed
    When I send a OPTIONS request to "/users"
    Then the response header "allow" is "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS"
