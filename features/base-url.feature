@api @regression
Feature: A base URL with a path (a gateway)
  The path of the base URL is kept, a full URL named in a step reaches the host it names, and query data survives

  Scenario: A path is sent under the gateway prefix
    Given the service is behind the gateway path "/api/v1"
    When I send a GET request to "/users"
    Then the response status is 200
    And the response field "data[0].name" equals "Ada Lovelace"
    And the gateway service last received the request "/api/v1/users"

  Scenario: A trailing slash on the base URL and a path without a leading slash give the same URL
    Given the service is behind the gateway path "/api/v1"
    And the API base URL is "{{gatewayUrl}}/"
    When I send a GET request to "users/2"
    Then the response field "name" equals "Grace Hopper"
    And the gateway service last received the request "/api/v1/users/2"

  Scenario: A negative test gets the application's 404, not the gateway's, because the prefix is really there
    Given the service is behind the gateway path "/api/v1"
    When I send a GET request to "/users/999"
    Then the response status is 404
    And the response field "error" equals "not found"
    Given the API base URL is "{{gatewayOrigin}}"
    When I send a GET request to "/users"
    Then the response status is 404
    And the response field "data" does not exist

  Scenario: Query parameters and a query in the path are both kept
    Given the service is behind the gateway path "/api/v1"
    When I send a GET request to "/search?fixed=1" with query parameters:
      | q | ada |
    Then the response field "query.fixed" equals "1"
    And the response field "query.q" equals "ada"

  Scenario: A signature covers the real path, prefix included
    Given the service is behind the gateway path "/api/v1"
    And I sign every request with the HMAC key "key-1" and secret "hmac-secret"
    When I send a GET request to "/protected/hmac"
    Then the response status is 200

  Scenario: A step that names a full URL reaches that host
    Given another service is running
    When I send a GET request to "{{otherUrl}}/users/1"
    Then the response field "name" equals "Ada Lovelace"
    And the other service last received the request "/users/1"

  Scenario: A path that merely contains a colon is still a path
    Given the service is behind the gateway path "/api/v1"
    When I send a GET request to "/search?next=http://x.test/a"
    Then the response status is 200
