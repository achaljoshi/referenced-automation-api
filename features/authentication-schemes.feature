@api
Feature: Authentication schemes
  Each way of proving who you are is accepted by the service, and a wrong proof is not

  Scenario: A wrong password is refused
    Given I am authenticated as "user" with the password "WRONG"
    When I send a GET request to "/protected/basic"
    Then the response status is 401

  Scenario: An API key can travel in the query string
    Given I use the API key "expected-key" in the query parameter "apiKey"
    When I send a GET request to "/protected/apikey"
    Then the response field "authenticated" is true

  Scenario: Two credentials can be sent together
    Given I send the API key "expected-key" in the header "X-API-Key" together with the bearer token "expected-token"
    When I send a GET request to "/headers-echo"
    Then the response field "headers.x-api-key" equals "expected-key"
    And the response field "headers.authorization" equals "Bearer expected-token"

  Scenario: An OAuth2 token is fetched once and reused
    Given I generate a random uuid called "tenant"
    And I am authenticated with OAuth2 client credentials "client" and "secret" at the token path "/oauth/token-counted?tenant={{tenant}}"
    Then the test service has seen 0 calls to "token:{{tenant}}"
    When I send a GET request to "/protected/oauth"
    Then the response field "authenticated" is true
    When I send a GET request to "/protected/oauth"
    Then the response field "authenticated" is true
    When I send a GET request to "/protected/oauth"
    Then the response field "authenticated" is true
    And the test service has seen 1 call to "token:{{tenant}}"

  Scenario: Each new login gets its own OAuth2 token
    Given I generate a random uuid called "tenant"
    And I am authenticated with OAuth2 client credentials "client" and "secret" at the token path "/oauth/token-counted?tenant={{tenant}}"
    When I send a GET request to "/protected/oauth"
    And I am authenticated with OAuth2 client credentials "client" and "secret" at the token path "/oauth/token-counted?tenant={{tenant}}"
    And I send a GET request to "/protected/oauth"
    Then the test service has seen 2 calls to "token:{{tenant}}"

  Scenario: A password login is reused, then refreshed with the refresh token when it expires
    Given I am authenticated with the OAuth2 password grant of "ada" and "lovelace" at the token path "/oauth/password-token"
    When I send a GET request to "/protected/oauth-password"
    Then the response field "token" equals "Bearer password-token"
    When I wait until a GET request to "/protected/oauth-password" returns "token" equal to "Bearer refreshed-token" within 5 seconds
    Then the response field "token" equals "Bearer refreshed-token"

  Scenario: A wrong password fails with the answer of the identity provider
    Given I am authenticated with the OAuth2 password grant of "ada" and "wrong" at the token path "/oauth/password-token"
    When I try to send a GET request to "/protected/oauth-password"
    Then the request fails with a message matching "password grant failed: 401"

  Scenario: A signed JWT is accepted, a wrong secret is not, and an expired one is reported
    Given I am authenticated with a JWT signed with the secret "jwt-secret" for the subject "ada"
    When I send a GET request to "/protected/jwt"
    Then the response status is 200
    And the response field "sub" equals "ada"
    Given I am authenticated with a JWT signed with the secret "other" for the subject "ada"
    When I send a GET request to "/protected/jwt"
    Then the response status is 401
    Given I am authenticated with a JWT signed with the secret "jwt-secret" for the subject "ada" that expired 60 seconds ago
    When I send a GET request to "/protected/jwt"
    Then the response field "error" equals "expired"

  Scenario: A signature covers the method, path, query and body
    Given I sign every request with the HMAC key "key-1" and secret "hmac-secret"
    When I send a GET request to "/protected/hmac" with query parameters:
      | a | 1 |
    Then the response status is 200
    When I send a POST request to "/protected/hmac" with JSON:
      """
      { "amount": 5 }
      """
    Then the response status is 200

  Scenario: A signature made with the wrong secret is rejected
    Given I sign every request with the HMAC key "key-1" and secret "not-the-secret"
    When I send a GET request to "/protected/hmac"
    Then the response status is 401

  Scenario: A session login happens once and its cookie is sent afterwards
    Given I log in with a session cookie as "ada" with the password "lovelace" at the login path "/session/login"
    When I send a GET request to "/protected/session"
    Then the response status is 200
    When I send a GET request to "/protected/session"
    Then the response status is 200

  Scenario: A session login with the wrong password fails
    Given I log in with a session cookie as "ada" with the password "no" at the login path "/session/login"
    When I try to send a GET request to "/protected/session"
    Then the request fails with a message matching "Session login failed: 401"
