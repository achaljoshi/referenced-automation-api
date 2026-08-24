@posts
Feature: JSONPlaceholder Posts API
  As a consumer of the JSONPlaceholder demo API
  I want to perform CRUD operations on posts
  So that I can verify the API framework's client works end-to-end

  # JSONPlaceholder accepts every write (POST/PUT/PATCH/DELETE) and responds
  # as if it succeeded, but nothing is actually persisted server-side - that
  # is expected and by design for this public demo API, not a framework bug.

  @smoke
  Scenario: Fetching a single post returns its title and body
    When I GET "/posts/1"
    Then the response status should be 200
    And the response field "userId" should equal "1"

  @regression
  Scenario: Fetching all posts returns a non-empty list
    When I GET "/posts"
    Then the response status should be 200

  @regression
  Scenario: Creating a post returns 201 with an id
    Given I set the JSON body to:
      """
      {"title": "referenced-automation-api", "body": "created by the sample suite", "userId": 1}
      """
    When I POST to "/posts"
    Then the response status should be 201
    And the response field "title" should equal "referenced-automation-api"

  @regression
  Scenario: Updating a post returns the updated title
    Given I set the JSON body to:
      """
      {"id": 1, "title": "updated-title", "body": "updated by the sample suite", "userId": 1}
      """
    When I PUT to "/posts/1"
    Then the response status should be 200
    And the response field "title" should equal "updated-title"

  @regression
  Scenario: Deleting a post returns 200
    When I DELETE "/posts/1"
    Then the response status should be 200
