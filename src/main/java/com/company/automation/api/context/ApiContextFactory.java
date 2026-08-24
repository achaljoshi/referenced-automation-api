package com.company.automation.api.context;

import com.company.automation.api.config.ConfigReader;
import com.microsoft.playwright.APIRequest;
import com.microsoft.playwright.APIRequestContext;
import com.microsoft.playwright.Playwright;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Builds the Playwright {@link Playwright} instance and {@link APIRequestContext}
 * used for pure HTTP API testing - no browser or {@code Page} is ever
 * launched by this framework, keeping API suites fast and headless-by-nature.
 */
public final class ApiContextFactory {

    private static final Logger LOG = LoggerFactory.getLogger(ApiContextFactory.class);

    private ApiContextFactory() {
    }

    public static Playwright createPlaywright() {
        return Playwright.create();
    }

    public static APIRequestContext createContext(Playwright playwright) {
        String baseUrl = ConfigReader.baseUrl();
        LOG.info("Creating APIRequestContext with baseURL='{}'", baseUrl);

        APIRequest.NewContextOptions options = new APIRequest.NewContextOptions()
                .setBaseURL(baseUrl)
                .setIgnoreHTTPSErrors(ConfigReader.ignoreHttpsErrors())
                .setTimeout(ConfigReader.timeoutSeconds() * 1000.0);

        return playwright.request().newContext(options);
    }
}
