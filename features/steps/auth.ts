import { createBdd } from 'playwright-bdd';
import {
  ApiKeyAuth,
  BearerAuth,
  CompositeAuth,
  HmacAuth,
  JwtAuth,
  OAuth2ClientCredentials,
  OAuth2PasswordAuth,
  SessionCookieAuth,
} from '../../src/auth/authProvider';
import { test } from './fixtures';

const { Given } = createBdd(test);

// The token and login endpoints of the in-process test server (tests/support/testServer.ts) live on the same host as the
// API, so a scenario names only their PATH and the step adds the address the API client is pointed at.

Given(
  'I am authenticated with OAuth2 client credentials {string} and {string} at the token path {string}',
  ({ apiClient, vars }, clientId: string, clientSecret: string, tokenPath: string) => {
    apiClient.setAuth(
      new OAuth2ClientCredentials({
        tokenUrl: `${apiClient.getBaseUrl()}${vars.interpolate(tokenPath)}`,
        clientId: vars.interpolate(clientId),
        clientSecret: vars.interpolate(clientSecret),
      }),
    );
  },
);

// A new token is asked for only once the old one has expired (no early refresh), so a short-lived token is seen to expire.
Given(
  'I am authenticated with the OAuth2 password grant of {string} and {string} at the token path {string}',
  ({ apiClient, vars }, username: string, password: string, tokenPath: string) => {
    apiClient.setAuth(
      new OAuth2PasswordAuth({
        tokenUrl: `${apiClient.getBaseUrl()}${vars.interpolate(tokenPath)}`,
        username: vars.interpolate(username),
        password: vars.interpolate(password),
        refreshSkewSeconds: 0,
      }),
    );
  },
);

// The token the test server issues lives one second: this lets that second pass (elapsed time is what is under test).
Given('the one-second access token has expired', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1100));
});

Given(
  'I log in with a session cookie as {string} with the password {string} at the login path {string}',
  ({ apiClient, vars }, username: string, password: string, loginPath: string) => {
    apiClient.setAuth(
      new SessionCookieAuth({
        loginUrl: `${apiClient.getBaseUrl()}${vars.interpolate(loginPath)}`,
        credentials: { username: vars.interpolate(username), password: vars.interpolate(password) },
      }),
    );
  },
);

Given(
  'I am authenticated with a JWT signed with the secret {string} for the subject {string}',
  ({ apiClient, vars }, secret: string, subject: string) => {
    apiClient.setAuth(
      new JwtAuth({ secret: vars.interpolate(secret), claims: { sub: vars.interpolate(subject) } }),
    );
  },
);

Given(
  'I am authenticated with a JWT signed with the secret {string} for the subject {string} that expired {int} seconds ago',
  ({ apiClient, vars }, secret: string, subject: string, seconds: number) => {
    apiClient.setAuth(
      new JwtAuth({
        secret: vars.interpolate(secret),
        claims: { sub: vars.interpolate(subject) },
        expiresInSeconds: -seconds,
      }),
    );
  },
);

Given(
  'I sign every request with the HMAC key {string} and secret {string}',
  ({ apiClient, vars }, keyId: string, secret: string) => {
    apiClient.setAuth(
      new HmacAuth({ keyId: vars.interpolate(keyId), secret: vars.interpolate(secret) }),
    );
  },
);

Given(
  'I use the API key {string} in the query parameter {string}',
  ({ apiClient, vars }, key: string, parameter: string) => {
    apiClient.setAuth(new ApiKeyAuth(parameter, vars.interpolate(key), 'query'));
  },
);

Given(
  'I send the API key {string} in the header {string} together with the bearer token {string}',
  ({ apiClient, vars }, key: string, header: string, token: string) => {
    apiClient.setAuth(
      new CompositeAuth(
        new ApiKeyAuth(header, vars.interpolate(key)),
        new BearerAuth(vars.interpolate(token)),
      ),
    );
  },
);
