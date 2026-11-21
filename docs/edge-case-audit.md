# Edge-case audit — 21 November 2026

This pass reviewed upload retries, form edits, callback identity, authorization,
workflow races, duplicate submissions and final-state presentation. It used
isolated PostgreSQL databases; existing applications and personal uploads were
preserved.

## Reproduced and fixed

| Issue                                                                               | Result after the fix                                                                                                                                          | Regression evidence                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeating an identical upload created redundant document-history rows.              | Identical file bytes or structured fields return the current document ID under the application lock. A different document still replaces the active evidence. | Five concurrent uploads of each source type produce one document and one upload audit event. The stress database also contains one history record after 20 identical uploads. |
| A callback could use a different provider request ID from the acknowledged request. | The callback is rejected before applying its result; the pending attempt remains unchanged. Callbacks arriving before acknowledgement remain supported.       | Mismatched callback rejection followed by successful application of the correct callback; existing early-callback and race tests pass.                                        |
| Clearing optional fields in the editor silently retained their previous values.     | Empty text is submitted, and a null patch explicitly clears the optional pincode. Empty required fields produce validation errors.                            | API regression and browser save/reload assertions for trade name and pincode; account-holder and IFSC corrections still preserve the account number.                          |

## Verification

- `npm run check`: **90 tests passed**, strict TypeScript and production build passed.
- `npm run test:stress`: all **15 invariants passed** with over **1,800 measured HTTP requests**, plus browser interactions.
- 60 concurrent/repeated create requests produced one application; 20 duplicate submissions were rejected.
- 30 workflows activated with exactly one merchant-ID event each.
- 1,000 reads at concurrency 50: all returned HTTP 200; observed p95 **176.66 ms**.
- 100 duplicate signed callbacks were processed once.
- Invalid-input requests returned expected client errors; ownership checks denied access.
- Rate-limit burst: 300 successful responses and 100 expected HTTP 429 responses; service remained healthy.
- Browser checks covered draft upload retention, edits, review consistency across roles/tabs, rejection closure, invalid-document display and repeated-wizard recovery.
- `npm audit --omit=dev`: **0 reported vulnerabilities**.

Local reports are in ignored `.local/stress-report.json`,
`.local/audit-check.log` and `.local/audit-dependencies.json`.
The stress report for this pass was generated at `2026-11-20T20:46:38.383Z`
(21 November in India).

These checks use simulated verification providers and fixture extraction. This
pass did not rerun the live OCR model or establish document authenticity. Results
describe this local run, not a guarantee that every bug has been eliminated or a
production capacity benchmark. The existing model-test record is in
[verification.md](verification.md).
