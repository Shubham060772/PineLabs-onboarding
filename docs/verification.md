# Verification record

Latest **21 November edge-case audit**: **90 tests passed**, strict TypeScript and production build passed, all **15 stress/browser invariants passed**, and the production dependency audit reported **0 vulnerabilities**. Upload retry duplication, mismatched callback request IDs and optional-field clearing were fixed. See [findings, evidence and limitations](edge-case-audit.md). The records below describe earlier runs.

Verified locally on **20 November 2026**, Windows x64, using the project-local Node 22 runtime and real PostgreSQL 18.7. Docker is not installed on this machine. The Compose file targets PostgreSQL 16; the CI workflow is supplied but has not been executed remotely.

## Automated checks

Latest **stress-testing update**: **75 Vitest tests**, TypeScript checking and production build passed. An isolated HTTP run completed **1,814 measured requests**, including 1,000 reads at concurrency 50, 30 complete workflows and 100 duplicate callbacks, with all invariants satisfied. Six concurrent callers of the real local model passed classification checks. Six reproduced bug categories were fixed, including draft upload loss, stale permissions and extraction races. See [stress-test results, limits and reproduction steps](stress-testing.md). The user's existing application and PAN upload were preserved.

Latest **open-model update**: **69 Vitest unit/integration tests passed**, all **9 Playwright browser journeys passed with `EXTRACTOR=local`**, strict TypeScript and production build passed, and the production dependency audit reported **0 vulnerabilities**. Browser PDF cases used the real local Qwen3-VL reader; structured-evidence journeys remained explicitly synthetic shortcuts. The main demo database was preserved.

Seven direct live-model checks passed using `npm run verify:ai`: newly generated PAN, GST and bank PDFs with fresh identifiers absent from all fixture mappings; PNG input; unrelated OTHER content; unidentifiable UNKNOWN content; and a bank document in the PAN slot. Exact extracted fields matched all generated values. Individual observed reads took roughly 3–27 seconds on this laptop. A separate three-page GST PDF also extracted correctly. These are small synthetic tests, not an accuracy benchmark or evidence of forgery detection. Hosted Anthropic extraction remains untested.

The open-model update supersedes the earlier records below. See [model research and reproducible setup](model-research.md). Live-test summaries are in ignored `.local/ai-verification.json`; model weights are pinned and checksum-verified under the user's local application-data directory.

Latest document-classification update: **66 Vitest tests passed**, **9 Playwright tests passed in 1.5 minutes**, strict TypeScript and production build passed. The four new browser cases upload actual PDF files through the wizard and check valid samples, OTHER, UNKNOWN and extraction failure, including overview badges, blocked checks and mobile layout. The browser suite added synthetic applications to the existing demo without resetting it.

Database tests additionally cover OTHER/UNKNOWN in every slot, wrong-slot replacement and recovery, successful PDF activation, per-document persistence, retry caching and one extraction-success audit per document. The fixture generator now rejects duplicate hashes; this prevents a negative sample from overriding the valid PAN fixture. Live paid Claude extraction was not exercised.

The table below records the earlier baseline verification; the latest test counts above supersede its suite counts. Dependency audit, lockfile, process-restart and reset checks were performed during that baseline and were not rerun for this change.

| Check                                                          | Result                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| TypeScript strict type check                                   | Passed                                                                               |
| Vitest unit and real-PostgreSQL integration tests              | **54 passed**                                                                        |
| Vite production build                                          | Passed                                                                               |
| Full dependency audit                                          | **0 reported vulnerabilities**                                                       |
| npm lockfile consistency (`npm ci --dry-run --ignore-scripts`) | Passed                                                                               |
| pnpm frozen lockfile validation                                | Passed                                                                               |
| API restart during three in-flight checks                      | Passed: ACTIVATED, four passed checks, exactly one merchant-ID audit event           |
| Demo reset after an API restart                                | Passed: child services restarted; all 17 seeded applications reached expected states |

**Playwright: 15 passed in 3.2 minutes**, using `npm run test:e2e -- --repeat-each=3` (five journeys, each repeated three times).

The browser suite covers wizard activation through signed HTTP callbacks; operator-requested GST correction preserving successful PAN/BANK results; operator pages and mobile layout; judgement resolution followed by human approval, provisioning failure and recovery; and merchant bank changes with selective BANK/RISK invalidation. The simulator's reset endpoint was also exercised successfully before restoring the original seed state.

## Coverage against the supplied plan

| Plan tests        | Coverage                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-U1–T-U10        | Identifier formats, GST checksum and cross-reference, name normalization, all 100 application-state pairs, masking, hashes, risk mapping, field reconciliation                                                                                                                                                           |
| Attempt lifecycle | Every pair in the six-state attempt table, including rejection of all transitions from closed attempts                                                                                                                                                                                                                   |
| T-I1–T-I16        | Happy path; all six failure scenarios; bounded retries; selective re-verification; guarded and human approval                                                                                                                                                                                                            |
| T-I17–T-I22       | Early callbacks, callback/timeout race, unmatched inbox, bad/expired signatures, exact duplicates, dispatch outages                                                                                                                                                                                                      |
| T-J1–T-J4         | Backoff, exactly-once dead hook, concurrent claims, stale lease reclamation and fencing                                                                                                                                                                                                                                  |
| T-A1–T-A4         | Ownership, roles, masked responses/audit, file signatures and size                                                                                                                                                                                                                                                       |
| T-D1              | Unique open attempt, merchant and event constraints; audit update rejection                                                                                                                                                                                                                                              |
| T-AI1             | Malformed extraction output rejected by runtime schema                                                                                                                                                                                                                                                                   |
| Additional        | Request correlation through durable jobs; original-byte signed callback; non-retryable HTTP errors; extraction dead-letter/reprocess; audited document access; reject/stale callback; idempotent creation; submit restrictions; operational endpoints; encrypted-value tamper detection; numeric UUID masking regression |

Tests isolate application data in `onboard_test`. Provider adapters are controlled in integration tests. The browser and restart tests use the actual API, worker, independent simulator process, durable callback delivery and signed HTTP requests.

## Evidence

Browser screenshots and `.webm` recordings are generated under `test-results/`. The HTML report is `playwright-report/index.html`. These artifacts contain synthetic data. They are ignored by Git; generate them with `npm run test:e2e`.

Desktop and mobile screenshots and the login page were visually inspected. Mobile application tables scroll inside their containers rather than overflowing the page. Browser tests also fail on uncaught page errors and require successful operational API responses, including populated metrics.

## Not claimed as verified

- Live paid Claude extraction: no API key was supplied; the adapter and output validation exist, while the end-to-end runs use structured/fixture extraction.
- Docker startup and remote CI execution: tooling/workflow is supplied; local execution used embedded PostgreSQL.
- Production load, real providers, real PII, external deployment, calibrated extraction confidence or security certification.
- Three narrated presentation rehearsals: automated browser journeys are recorded; the spoken demo still needs rehearsal by the presenter.

The build emits harmless Rollup notices about annotations in Zod's published package. The build completes successfully. The host's older Node can emit an installation engine warning; project npm scripts use the installed Node 22 runtime, and `.nvmrc` selects Node 22 for standard version managers.
