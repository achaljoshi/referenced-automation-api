package com.company.automation.api.runners;

import org.junit.platform.suite.api.ConfigurationParameter;
import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

import static io.cucumber.junit.platform.engine.Constants.FILTER_TAGS_PROPERTY_NAME;

/**
 * Fast, tag-filtered entry point for pre-merge / pipeline gating: runs only
 * scenarios tagged {@code @smoke}. Everything else (glue, plugins, reporting)
 * is inherited from {@code junit-platform.properties}, same as
 * {@link RunCucumberTest}.
 */
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
@ConfigurationParameter(key = FILTER_TAGS_PROPERTY_NAME, value = "@smoke")
public class RunSmokeTest {
}
