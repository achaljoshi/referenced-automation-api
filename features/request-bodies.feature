@api @regression
Feature: Request bodies and parameters
  Form, XML, multipart, query and header data all arrive as sent

  Scenario: A form
    When I send a POST request to "/form-echo" with form data:
      | username | ada |
      | plan     | pro |
    Then the response field "received.username" equals "ada"
    And the response field "received.plan" equals "pro"

  Scenario: XML
    When I send a POST request to "/xml-echo" with XML:
      """
      <user><name>{{random:first-name}}</name></user>
      """
    Then the response status is 200
    And the response header "content-type" contains "xml"
    And the response body contains "received"

  Scenario: Query parameters, one at a time and as a table
    Given I set the query parameter "q" to "lovelace"
    When I send a GET request to "/search" with query parameters:
      | page  | 2    |
      | limit | 10   |
    Then the response field "query.q" equals "lovelace"
    And the response field "query.page" equals "2"
    And the response field "query.limit" equals "10"

  Scenario: A query parameter set for one request does not leak into the next
    Given I set the query parameter "once" to "yes"
    When I send a GET request to "/search"
    Then the response field "query.once" equals "yes"
    When I send a GET request to "/search"
    Then the response field "query.once" does not exist

  Scenario: Headers set for the scenario are sent on every request
    Given I set the header "X-Trace-Id" to "trace-{{uuid}}"
    And I set the headers:
      | X-Tenant | acme   |
      | X-Env    | sample |
    When I send a GET request to "/headers-echo"
    Then the response field "headers.x-tenant" equals "acme"
    And the response field "headers.x-env" equals "sample"
    And the response field "headers.x-trace-id" matches "trace-[0-9a-f-]{36}"
    And the response field "headers.x-correlation-id" is not empty

  Scenario: A file upload
    When I upload the file "tests/support/fixture.txt" as "file" to "/upload"
    Then the response field "file.originalname" equals "fixture.txt"
    And the response field "file.size" matches "\d+"

  Scenario: A raw body
    When I send a POST request to "/users" with the raw body "{\"name\":\"raw\"}"
    Then the response status is 201
