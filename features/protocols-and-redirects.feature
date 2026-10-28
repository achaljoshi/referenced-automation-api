@api
Feature: GraphQL, SOAP, redirects and switching the base URL

  Scenario: A GraphQL query carries its variables and operation name
    When I send the GraphQL query "query Q($id: ID!) { user(id: $id) { name } }" with the variables "{\"id\":\"1\"}" and the operation name "Q"
    Then the response status is 200
    And the GraphQL response has no errors
    And the response field "data.echo.variables.id" equals "1"
    And the response field "data.echo.operationName" equals "Q"

  Scenario: GraphQL errors come back with a 200
    When I send the GraphQL query:
      """
      query { broken }
      """
    Then the response status is 200
    And the GraphQL response reports 1 error

  Scenario: A SOAP 1.1 call has the envelope, the action and the text/xml content type
    When I send a SOAP "1.1" request to "/soap" for the action "urn:Echo" with the body "<Echo/>"
    Then the response field "soap:Envelope.soap:Body.Echo.action" equals "\"urn:Echo\""
    And the response field "soap:Envelope.soap:Body.Echo.contentType" contains "text/xml"

  Scenario: A SOAP 1.2 call uses the soap+xml content type
    When I send a SOAP "1.2" request to "/soap" for the action "urn:Echo" with the body "<Echo/>"
    Then the response field "soap:Envelope.soap:Body.Echo.contentType" contains "application/soap+xml"

  Scenario: A redirect is followed, or returned as it is when asked not to follow
    When I send a GET request to "/redirect"
    Then the response status is 200
    When I send a GET request to "/redirect" without following redirects
    Then the response status is 302
    And the response header "location" is "/users/1"

  Scenario: Changing the base URL changes where relative paths go
    Given the address of the service is stored as "service"
    And the API base URL is "http://127.0.0.1:1"
    And the API base URL is "{{service}}"
    When I send a GET request to "/users"
    Then the response status is 200
