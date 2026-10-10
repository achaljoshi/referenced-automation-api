@api @smoke
Feature: Users API
  As a client of the users API
  I want to create, read, change and delete users
  So that I can manage people in the system

  Scenario: List the users
    When I send a GET request to "/users"
    Then the response status is 200
    And the response field "data" has 3 items
    And the response field "data[0].name" equals "Ada Lovelace"
    And the response header "content-type" contains "json"

  Scenario: Create a user
    When I send a POST request to "/users" with JSON:
      """
      { "name": "{{random:first-name}} {{random:last-name}}", "roles": ["admin"], "active": true }
      """
    Then the response status is 201
    And the response field "id" is not empty
    And the response field "active" is true
    And the response field "roles" contains "admin"
    And the response body matches JSON:
      """
      { "active": true, "roles": ["admin"] }
      """

  Scenario: The id of a created thing can be used in the next request
    Given I generate a random email called "email"
    When I send a PUT request to "/users/42" with JSON:
      """
      { "name": "Ada", "email": "{{email}}" }
      """
    Then the response field "email" equals "{{email}}"
    When I remember the response field "id" as "userId"
    And I send a PATCH request to "/users/{{userId}}" with JSON:
      """
      { "nickname": "countess" }
      """
    Then the response field "patched" is true
    And the response field "nickname" equals "countess"
    And the response field "id" equals "{{userId}}"

  Scenario: A user that does not exist
    When I send a GET request to "/users/999"
    Then the response status is 404
    And the response field "error" equals "not found"
    And the response field "name" does not exist

  Scenario: Delete a user
    When I send a DELETE request to "/users/5"
    Then the response status is 204
    And the response body is empty

  Scenario Outline: Any known user can be read by id
    When I send a GET request to "/users/<id>"
    Then the response field "name" equals "<name>"

    Examples:
      | id | name              |
      | 1  | Ada Lovelace      |
      | 2  | Grace Hopper      |
      | 3  | Katherine Johnson |

  Scenario: Responses are quick
    When I send a GET request to "/users"
    Then the response time is under 2000 ms
    And the response matches the JSON schema "tests/support/users.schema.json"
