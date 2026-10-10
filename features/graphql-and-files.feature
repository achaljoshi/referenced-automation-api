@api @regression
Feature: GraphQL and files

  Scenario: A GraphQL query
    When I send the GraphQL query:
      """
      query { users { id name } }
      """
    Then the response status is 200
    And the GraphQL response has no errors
    And the response field "data.echo.query" contains "users"

  Scenario: Cookies the service sets
    When I send a GET request to "/cookies/set"
    Then the response sets the cookie "session"
    And the response sets the cookie "theme"

  Scenario: A file is downloaded byte for byte
    When I download "/download/bytes" to "test-results/bdd-download.bin"
    Then the file "test-results/bdd-download.bin" exists and is not empty
