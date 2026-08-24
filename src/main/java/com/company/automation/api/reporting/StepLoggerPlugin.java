package com.company.automation.api.reporting;

import io.cucumber.plugin.ConcurrentEventListener;
import io.cucumber.plugin.event.EventPublisher;
import io.cucumber.plugin.event.HookTestStep;
import io.cucumber.plugin.event.HookType;
import io.cucumber.plugin.event.PickleStepTestStep;
import io.cucumber.plugin.event.Status;
import io.cucumber.plugin.event.TestCaseFinished;
import io.cucumber.plugin.event.TestCaseStarted;
import io.cucumber.plugin.event.TestStepFinished;
import io.cucumber.plugin.event.TestStepStarted;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Cucumber plugin that logs every scenario and every step to SLF4J/Log4j2 as
 * it runs, so execution is visible step-by-step both on a developer's
 * console and in raw CI job logs (GitLab/GitHub Actions), independent of
 * whichever HTML/Allure/Extent report is produced afterwards.
 *
 * <p>This is an intentional, self-contained duplicate of
 * {@code referenced-automation-ui}'s plugin of the same name (different
 * package: {@code com.company.automation.api.reporting} vs.
 * {@code com.company.automation.reporting}) - keeping this framework
 * independently importable without a dependency on the UI framework, the
 * same reasoning documented on {@code com.company.automation.api.config.ConfigReader}.
 *
 * <p>Registered by fully-qualified class name in {@code cucumber.plugin}
 * (see {@code junit-platform.properties}) - no constructor arguments, so no
 * ":path" suffix is needed in the plugin string.
 */
public class StepLoggerPlugin implements ConcurrentEventListener {

    private static final Logger LOG = LoggerFactory.getLogger("cucumber.steps");

    @Override
    public void setEventPublisher(EventPublisher publisher) {
        publisher.registerHandlerFor(TestCaseStarted.class, this::onTestCaseStarted);
        publisher.registerHandlerFor(TestStepStarted.class, this::onTestStepStarted);
        publisher.registerHandlerFor(TestStepFinished.class, this::onTestStepFinished);
        publisher.registerHandlerFor(TestCaseFinished.class, this::onTestCaseFinished);
    }

    private void onTestCaseStarted(TestCaseStarted event) {
        LOG.info("================================================================");
        LOG.info("SCENARIO START : {}", event.getTestCase().getName());
        LOG.info("FEATURE        : {}", event.getTestCase().getUri());
        LOG.info("TAGS           : {}", event.getTestCase().getTags());
        LOG.info("================================================================");
    }

    private void onTestStepStarted(TestStepStarted event) {
        if (event.getTestStep() instanceof PickleStepTestStep step) {
            LOG.info(">> STEP: {} {}", step.getStep().getKeyword(), step.getStep().getText());
        } else if (event.getTestStep() instanceof HookTestStep hook) {
            LOG.debug(">> HOOK [{}]: {}", hookType(hook), hook.getCodeLocation());
        }
    }

    private void onTestStepFinished(TestStepFinished event) {
        Status status = event.getResult().getStatus();
        long durationMs = event.getResult().getDuration().toMillis();
        if (event.getTestStep() instanceof PickleStepTestStep step) {
            if (status == Status.PASSED) {
                LOG.info("<< STEP {} ({} ms): {}", status, durationMs, step.getStep().getText());
            } else if (status == Status.SKIPPED || status == Status.PENDING) {
                LOG.warn("<< STEP {} ({} ms): {}", status, durationMs, step.getStep().getText());
            } else {
                LOG.error("<< STEP {} ({} ms): {}", status, durationMs, step.getStep().getText());
                if (event.getResult().getError() != null) {
                    LOG.error("Step failure detail:", event.getResult().getError());
                }
            }
        }
    }

    private void onTestCaseFinished(TestCaseFinished event) {
        Status status = event.getResult().getStatus();
        if (status == Status.PASSED) {
            LOG.info("SCENARIO {}  : {}", status, event.getTestCase().getName());
        } else {
            LOG.error("SCENARIO {}  : {}", status, event.getTestCase().getName());
        }
        LOG.info("================================================================\n");
    }

    private String hookType(HookTestStep hook) {
        HookType type = hook.getHookType();
        return type != null ? type.name() : "HOOK";
    }
}
