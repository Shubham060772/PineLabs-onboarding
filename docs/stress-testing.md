# Stress testing and bug fixes — 20 November 2026

The final HTTP run passed all ten asserted invariants. Tests used a new PostgreSQL database and a separate upload directory; the user's application and uploaded PAN were preserved. The API was restarted with the fixes and its health check confirmed local extraction remained enabled.

## Uploaded PAN

The locally uploaded PAN image completed extraction with Qwen3-VL 2B. Its document classification was PAN_CARD and both its name and PAN number matched the entered form. The application remains NEEDS_INFO because the supplied GSTIN does not embed the entered PAN; the GST legal name and bank account holder also differ from the form. Provider checks have correctly not started. No personal identifier or extracted name is included in this report.

This verifies extraction and reconciliation of that upload, not government verification or document authenticity. PAN/GST/bank/risk providers remain simulated.

## Reproduced bugs fixed

| Bug                                                               | Correction and regression coverage                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save draft discarded selected files                               | Supplied evidence is uploaded when saving a draft, even with other slots empty. A real Chromium upload through Vite's API proxy verifies the file exists afterward.                                                             |
| Low-confidence extracted names could pass automatically           | Matching text also requires clear evidence and confidence of at least 0.8; uncertain names produce a review exception. An integration test confirms a 0.1-confidence name cannot auto-approve.                                  |
| Overlapping extraction workers could validate discarded output    | Final validation reloads the winning persisted extraction and encrypted fields inside the application transaction. A synchronized two-worker test verifies a losing OTHER response cannot reject a saved BANK_PROOF extraction. |
| Different Hindi names could compare as identical                  | Name normalization preserves Unicode letters, marks and numbers, applies NFKC, and rejects empty normalized comparisons. Unit tests cover different/same Hindi names, punctuation-only inputs and composed/decomposed accents.  |
| Deleted accounts and demoted operators retained token permissions | Authenticated requests reload the current account and role. Integration tests verify deleted accounts return 401 and demoted operators lose operator access.                                                                    |
| Unsupported request content types returned 500                    | Unsupported media types return 415 with a safe error response. Both integration and HTTP burst tests cover this.                                                                                                                |

## Measured HTTP run

Run completed at 2026-11-20 17:00:38 UTC on the local Windows machine. The measured phases contain **1,814 HTTP requests**, excluding browser requests and background provider traffic. No measured request returned a 5xx response.

| Exercise                                               | Result                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| 60 concurrent create attempts with one idempotency key | Exactly one application                                                  |
| 20 racing replacements in one document slot            | Exactly one active document                                              |
| Cross-owner access                                     | Denied with 404                                                          |
| 60 invalid-input requests                              | Expected 400/404/415 responses, no server errors                         |
| 30 complete workflows with 90 document submissions     | All activated; exactly one merchant and one merchant-ID audit event each |
| 20 repeat submissions                                  | All rejected with 409                                                    |
| 1,000 reads at concurrency 50                          | All 200; p50 180.69 ms, p95 270.33 ms, maximum 563.03 ms                 |
| 100 duplicate signed callbacks at concurrency 40       | One inbox event, delivery count 100, applied once                        |
| 400-request burst from one address                     | 300 allowed, 100 expected 429 responses                                  |
| Health request from another address after the burst    | 200                                                                      |
| Chromium draft with one selected PAN PDF               | File retained; no page errors                                            |

The workflow load test uses deterministic fixture extraction and actual HTTP provider simulators. It does **not** measure 30 simultaneous live-model workflows. Separately, six concurrent callers of the real local Qwen model passed classification checks for PAN, GST, bank, OTHER, UNKNOWN and a bank document submitted in the PAN slot. The initial live-model run completed in 54.9 seconds including serialized queue time; the final run through the reusable script passed all six cases in 56.9 seconds. The command below repeats this check and records current timings.

`npm run check` passed: **75 unit/integration tests**, strict TypeScript checking and production build. The production build emitted only dependency-comment annotation warnings from Zod. A separate type check also covers the new reusable AI stress script. The earlier nine-journey browser suite was not repeated against the user's database during this run; the draft regression ran against an isolated database.

## Reproduce

Start local PostgreSQL and install Playwright Chromium (`npx playwright install chromium`) if needed. Run from the repository root:

```sh
npm run check
npm run test:stress
# With the local model server running (npm run ai:start):
npm run test:stress:ai
```

The HTTP test requires database creation permission and free ports **3101, 3102 and 5174**. It creates `onboard_stress_<timestamp>` and `.local/stress-storage/<timestamp>`, seeds only test users, and starts/stops its own API, provider simulator, worker and Vite instance. It leaves the isolated database and files available for investigation. It does not reset or seed the main application database. Do not run multiple instances of this harness simultaneously because its service ports are fixed.

Latest machine-readable output is in `.local/stress-report.json` and `.local/ai-stress-report.json`. These ignored local files are overwritten by subsequent runs. `npm run test:stress -- --browser-only` runs only the isolated draft regression and also replaces the HTTP report.

These are bounded local stress and regression tests, not a production capacity benchmark, comprehensive security audit, or proof that every bug has been found. The local model queues inference serially, so document latency increases under concurrency. Confidence scores remain uncalibrated, and sample classification success is not forgery detection.
