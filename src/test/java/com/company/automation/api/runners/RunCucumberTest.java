package com.company.automation.api.runners;

import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

/**
 * Full regression entry point: {@code mvn test} (via the Surefire include
 * pattern {@code **}{@code /Run*.java}) discovers this class and runs every
 * {@code .feature} file under {@code src/test/resources/features}.
 *
 * <p>Glue path, plugin list (Extent/Allure/StepLogger/rerun-file/etc.) and
 * parallel execution are configured once in {@code junit-platform.properties}
 * so they stay identical locally and in CI.
 *
 * <p>Consuming projects should copy this pattern in their own repo, pointing
 * {@code cucumber.glue} at their own step-definitions package in addition to
 * {@code com.company.automation.api.hooks}.
 */
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
public class RunCucumberTest {
}
