package com.company.automation.api.hooks;

import com.company.automation.api.context.ApiContextFactory;
import com.company.automation.api.context.ApiContextManager;
import com.company.automation.api.diagnostics.Exchange;
import com.microsoft.playwright.APIRequestContext;
import com.microsoft.playwright.Playwright;
import io.cucumber.java.After;
import io.cucumber.java.Before;
import io.cucumber.java.Scenario;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Reusable Cucumber hooks shipped as part of the framework jar.
 *
 * <p>Add this package to the {@code glue} path of your Cucumber runner
 * alongside your own step-definition package(s) and every scenario
 * automatically gets: a fresh {@code APIRequestContext} per scenario, the
 * last request/response attached to the report on failure (picked up by
 * both the Extent adapter and the Allure plugin - the API-testing
 * equivalent of a UI framework's failure screenshot), and guaranteed
 * cleanup even if the scenario throws.
 *
 * <pre>{@code
 * @Suite
 * @IncludeEngines("cucumber")
 * @SelectClasspathResource("features")
 * @ConfigurationParameter(key = GLUE_PROPERTY_NAME,
 *         value = "com.company.automation.api.hooks,com.mycompany.myproject.stepdefinitions")
 * public class RunCucumberTest { }
 * }</pre>
 */
public class ApiHooks {

    private static final Logger LOG = LoggerFactory.getLogger(ApiHooks.class);

    @Before(order = 0)
    public void setUp(Scenario scenario) {
        LOG.info("Provisioning APIRequestContext for scenario: {}", scenario.getName());
        Playwright playwright = ApiContextFactory.createPlaywright();
        APIRequestContext context = ApiContextFactory.createContext(playwright);

        ApiContextManager.setPlaywright(playwright);
        ApiContextManager.setContext(context);
    }

    @After(order = 0)
    public void tearDown(Scenario scenario) {
        try {
            if (scenario.isFailed()) {
                attachLastExchange(scenario);
            }
        } finally {
            LOG.info("Closing APIRequestContext for scenario: {} [{}]", scenario.getName(), scenario.getStatus());
            ApiContextManager.quit();
        }
    }

    private void attachLastExchange(Scenario scenario) {
        Exchange exchange = ApiContextManager.getLastExchange();
        if (exchange == null) {
            return;
        }
        scenario.attach(exchange.toReportString(), "text/plain", "Last API call: " + scenario.getName());
    }
}
