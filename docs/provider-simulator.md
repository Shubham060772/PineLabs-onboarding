# Provider simulator: purpose and every control

Open `http://localhost:5173/ops/simulator` while signed in as an **operator**.
The page is available when demo mode is enabled. It lets a presenter control
how the separate simulated PAN, GST, bank, risk and merchant-core services will
answer **future** requests. This demonstrates real asynchronous HTTP dispatch,
signed callbacks, retries and recovery without an external verification
account. It does not establish that a PAN, GSTIN, bank account or document is
genuine.

The normal setup is simple: create a draft as the merchant, add a scenario rule
on this page before submitting it, submit, then watch the application's
**Checks** and **Timeline** tabs. For a provisioning scenario, add the
merchant-core rule before the application reaches approval.

## Form controls

| Control                 | What it does                                                                                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider**            | Chooses `pan`, `gst`, `bank`, `risk` or `merchant-core`. PAN/GST/BANK run after document validation; RISK waits for all three to pass; merchant-core runs after approval.                                                                                                                           |
| **Behavior**            | Chooses the response pattern described below. The initial selection is GST `FAIL`.                                                                                                                                                                                                                  |
| **Callback delay (ms)** | Time from accepting a verification request to delivering its callback. Range: 0–120,000 ms. The default input is 2,000 ms. The simulator uses at least 18,000 ms for `LATE_CALLBACK`, regardless of a smaller entered value. This setting has no callback to delay for `HTTP_503` or `NO_CALLBACK`. |
| **Matching requests**   | How many future requests may consume this rule, from 1 to 100. The remaining count falls when the provider accepts or rejects a matching request; it is not a callback count. Set 1 for a single failure followed by normal behavior.                                                               |
| **Application**         | Select one application or **All applications**. A targeted rule takes priority over a global rule. The menu loads up to 100 applications from the API.                                                                                                                                              |
| **Risk band**           | Appears for `RISK_BAND`; choose LOW, MEDIUM or HIGH. It affects the risk provider only. The simulator emits matching scores of 10, 45 or 90.                                                                                                                                                        |
| **Add scenario rule**   | Saves the rule. It changes future matching provider requests. Already accepted requests keep their saved response and scheduled delivery.                                                                                                                                                           |
| **Scenario rules**      | Lists saved rules, remaining request uses, delay and target application. `OPEN` means uses remain; `COMPLETED` means the rule is exhausted. The list refreshes every two seconds.                                                                                                                   |
| **Reset all**           | Deletes all scenario rules and restores normal responses for future requests. It does not delete applications, accepted provider requests, check attempts, callback history or audit events. It does not undo a callback already scheduled.                                                         |

The page automatically sends `GSTIN_CANCELLED` as the reason for a GST `FAIL`
rule and `VERIFICATION_FAILED` for other failures. Duplicate callbacks are
fixed at **three deliveries** per matching request on this page. The API schema
supports a `repeats` value, but the UI does not expose a control for it. The
page also always sends a risk band value in the rule; that value is only used
for `RISK_BAND` on the risk provider.

## Behaviors and expected outcome

