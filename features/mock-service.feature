@api @smoke
Feature: Mock service
  A local stand-in for a service answers exactly what a scenario tells it to

  Background:
    Given a mock service is running

  Scenario: A static JSON answer, 200 unless said otherwise
    Given the mock service answers GET "/ping" with:
      | body | {"ok":true} |
    When I send a GET request to "/ping"
    Then the response status is 200
    And the response body is exactly JSON:
      """
      { "ok": true }
      """

  Scenario: A custom status and headers
    Given the mock service answers POST "/rejected" with:
      | body          | {"error":"nope"} |
      | status        | 422              |
      | header X-Mock | true             |
    When I send a POST request to "/rejected" with JSON:
      """
      {}
      """
    Then the response status is 422
    And the response header "x-mock" is "true"
    And the response body is exactly JSON:
      """
      { "error": "nope" }
      """

  Scenario: A route nothing registered is a JSON 404
    When I send a GET request to "/does-not-exist"
    Then the response status is 404
    And the response field "error" contains "/does-not-exist"

  Scenario: Forgetting the mocks removes every answer
    Given the mock service answers GET "/temp" with:
      | body | {"temp":true} |
    When I send a GET request to "/temp"
    Then the response status is 200
    When the mock service forgets every mock
    And I send a GET request to "/temp"
    Then the response status is 404

  Scenario: An answer can be delayed
    Given the mock service answers GET "/slow" with:
      | body     | {"ok":true} |
      | delay ms | 200         |
    When I send a GET request to "/slow"
    Then the response took at least 180 ms
