# Synthetic upload samples

All PDFs in this directory are fabricated test data, clearly labeled as synthetic. They are not valid identity, tax or banking documents.

1. Open **New application** in the merchant portal.
2. Click **Use PDF sample details**. This fills the matching business, PAN, GSTIN and bank details and selects file upload mode.
3. In **Documents**, upload `documents/pan_card.pdf`, `documents/gst_certificate.pdf` and `documents/bank_proof.pdf` into their corresponding slots. The wizard also provides download links.
4. Submit and watch **Document processing** in Overview. All three should complete. Simulated provider checks then run. Reusing the same identifiers can correctly trigger duplicate review.

The complete matching form is in [sample-application.json](sample-application.json). **Fill synthetic sample** is a separate shortcut that generates fresh structured evidence; its random identifiers will not match these PDFs.

Negative samples:

- `documents/unrelated.pdf`: a grocery list, classified as OTHER. Upload in any slot to require replacement and block provider checks.
- `documents/unknown_document.pdf`: unidentifiable content, classified as UNKNOWN; also requires replacement.
- `documents/wrong_type_pan.pdf`: a bank statement uploaded as PAN; blocked as the wrong document type.
- `documents/blurred_pan.pdf`, `documents/conflicting_pan.pdf`, `documents/low_confidence_gst.pdf`: unreadable, conflicting and low-confidence evidence.

The default `EXTRACTOR=local` uses Qwen3-VL to read the actual PDF/image contents, without an API key. The optional `EXTRACTOR=fixture` mode uses SHA-256 mappings for these exact files. In fixture mode only, unregistered or modified PDFs fail extraction after bounded retries, even if they are genuine. Hosted Claude is an optional alternative using `EXTRACTOR=llm` and an `ANTHROPIC_API_KEY`; it is not required for local reading. See [model setup](../docs/model-research.md). Classification checks document suitability, not authenticity. Provider verification is simulated in this demo.

Run `npm run fixtures` to regenerate the PDFs, hash mappings and public download copies. The generator rejects duplicate PDF hashes to prevent one sample from overriding another.