| Behavior             | Simulated response                                                                                             | What to look for                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUCCESS`            | Provider accepts the request and sends a successful callback after the delay.                                  | The check passes, provided prior validation and dependencies are clear. This is also the default when no rule matches.                      |
| `FAIL`               | PAN/GST/BANK send `NOT_VERIFIED`; RISK sends a HIGH score/band; merchant-core returns an unavailable response. | A required check fails and the application goes In Review. A merchant-core outage may end in Provisioning Failed after job retries.         |
| `NO_CALLBACK`        | Verification request is acknowledged but no callback is sent.                                                  | The attempt times out; policy may create a new attempt. After the allowed attempts, the check is timed out and review is required.          |
| `LATE_CALLBACK`      | Success callback is scheduled at least 18 seconds after acceptance.                                            | With the default 15-second provider timeout, the first attempt times out; the late callback is recorded without overwriting a newer result. |
| `DUPLICATE_CALLBACK` | The same callback event is delivered three times.                                                              | One event applies; later deliveries increase its `delivery_count` and are ignored for the check result.                                     |
| `HTTP_503`           | Verification or merchant-core request returns HTTP 503 immediately.                                            | The dispatch job retries with backoff; after its limit, an error or provisioning failure appears in the application and Dead letters.       |
| `RISK_BAND`          | The risk service returns the chosen band and a consistent score.                                               | LOW passes; MEDIUM passes as a raw provider result but creates `RISK_REVIEW`; HIGH fails.                                                   |

The simulator form displays every behavior for every provider, but some
combinations have no special meaning. `RISK_BAND` only changes `risk`.
`NO_CALLBACK`, `LATE_CALLBACK` and `DUPLICATE_CALLBACK` are callback patterns
for PAN/GST/BANK/RISK; merchant-core returns a direct HTTP response and has no
callback. For a merchant-core outage, choose `HTTP_503` or `FAIL`.

## How matching works

Rules are stored in PostgreSQL. When a provider request arrives, the simulator
first looks for an unused rule for that provider and application. A rule tied
to the application wins over a global rule; among equally specific rules, the
newest wins. The selected rule's remaining count is decremented. If no unused
rule matches, the provider responds successfully with a two-second callback
delay. The entire accepted request, response, callback and delivery schedule
are stored before the service replies, so a simulator restart does not change
an already accepted request.

The scenario is consumed when a **new provider request** is dispatched, not
when a draft is created and not when the button is clicked. A document that
fails intake validation never reaches the provider. A RISK rule remains unused
until PAN, GST and BANK all pass. A merchant-core rule remains unused until
approval. Existing completed checks will not rerun merely because a rule was
added. Use a new application, a requested correction, or an allowed operator
rerun to generate a new request.

## Reliable demonstrations

| Goal                        | Set before dispatch                                                                                 | Observe                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GST API failure             | GST → FAIL → select draft → 1 matching request, then submit.                                        | GST check fails, risk stays blocked, operator can request a correction or rerun the failed GST check.                                                           |
| Retry after provider outage | PAN/GST/BANK → HTTP_503 → target draft → 1 matching request.                                        | First dispatch fails, later job retry uses the default success response after the rule is exhausted.                                                            |
| Missing response            | PAN/GST/BANK → NO_CALLBACK → target draft.                                                          | Attempt timeout, retry and eventual review if no later attempt succeeds. Set Matching requests high enough to cover all attempts when demonstrating exhaustion. |
| Duplicate delivery          | BANK → DUPLICATE_CALLBACK → target draft.                                                           | Three deliveries, one applied callback; the Checks tab and Metrics show duplicates.                                                                             |
| Late response               | PAN → LATE_CALLBACK → target draft.                                                                 | Timeout and retry; the original event appears as late in the attempt history.                                                                                   |
| Manual risk review          | RISK → RISK_BAND → MEDIUM → target draft.                                                           | All provider checks may show passed, but the application remains In Review until the risk exception is resolved and approved.                                   |
| Merchant-core outage        | merchant-core → HTTP_503 → target draft → enough matching requests to exhaust provisioning retries. | Approval remains; Provisioning Failed and a dead job appear. Operator can retry provisioning after the rule is exhausted or reset.                              |

For **unreadable or unrelated evidence**, upload a poor, wrong-slot, `OTHER`
or `UNKNOWN` document in the merchant wizard. The simulator cannot create this
case because document classification happens **before** provider dispatch. A
bank-change demonstration also starts from the merchant application page: the
new bank input invalidates BANK and RISK and causes new requests. The simulator
can then control those new responses.

The **Six failures** line at the bottom of the page is a reminder of demo
scenarios, not a button. The operator **Dead letters** page shows exhausted
jobs and unmatched callbacks; **Metrics** summarizes status, checks, callback
outcomes and duplicate deliveries. The application **Checks** tab is the best
place to see each request ID, attempt, deadline and callback outcome.

## Safety of the demo controls

Only an operator can use the page, and the API rejects scenario operations
when `DEMO_MODE` is off. The browser calls the application API, which validates
the rule and forwards it to the simulator using a separate secret. These
controls affect simulated services; they do not edit stored document findings
or directly set application approval. Decisions still pass through the same
workflow guards described in [system-design.md](system-design.md).
