@api @regression
Feature: Paging fails loudly instead of returning partial data
  A page that fails, a service that never ends or a cursor that loops is an error, not a short list

  Scenario: A page that is not a success fails with its number and status
    When I try to collect every page of "/paged/fail-on-2" by page number with:
      | items | items |
    Then the request fails with a message matching "failed on page 2: status 500"
    When I try to collect every page of "/paged/cursor-401" by cursor with:
      | items       | items |
      | next cursor | next  |
    Then the request fails with a message matching "failed on page 2 \(cursor \"c2\"\): status 401"

  Scenario: Reaching the page limit with more data left is an error that names the limit
    When I try to collect every page of "/paged/endless" by page number with:
      | items     | items |
      | max pages | 3     |
    Then the request fails with a message matching "stopped after maxPages \(3\) with more data"
    When I try to collect every page of "/paged/cursor-endless" by cursor with:
      | items       | items |
      | next cursor | next  |
      | max pages   | 3     |
    Then the request fails with a message matching "stopped after maxPages \(3\)"

  Scenario: Truncation can be accepted on purpose
    When I collect every page of "/paged/endless" by page number with:
      | items            | items |
      | max pages        | 3     |
      | allow truncation | true  |
    Then I have collected 6 items
    When I collect every page of "/paged/cursor-endless" by cursor with:
      | items            | items |
      | next cursor      | next  |
      | max pages        | 2     |
      | allow truncation | true  |
    Then I have collected 4 items

  Scenario: A limit reached exactly when the data ends is not an error
    When I collect every page of "/page-items" by page number with:
      | items                | items    |
      | page size parameter  | pageSize |
      | page size            | 2        |
      | stop when fewer than | 2        |
      | max pages            | 3        |
    Then I have collected 5 items

  Scenario: An empty cursor means there is no more
    When I collect every page of "/paged/cursor-empty-end" by cursor with:
      | items       | items |
      | next cursor | next  |
    Then the collected items are:
      """
      [{ "id": 11 }, { "id": 12 }, { "id": 21 }, { "id": 22 }]
      """

  Scenario: A cursor that comes back again is a loop
    When I try to collect every page of "/paged/cursor-loop" by cursor with:
      | items       | items |
      | next cursor | next  |
    Then the request fails with a message matching "cursor \"same\" came back again on page 2 \(cursor \"same\"\)"

  Scenario: Items that are not a list are an error
    When I try to collect every page of "/page-items" by page number with:
      | items     | items.0 |
      | max pages | 1       |
    Then the request fails with a message matching "is not an array"
