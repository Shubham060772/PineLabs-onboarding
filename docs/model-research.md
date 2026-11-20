# Document model choice and live setup

Researched and tested on 20 November 2026. The objective is real reading of uploaded PDF/image contents, without a paid API key or a hash lookup.

## Choice

Use **Qwen3-VL-2B-Instruct**, Q4_K_M model weights with the Q8_0 vision projector, through **llama.cpp**. The model is Apache-2.0 licensed and supports visual input. The official [Qwen GGUF repository](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF) provides the weights; [llama.cpp's multimodal documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md) documents its local image API.

This machine has about 8 GB system RAM and an AMD Radeon RX 6500M with 4 GB VRAM. The installed weights total approximately 1.55 GB. We use its discrete GPU (`Vulkan1` on this machine), one generation slot and a 4096-token context. The choice is based on these resource limits and our upload tests, not a claim that 2B is the most accurate model available.

| Candidate   | Evidence and tradeoff                                                                                                          | Decision                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Qwen3-VL 2B | Open Apache-2.0 vision model, small enough for this machine; real extraction tested                                            | Selected                                                       |
| Qwen3-VL 4B | Apache-2.0 vision model; [Ollama's 4B package](https://ollama.com/library/qwen3-vl:4b) is 3.3 GB before runtime/context memory | Candidate for a machine with more memory; not benchmarked here |
| Gemma 3 4B  | [Multimodal model](https://ollama.com/library/gemma3:4b), 3.4 GB Ollama package, distributed under Gemma terms                 | Not selected for this constrained laptop; not benchmarked here |
| Claude      | Hosted proprietary model, account/API credentials required                                                                     | Optional existing adapter, not needed for this demo            |

Ollama is also a valid local runtime and provides [JSON-schema structured outputs](https://docs.ollama.com/capabilities/structured-outputs), but this implementation uses the smaller standalone llama.cpp Windows Vulkan runtime. Its OpenAI-compatible HTTP format is only a protocol: no OpenAI service or key is used.

## Run

```powershell
npm install
npm run ai:setup
npm run dev
```

The setup script downloads pinned official artifacts, verifies SHA-256 checksums, and stores them under `%LOCALAPPDATA%\OnboardAI`. It writes paths into ignored `.local/ai-runtime.json`. It does not change machine-wide settings. The dev launcher starts the model server when local extraction is enabled and no server is already listening. `npm run ai:start` can also run the model independently.

```dotenv
EXTRACTOR=local
LOCAL_MODEL_NAME=qwen3-vl-2b
LOCAL_MODEL_URL=http://127.0.0.1:8081/v1
LOCAL_MODEL_TIMEOUT_MS=180000
LOCAL_MODEL_DEVICE=Vulkan1
```

Device identifiers vary by machine. Use the installed `llama-server.exe --list-devices` to choose; leave `LOCAL_MODEL_DEVICE` empty for runtime selection. The automated installer targets Windows x64. Other platforms can install llama.cpp separately and serve the same model at `LOCAL_MODEL_URL`.

The server binds to loopback only. Document bytes are read locally, rendered into images and sent to that local endpoint. No document content is sent to Anthropic or another cloud service in local mode. Request bodies and raw model errors are not logged or stored in audit events.

## Upload behavior

- PDF, PNG and JPEG contents are read by the model. PDFs may contain at most three pages. Every accepted PDF page is rendered; excess pages are rejected, not silently omitted.
- A constrained JSON response is validated with the shared runtime schema. Declared form identifiers are not sent to the model, so it must read them from the document.
- OTHER, UNKNOWN and wrong-slot documents block provider verification. The model does not establish authenticity or approve the merchant.
- Invalid PDFs, unavailable models, truncated outputs and invalid model responses fail extraction. There is no automatic fallback to pre-recorded fixture answers.
- The overview preserves successful document extractions, displays actual failures and explains blocked checks. Long calls renew the durable job lease. Only one local generation is active at a time.
- A 2B model can still misread text or misclassify unfamiliar documents. Per-field confidence is self-reported, not calibrated; deterministic format and form comparisons remain necessary.

`npm run verify:ai` generates new synthetic PAN/GST/bank PDFs with random identifiers, confirms their hashes do not exist in fixture mappings, then tests the actual model. It also checks PNG input, OTHER, UNKNOWN and wrong-slot content. Results are written to `.local/ai-verification.json` without extracted identifiers. These tests use fabricated data only.

The sample download PDFs remain clearly labeled synthetic. Choose **Use PDF sample details** in the wizard before uploading them. Reusing their identifiers may trigger duplicate review. Structured demo evidence remains available as an explicit test shortcut; it bypasses the model.

## What remains simulated

Document reading, validation, workflow, persistence, retries and the UI run for real. Government PAN/GST lookups, bank verification, risk and merchant provisioning are still simulated HTTP providers. Production verification needs real provider credentials/contracts. A synthetic GST record can test upload and extraction, but cannot demonstrate a real tax registration.

## Optional Anthropic access

If hosted Claude is preferred later, create a Claude Console account, obtain an API key through the official [API key setup](https://platform.claude.com/docs/en/get-api-key), and configure API billing/credits as described in [Claude's billing documentation](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage). Put the key in the local `.env`, set `EXTRACTOR=llm`, choose an available `EXTRACTION_MODEL`, and restart the API. Do not put the key in frontend code or commit it. This route is optional and has not been live-tested here.
