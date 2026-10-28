@api
Feature: Paging through results
  Every page is read, by page number or by following the cursor the service reports

  Scenario: Every page is collected by page number
    When I collect every page of "/page-items" by page number with:
      | items                | items    |
      | page size parameter  | pageSize |
      | page size            | 2        |
      | stop when fewer than | 2        |
    Then the collected items are:
      """
      [{ "id": 1 }, { "id": 2 }, { "id": 3 }, { "id": 4 }, { "id": 5 }]
      """

  Scenario: Cursors are followed to the end
    When I collect every page of "/cursor-items" by cursor with:
      | items       | items |
      | next cursor | next  |
    Then the collected items are:
      """
      [{ "id": 1 }, { "id": 2 }, { "id": 3 }, { "id": 4 }, { "id": 5 }]
      """
