# Referenced Automation API Framework

Enterprise-grade reference API test automation framework - **Playwright Java (`APIRequestContext`) + Cucumber 7 + Java 17 + Maven** - wrapped in a fluent `given().when().<verb>()` client so it reads as easily as REST Assured while actually running on Playwright.

It is built to be **imported as a Maven dependency**, exactly like any other library in your Nexus repository:

```xml
<dependency>
    <groupId>com.company.automation</groupId>
    <artifactId>referenced-automation-api</artifactId>
    <version>1.0.0</version>
</dependency>
```

## Why Playwright for pure API testing?

Playwright Java ships `APIRequestContext` - a full HTTP client (cookies, base URL, default headers, TLS options, connection reuse) independent of any browser. Building this framework on it, rather than REST Assured or a raw HTTP client, means:

- **One dependency stack across the whole `referenced-automation-*` family.** `referenced-automation-ui` and `referenced-automation-sap` already pull in Playwright for browser automation; this framework and `referenced-automation-ui-api` reuse the exact same engine for API calls - one library to version, patch and understand instead of two.
- **UI + API in one session when it matters.** A `BrowserContext`'s cookies/storage state can be shared with an `APIRequestContext` (see Playwright's `storageState()`), which is exactly what `referenced-automation-ui-api` uses to set up data via API and verify via UI (or vice versa) without juggling two unrelated HTTP stacks.
- **The trade-off, named honestly:** REST Assured has a larger, more API-testing-specific assertion vocabulary (JSONPath/XMLPath matchers, schema validation, response specs) out of the box. This framework's `ApiResponseWrapper` (see below) deliberately covers the 90% case - status, headers, JSON body, JSON Pointer lookups - in a small, easy-to-read surface, and leans on `referenced-automation-utils`' `JsonUtils`/`YamlUtils` for anything more elaborate rather than reimplementing a matcher library.

## What's included

| Capability | How |
|---|---|
| Import as a dependency | Plain `jar` packaging, published to Nexus via `mvn deploy` |
| Fluent, REST-Assured-style client | `ApiClient.given()...when().get/post/put/patch/delete(path)` over Playwright's `APIRequestContext` |
| Easy assertions | `ApiResponseWrapper.shouldHaveStatus/shouldBeOk/shouldHaveHeader/shouldContain(...)` - chainable, throw a plain `AssertionError` with the response body inlined for a fast diagnosis |
| JSON handling | `asJson(Class)`, `asMap()`, `asJsonNode()`, `jsonPath("/pointer")` - delegates to `referenced-automation-utils`' `JsonUtils` |
| Thread-safe parallel execution | `ApiContextManager` (`ThreadLocal` per Playwright/`APIRequestContext`) + Cucumber's JUnit-Platform parallel engine |
| Config management | `ConfigReader` - env-specific properties files, overridable by `-D` system properties or OS env vars |
| Reporting - Extent | `tech.grasshopper:extentreports-cucumber7-adapter` |
| Reporting - Allure | `allure-cucumber7-jvm` |
| Failure diagnostics | The last request/response on a scenario's thread is attached to the report on failure - the API-testing equivalent of a UI framework's failure screenshot |
| Console/CI step logging | `StepLoggerPlugin` + Log4j2 (console + `logs/automation.log`) |
| Retry logic | Cucumber rerun-file pattern, wired into both CI pipelines and `scripts/retry-failed.sh` |
| Reusable Cucumber hooks | `ApiHooks` (context create/dispose + failure exchange attach) - ships in the jar, just add it to your `glue` path |
| CI/CD | `.gitlab-ci.yml` **and** `.github/workflows/ci.yml` (build/test/report/deploy) |
| IntelliJ zero-config | `.idea/` checked in: prompts to install the Cucumber+Gherkin plugins, ships working run configurations |
| No local Maven install needed | Maven Wrapper (`./mvnw`) |

## Project layout

```
referenced-automation-api/
├── pom.xml
├── mvnw, mvnw.cmd, .mvn/
├── .gitlab-ci.yml, .github/workflows/ci.yml
├── .idea/
├── settings.xml.sample
├── scripts/retry-failed.sh
│
├── src/main/java/com/company/automation/api/     <-- SHIPPED IN THE JAR
│   ├── client/{ApiClient,ApiRequestSpec,ApiResponseWrapper}.java
│   ├── context/{ApiContextFactory,ApiContextManager}.java
│   ├── config/ConfigReader.java
│   ├── diagnostics/Exchange.java
│   ├── reporting/StepLoggerPlugin.java
│   ├── hooks/ApiHooks.java
│   └── exceptions/ApiFrameworkException.java
├── src/main/resources/
│   ├── config/config*.properties
│   ├── log4j2.xml
│   ├── extent.properties, extent-spark-config.xml, allure.properties
│
└── src/test/                          <-- NOT SHIPPED, sample/demo only
    ├── java/com/company/automation/api/{stepdefinitions,runners}/...
    └── resources/{features/posts.feature, junit-platform.properties}
```

