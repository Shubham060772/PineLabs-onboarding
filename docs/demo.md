# Demo walkthrough

Run `npm run demo:reset` with the dev launcher active. Sign in again after reset. Keep merchant and operator in separate tabs. All examples use synthetic information.

1. **0:00–0:30:** Show the operator overview. Explain the single database, explicit transitions and the boundary between extraction and decisions.
2. **0:30–1:30:** Merchant → New application → Fill synthetic sample → continue through the wizard → submit. Open Checks while callbacks arrive. Show the merchant ID and timeline after activation.
3. **1:30–2:30:** Operator → Review queue → Malabar Spice Traders. Show failed GST and missing approval action. Request corrected evidence or rerun GST after its one-shot failure rule. The automated browser test demonstrates the full merchant correction loop.
4. **2:30–3:15:** Deccan Home Foods → show the specific unreadable PAN request and lack of dispatched checks. Fields & documents → view the synthetic evidence.
5. **3:15–4:00:** Nilgiri → Checks → three BANK deliveries, one applied event. Konkan → Checks → timeout, retry, late original callback.
6. **4:00–5:00:** Merchant → Aravalli → change bank details with structured matching proof. Observe new BANK/RISK cycles and preserved PAN/GST. On an activated case, show that editing is unavailable.
7. **5:00–5:45:** Operator → Sahyadri → Retry provisioning with a note. Show activation, one merchant ID and the preserved failed job in Dead letters.
8. **5:45–6:30:** Metrics and simulator panel. Explain what is simulated and what runs for real. If time permits, `npm run verify:restart` demonstrates process recovery.

The Playwright suite records local `.webm` videos under `test-results/` and captures desktop/mobile screenshots. It is repeatable using `npm run test:e2e -- --repeat-each=3`. These are browser test recordings, not a narrated presentation. Rehearse the spoken walkthrough before presenting.
