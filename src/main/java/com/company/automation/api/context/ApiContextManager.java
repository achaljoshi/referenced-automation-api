package com.company.automation.api.context;

import com.company.automation.api.diagnostics.Exchange;
import com.microsoft.playwright.APIRequestContext;
import com.microsoft.playwright.Playwright;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Thread-safe holder for the Playwright {@link Playwright}/{@link APIRequestContext}
 * of the currently executing scenario, plus the most recent {@link Exchange}
 * on this thread (used for failure reporting). Backed by {@link ThreadLocal}s
 * so parallel Cucumber execution never leaks a context across threads.
 */
public final class ApiContextManager {

    private static final Logger LOG = LoggerFactory.getLogger(ApiContextManager.class);

    private static final ThreadLocal<Playwright> PLAYWRIGHT_THREAD_LOCAL = new ThreadLocal<>();
    private static final ThreadLocal<APIRequestContext> CONTEXT_THREAD_LOCAL = new ThreadLocal<>();
    private static final ThreadLocal<Exchange> LAST_EXCHANGE_THREAD_LOCAL = new ThreadLocal<>();

    private ApiContextManager() {
    }

    public static void setPlaywright(Playwright playwright) {
        PLAYWRIGHT_THREAD_LOCAL.set(playwright);
    }

    public static void setContext(APIRequestContext context) {
        CONTEXT_THREAD_LOCAL.set(context);
    }

    public static APIRequestContext getContext() {
        APIRequestContext context = CONTEXT_THREAD_LOCAL.get();
        if (context == null) {
            throw new IllegalStateException(
                    "No APIRequestContext bound to the current thread. Make sure "
                            + "com.company.automation.api.hooks.ApiHooks is on the Cucumber glue path "
                            + "(glue = {\"com.company.automation.api.hooks\", ...}).");
        }
        return context;
    }

    public static boolean hasContext() {
        return CONTEXT_THREAD_LOCAL.get() != null;
    }

    public static void recordExchange(Exchange exchange) {
        LAST_EXCHANGE_THREAD_LOCAL.set(exchange);
    }

    public static Exchange getLastExchange() {
        return LAST_EXCHANGE_THREAD_LOCAL.get();
    }

    /** Closes the context and Playwright for the current thread, swallowing any error along the way. */
    public static void quit() {
        APIRequestContext context = CONTEXT_THREAD_LOCAL.get();
        if (context != null) {
            try {
                context.dispose();
            } catch (Exception e) {
                LOG.warn("Error while disposing APIRequestContext: {}", e.getMessage());
            }
        }
        Playwright playwright = PLAYWRIGHT_THREAD_LOCAL.get();
        if (playwright != null) {
            try {
                playwright.close();
            } catch (Exception e) {
                LOG.warn("Error while closing Playwright: {}", e.getMessage());
            }
        }
        CONTEXT_THREAD_LOCAL.remove();
        PLAYWRIGHT_THREAD_LOCAL.remove();
        LAST_EXCHANGE_THREAD_LOCAL.remove();
    }
}