## Quick start (working in this repo)

This framework depends on `referenced-automation-utils`. It is not yet
published to Nexus, so build and `install` it locally first (once it's
published, this step becomes unnecessary - `pom.xml` already pins the
version):

```bash
git clone https://github.com/achaljoshi/referenced-automation-utils.git
(cd referenced-automation-utils && ./mvnw -q -DskipTests install)

git clone https://github.com/achaljoshi/referenced-automation-api.git
cd referenced-automation-api
./mvnw clean test                       # env=qa by default, against the public JSONPlaceholder API
./mvnw -Dtest=RunSmokeTest test          # only @smoke-tagged scenarios
./scripts/retry-failed.sh                # run, and retry only what failed (mirrors CI)
```

The sample suite (`posts.feature`) targets [JSONPlaceholder](https://jsonplaceholder.typicode.com) - a free, no-auth demo REST API. It accepts every write (POST/PUT/PATCH/DELETE) and responds as if it succeeded, but nothing is actually persisted server-side; that's expected behaviour of the demo API, not a framework bug, and is called out in the feature file itself.

Reports land under `target/`, same locations as `referenced-automation-ui`:

- `target/extent-report/ExtentSparkReport.html`
- `target/allure-results/` (`allure serve target/allure-results`)
- `target/cucumber-reports/{cucumber.json,cucumber.xml,rerun.txt}`
- `logs/automation.log`

## Using this as a dependency in another project

1. **Add both dependencies** (`referenced-automation-utils` is a transitive dependency of this jar, but Maven still needs it resolvable - see [Publishing to Nexus](#publishing-to-nexus)):

   ```xml
   <dependency>
       <groupId>com.company.automation</groupId>
       <artifactId>referenced-automation-api</artifactId>
       <version>1.0.0</version>
   </dependency>
   ```

2. **Call the client from your step definitions** - no setup code needed, `ApiHooks` (see step 3) already created the context for this scenario:

   ```java
   import static com.company.automation.api.client.ApiClient.given;
   import com.company.automation.api.client.ApiResponseWrapper;

   public class OrderSteps {
       private ApiResponseWrapper response;

       @When("I fetch order {string}")
       public void fetchOrder(String orderId) {
           response = given()
               .bearerToken(authToken)
               .when()
               .get("/orders/" + orderId);
       }

       @Then("the order status should be {string}")
       public void verifyStatus(String expectedStatus) {
           response.shouldHaveStatus(200);
           assertEquals(expectedStatus, response.jsonPath("/status").asText());
       }
   }
   ```

3. **Point your Cucumber glue path at both packages**:

   ```properties
   cucumber.glue=com.company.automation.api.hooks,com.yourcompany.yourproject.stepdefinitions
   cucumber.plugin=pretty, \
     com.company.automation.api.reporting.StepLoggerPlugin, \
     com.aventstack.extentreports.cucumber.adapter.ExtentCucumberAdapter:, \
     io.qameta.allure.cucumber7jvm.AllureCucumber7Jvm
   ```

4. **Override config** (`base.url`, timeouts, ...) via your own `config/config-<env>.properties` on your classpath, or `-D`/env-var overrides - same precedence rules as every other framework in this family.

## Configuration

All configuration goes through `com.company.automation.api.config.ConfigReader`. Resolution order (highest wins):

1. `-Dkey=value` JVM system property
2. OS environment variable (`base.url` → `BASE_URL`)
3. `config/config-<env>.properties` (`-Denv=qa`, default `qa`)
4. `config/config.properties` (framework defaults)

| Key | Default | Meaning |
|---|---|---|
| `base.url` | `https://jsonplaceholder.typicode.com` | resolved against every relative request path |
| `api.timeout.seconds` | `30` | Playwright `APIRequestContext` default timeout |
| `api.ignore.https.errors` | `false` | set true for self-signed certs in lower environments |
| `api.log.all.exchanges` | `false` | log every request/response at INFO, not just the last one on failure |
| `env` | `qa` | selects `config-<env>.properties` |

## The client, in full

```java
ApiResponseWrapper response = ApiClient.given()
    .header("X-Correlation-Id", correlationId)
    .bearerToken(token)
    .queryParam("page", "2")
    .jsonBody(newOrderPayload)          // serializes via JsonUtils + sets Content-Type
    .when()
    .post("/orders");

response
    .shouldHaveStatus(201)
    .shouldHaveHeader("content-type", "application/json; charset=utf-8");

Order created = response.asJson(Order.class);
String orderId = response.jsonPath("/data/id").asText();
```

`given()` always binds to the `APIRequestContext` that `ApiHooks` created for the current thread/scenario - there is no context object to pass around manually.

## Reporting & failure diagnostics

Same dual Extent + Allure setup as the rest of the family. There is no
screenshot to attach for a pure API failure, so instead `ApiHooks` attaches
the **last request/response exchange on the failing scenario's thread** -
method, URL, headers, body, status, response headers, response body and
duration - as a plain-text Cucumber attachment, visible in both the Extent
HTML report and Allure.

## Logging

`StepLoggerPlugin` (identical pattern to `referenced-automation-ui`'s, duplicated rather than shared - see the class Javadoc for why) logs every scenario/step through SLF4J → Log4j2 to console + `logs/automation.log`. `ApiRequestSpec` additionally logs every call at `INFO` (`METHOD path -> status (Nms)`) and the full exchange at `DEBUG` (or `INFO` if `api.log.all.exchanges=true`).

## Retry logic

Identical rerun-file pattern to `referenced-automation-ui` - see that repo's README for the full rationale. `cucumber-junit-platform-engine` has no built-in retry-count property; failed scenarios are written to `target/cucumber-reports/rerun.txt` and re-run once via `-Dcucumber.features=@<file>`, implemented identically in `.gitlab-ci.yml`, `.github/workflows/ci.yml` and `scripts/retry-failed.sh`.

## CI/CD

Both pipelines run the same stages: **install referenced-automation-utils** (a bring-up step - see the comment at the top of each CI file - needed only until that library is published to Nexus) → **build** → **test** (with retry) → **report** (Allure to Pages) → **deploy** (Nexus, main/tags only). API suites need no browser/driver installation step at all, unlike `referenced-automation-ui`/`-sap` - just a JDK.

## Publishing to Nexus

Identical convention to the rest of the family:

```bash
export NEXUS_RELEASE_URL="https://nexus.yourcompany.com/repository/maven-releases/"
export NEXUS_SNAPSHOT_URL="https://nexus.yourcompany.com/repository/maven-snapshots/"
./mvnw -s settings.xml deploy
```

Locally: copy `settings.xml.sample` to `~/.m2/settings.xml`. In CI, both pipelines generate an equivalent `settings.xml` on the fly from protected secret variables.

## IntelliJ IDEA setup

Just **open the project** - `.idea/` is checked in:

- `.idea/externalDependencies.xml` prompts to install the **Cucumber for Java** and **Gherkin** plugins (IntelliJ Ultimate).
- `.idea/runConfigurations/` ships *Regression (RunCucumberTest)*, *Smoke (RunSmokeTest)*, and *Maven: clean test*.
- `.idea/misc.xml` pins the project SDK to Java 17.

## Extending the framework

- **More assertion helpers**: add methods to `ApiResponseWrapper` following the existing `shouldHave*` pattern (throw `AssertionError` with the response body inlined for fast diagnosis).
- **Request/response logging filters**: `ApiRequestSpec.execute(...)` is the single choke point every call goes through - add cross-cutting behaviour (e.g. request signing via `referenced-automation-utils`' `CryptoUtils`) there.
- **New environment**: drop a `config/config-<env>.properties` on the classpath, run with `-Denv=<name>`.
- **Version bumps**: every dependency/plugin version is a property at the top of `pom.xml`; run `./mvnw versions:display-dependency-updates` before bumping.

## A note on verification

Authored and statically verified without a working Maven Central connection
in the build sandbox (see `referenced-automation-ui`'s README for the full
explanation). Every Playwright API surface used here (`APIRequestContext`,
`RequestOptions`, `APIResponse`, `Playwright.request()`) was checked against
the actual `microsoft/playwright-java` source rather than trusted from
memory. It has **not** been compiled or executed end-to-end - please run
`./mvnw clean test` yourself (after installing `referenced-automation-utils`
locally, see "Quick start") or let CI do it before relying on a release build.
