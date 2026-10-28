@api @regression
Feature: Logging in under load and when things go wrong
  Many requests share one login, an expired session logs in again once, and a failed login never repeats a credential

  Scenario: Parallel first requests share one token request
    Given I generate a random uuid called "tenant"
    And I am authenticated with OAuth2 client credentials "client" and "secret" at the token path "/oauth/token-counted?tenant={{tenant}}"
    When I send 8 GET requests to "/protected/oauth" at the same time
    Then all 8 responses have the status 200
    And the test service has seen 1 call to "token:{{tenant}}"

  Scenario: Parallel requests on an expired token do not race a rotating refresh token
    Given I generate a random uuid called "tenant"
    And I am authenticated with the OAuth2 password grant of "ada" and "lovelace" at the token path "/oauth/rotating-token?tenant={{tenant}}"
    When I send a GET request to "/protected/rotating"
    Then the response status is 200
    Given the one-second access token has expired
    When I send 6 GET requests to "/protected/rotating" at the same time
    Then all 6 responses have the status 200
    And the test service has seen 1 call to "rot:{{tenant}}:password"
    And the test service has seen 1 call to "rot:{{tenant}}:refresh"

  Scenario: Parallel first requests share one session login
    Given I generate a random uuid called "tenant"
    And I log in with a session cookie as "ada" with the password "lovelace" at the login path "/session/login-counted?tenant={{tenant}}"
    When I send 5 GET requests to "/protected/session-counted?tenant={{tenant}}" at the same time
    Then all 5 responses have the status 200
    And the test service has seen 1 call to "login:{{tenant}}"

  Scenario: A token is fetched again after a failure
    Given I generate a random uuid called "tenant"
    And I am authenticated with OAuth2 client credentials "client" and "WRONG" at the token path "/oauth/token-counted?tenant={{tenant}}"
    When I try to send a GET request to "/protected/oauth"
    Then the request fails with a message matching "token request failed: 401"
    When I try to send a GET request to "/protected/oauth"
    Then the request fails with a message matching "token request failed: 401"

  Scenario: A failed token request shows only the standard error fields, with the credentials masked
    Given I am authenticated with OAuth2 client credentials "client" and "sup3r-s3cret-value" at the token path "/oauth/token-error"
    When I try to send a GET request to "/protected/oauth"
    Then the request fails with a message matching "token request failed: 400 \(invalid_client: client secret \[REDACTED\] is not valid\)"
    And the failure message does not contain "sup3r-s3cret-value"
    And the failure message does not contain "debug"
    And the failure message does not contain "received"

  Scenario: A failed login does not repeat the credentials it was sent
    Given I generate a random uuid called "tenant"
    And I log in with a session cookie as "ada" with the password "wrong-pw-xyz" at the login path "/session/login-counted?tenant={{tenant}}"
    When I try to send a GET request to "/protected/session-counted"
    Then the request fails with the message "Session login failed: 401 (bad login)"
    And the failure message does not contain "wrong-pw-xyz"

  Scenario: A session that expired logs in again, once
    Given I generate a random uuid called "tenant"
    And I log in with a session cookie as "ada" with the password "lovelace" at the login path "/session/login-counted?tenant={{tenant}}"
    When I send a GET request to "/protected/session-counted?tenant={{tenant}}"
    Then the response field "sid" equals "s1"
    When I send a GET request to "/session/expire?tenant={{tenant}}"
    And I send a GET request to "/protected/session-counted?tenant={{tenant}}"
    Then the response status is 200
    And the response field "sid" equals "s2"
    And the test service has seen 2 calls to "login:{{tenant}}"

  Scenario: A request that is still refused after the new login is returned as refused, with no loop
    Given I generate a random uuid called "tenant"
    And I log in with a session cookie as "ada" with the password "lovelace" at the login path "/session/login-counted?tenant={{tenant}}"
    When I send a GET request to "/protected/basic"
    Then the response status is 401
    And the test service has seen 2 calls to "login:{{tenant}}"
