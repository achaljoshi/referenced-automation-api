@api @smoke
Feature: Test data that is unique, fresh or comes from the environment

  Scenario: Values are made up on the fly and remembered
    Given I set the variable "customer" to "ACME-{{random:alnum(5)}}"
    And I generate a random email called "login"
    And I generate a random uuid called "orderId"
    And I generate a random "number(100,200)" called "quantity"
    Then the variable "customer" matches "ACME-[A-Za-z0-9]{5}"
    And the variable "login" matches ".+@.+"
    And the variable "orderId" matches "[0-9a-f-]{36}"
    And the variable "quantity" matches "1\d\d|200"

  Scenario: Dates are relative to today
    Given the date 0 days from today is stored as "today"
    And the date 7 days from today is stored as "nextWeek"
    Then the variable "today" matches "\d{4}-\d{2}-\d{2}"
    And the variable "nextWeek" is not empty

  Scenario: Environment values come with a fallback when optional
    Given I set the variable "region" to "{{env:FEATURE_SAMPLE_REGION|eu-west}}"
    Then the variable "region" equals "eu-west"
    Given I read the environment variable "ENV" into "environment"
    Then the variable "environment" is not empty
