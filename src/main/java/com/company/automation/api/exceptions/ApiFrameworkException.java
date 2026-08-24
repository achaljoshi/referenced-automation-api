package com.company.automation.api.exceptions;

/**
 * Unchecked exception for framework-level failures (bad config, context
 * setup problems, etc.) so they are clearly distinguishable from
 * Playwright's own {@code PlaywrightException} or plain assertion failures
 * in reports and logs.
 */
public class ApiFrameworkException extends RuntimeException {

    public ApiFrameworkException(String message) {
        super(message);
    }

    public ApiFrameworkException(String message, Throwable cause) {
        super(message, cause);
    }
}
