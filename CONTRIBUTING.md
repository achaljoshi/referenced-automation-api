# Contributing to referenced-automation-api

The shared rules (tests with negative controls, no hard waits, no secrets, ADRs, review checklist, deprecation policy) are in
[`referenced-automation-utils/docs/governance/CONTRIBUTING.md`](../referenced-automation-utils/docs/governance/CONTRIBUTING.md).
Release and upgrade steps: [`RELEASING.md`](../referenced-automation-utils/docs/governance/RELEASING.md). Decisions: [`docs/adr`](../referenced-automation-utils/docs/adr/README.md).

## Before you push
```bash
npm run lint && npm run typecheck && npm test && npm run security
```
```powershell
npm run lint; npm run typecheck; npm test; npm run security     # Windows PowerShell 5.1 has no &&
```

`npm test` builds first (`pretest`) and runs the drift guards: `tests/envDocs.spec.ts` (a variable the code reads must be documented in `.env.example` and the README "Configuration reference" table, a secret in `.env.local.example`; a documented variable must still be read) and `tests/windowsDocs.spec.ts` (every `bin` has an npm script; docs say `npm run curl-to-tests -- ...` inside this repo and `npx api-curl-to-playwright` only for a project that depends on this package). Add or rename an environment variable: update those three files in the same change.

Update `CHANGELOG.md`. This repo is in the chain `utils` -> `api`/`ui` -> `sap` -> `ui-api`: repackage after a change and re-test `ui-api`.
