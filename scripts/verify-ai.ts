import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { localExtract } from '../apps/api/src/local-extraction.js';
import { parseExtraction } from '../apps/api/src/extraction.js';
import { documentImages } from '../apps/api/src/document-images.js';
import { uniqueDemoForm, demoDocuments } from '../packages/shared/src/demo.js';
import { DOC_TYPES, type DocType } from '../packages/shared/src/index.js';

await mkdir('storage/ai-verification', { recursive: true });
const form = uniqueDemoForm('Open Model Test Store Private Limited');
const docs = demoDocuments(form);
const reports: any[] = [];
const fixtures = JSON.parse(await readFile('fixtures/extractions.json', 'utf8'));
for (const type of DOC_TYPES) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([700, 450]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('SYNTHETIC TEST SAMPLE - NOT A REAL DOCUMENT', { x: 25, y: 410, size: 16, font });
  page.drawText(type.replaceAll('_', ' '), { x: 25, y: 365, size: 22, font });
  let y = 315;
  for (const [key, value] of Object.entries(docs[type])) {
    page.drawText(`${key.replaceAll('_', ' ')}: ${value}`, { x: 25, y, size: 13, font });
    y -= 35;
  }
  const bytes = Buffer.from(await pdf.save());
  if (fixtures[createHash('sha256').update(bytes).digest('hex')])
    throw new Error('Live test must not use a known fixture');
  await writeFile(`storage/ai-verification/${type}.pdf`, bytes);
}
async function check(
  name: string,
  type: DocType,
  key: string,
  mime: string,
  detected: string,
  expected?: Record<string, string>,
) {
  const start = Date.now();
  const result = parseExtraction(
    await localExtract({ doc_type: type, storage_key: key, mime_type: mime }),
    type,
  );
  const correct =
    result.detected_document_type === detected &&
    (!expected ||
      Object.entries(expected).every(([key, value]) => result.fields[key]?.value === value));
  reports.push({
    name,
    detected: result.detected_document_type,
    elapsed_ms: Date.now() - start,
    passed: correct,
  });
  console.log(JSON.stringify(reports.at(-1)));
  await writeFile(
    '.local/ai-verification.json',
    JSON.stringify({ model: 'qwen3-vl-2b', timestamp: new Date().toISOString(), reports }, null, 2),
  );
  if (!correct) throw new Error(`Live model verification failed: ${name}`);
}
for (const type of DOC_TYPES)
  await check(
    `novel ${type}`,
    type,
    `ai-verification/${type}.pdf`,
    'application/pdf',
    type,
    docs[type],
  );
const png = (
  await documentImages(await readFile('storage/ai-verification/PAN_CARD.pdf'), 'application/pdf')
)[0];
await writeFile('storage/ai-verification/pan.png', Buffer.from(png, 'base64'));
await check(
  'PNG upload',
  'PAN_CARD',
  'ai-verification/pan.png',
  'image/png',
  'PAN_CARD',
  docs.PAN_CARD,
);
await check(
  'unrelated content',
  'GST_CERTIFICATE',
  '../fixtures/documents/unrelated.pdf',
  'application/pdf',
  'OTHER',
);
await check(
  'unknown content',
  'PAN_CARD',
  '../fixtures/documents/unknown_document.pdf',
  'application/pdf',
  'UNKNOWN',
);
await check(
  'bank uploaded as PAN',
  'PAN_CARD',
  'ai-verification/BANK_PROOF.pdf',
  'application/pdf',
  'BANK_PROOF',
);
console.log('All seven live model checks passed. No fixture extraction was used.');
