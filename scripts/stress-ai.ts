import { ensureEnv } from './env.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

ensureEnv();
const { localExtract } = await import('../apps/api/src/local-extraction.js');
const { parseExtraction } = await import('../apps/api/src/extraction.js');
const { config } = await import('../apps/api/src/config.js');
const cases = [
  ['pan_card', 'PAN_CARD', 'PAN_CARD'],
  ['gst_certificate', 'GST_CERTIFICATE', 'GST_CERTIFICATE'],
  ['bank_proof', 'BANK_PROOF', 'BANK_PROOF'],
  ['unrelated', 'PAN_CARD', 'OTHER'],
  ['unknown_document', 'PAN_CARD', 'UNKNOWN'],
  ['bank_proof', 'PAN_CARD', 'BANK_PROOF'],
] as const;
const start = Date.now();
const outcomes = await Promise.allSettled(
  cases.map(async ([name, type, expected]) => {
    const began = Date.now();
    const result = parseExtraction(
      await localExtract({
        doc_type: type,
        mime_type: 'application/pdf',
        storage_key: path.relative(
          config.storage,
          path.resolve('fixtures/documents', name + '.pdf'),
        ),
      }),
      type,
    );
    if (result.detected_document_type !== expected)
      throw new Error('Classification mismatch for ' + name);
    return {
      case: name,
      slot: type,
      detected: result.detected_document_type,
      queue_and_read_ms: Date.now() - began,
    };
  }),
);
const report = {
  concurrent_callers: cases.length,
  total_ms: Date.now() - start,
  passed: outcomes.filter((r) => r.status === 'fulfilled').length,
  results: outcomes.map((r) =>
    r.status === 'fulfilled' ? r.value : { error: r.reason?.message ?? 'Read failed' },
  ),
};
await mkdir('.local', { recursive: true });
await writeFile('.local/ai-stress-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (report.passed !== cases.length) process.exitCode = 1;
