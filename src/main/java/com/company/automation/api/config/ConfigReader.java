package com.company.automation.api.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/**
 * Central configuration reader for the API framework and for any project
 * that imports this jar as a Maven dependency. Deliberately independent of
 * {@code referenced-automation-ui}'s own {@code ConfigReader} (different
 * package, {@code com.company.automation.api.config} vs.
 * {@code com.company.automation.config}) so this artifact never collides
 * with it on a classpath that also pulls in the UI framework - exactly the
 * situation {@code referenced-automation-ui-api} is in.
 *
 * <p>Resolution order (highest priority first):
 * <ol>
 *     <li>JVM system property, e.g. {@code -Dbase.url=https://api.example.com}</li>
 *     <li>OS environment variable of the same name (upper-cased, dots -&gt; underscores)</li>
 *     <li>{@code config/config-<env>.properties} on the classpath (env-specific overrides)</li>
 *     <li>{@code config/config.properties} on the classpath (defaults)</li>
 * </ol>
 */
public final class ConfigReader {

    private static final Logger LOG = LoggerFactory.getLogger(ConfigReader.class);
    private static final String BASE_CONFIG = "config/config.properties";
    private static final Properties PROPERTIES = new Properties();

    static {
        load(BASE_CONFIG);
        String env = System.getProperty("env", System.getenv("ENV") != null ? System.getenv("ENV") : "qa");
        load("config/config-" + env + ".properties");
        LOG.info("ConfigReader initialised for env='{}'", env);
    }

    private ConfigReader() {
    }

    private static void load(String classpathResource) {
        try (InputStream in = Thread.currentThread().getContextClassLoader().getResourceAsStream(classpathResource)) {
            if (in == null) {
                LOG.debug("Config resource '{}' not found on classpath - skipping.", classpathResource);
                return;
            }
            Properties fileProps = new Properties();
            fileProps.load(in);
            PROPERTIES.putAll(fileProps);
            LOG.debug("Loaded {} properties from '{}'", fileProps.size(), classpathResource);
        } catch (IOException e) {
            LOG.warn("Failed to load config resource '{}': {}", classpathResource, e.getMessage());
        }
    }

    public static String get(String key) {
        String systemProperty = System.getProperty(key);
        if (systemProperty != null && !systemProperty.isBlank()) {
            return systemProperty;
        }
        String envVar = System.getenv(key.toUpperCase().replace('.', '_'));
        if (envVar != null && !envVar.isBlank()) {
            return envVar;
        }
        return PROPERTIES.getProperty(key);
    }

    public static String get(String key, String defaultValue) {
        String value = get(key);
        return value != null ? value : defaultValue;
    }

    public static int getInt(String key, int defaultValue) {
        String value = get(key);
        if (value == null || value.isBlank()) {
            return defaultValue;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            LOG.warn("Config key '{}' = '{}' is not a valid int, using default {}", key, value, defaultValue);
            return defaultValue;
        }
    }

    public static boolean getBoolean(String key, boolean defaultValue) {
        String value = get(key);
        return value == null || value.isBlank() ? defaultValue : Boolean.parseBoolean(value.trim());
    }

    /** Base URL every relative request path is resolved against - see {@link com.company.automation.api.client.ApiClient}. */
    public static String baseUrl() {
        return get("base.url", "https://reqres.in/api");
    }

    public static long timeoutSeconds() {
        return getInt("api.timeout.seconds", 30);
    }

    public static boolean ignoreHttpsErrors() {
        return getBoolean("api.ignore.https.errors", false);
    }

    /** When true, every request/response is logged at INFO (not just on failure) - handy while developing locally. */
    public static boolean logAllExchanges() {
        return getBoolean("api.log.all.exchanges", false);
    }
}
