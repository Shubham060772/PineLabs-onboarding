import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { demoForm, demoDocuments } from '../packages/shared/src/demo.js';
import type { Extraction, DocType, DetectedDocType } from '../packages/shared/src/index.js';
export async function generateFixtures() {
  await mkdir('fixtures/documents', { recursive: true });
  const mapping: Record<string, Extraction> = {};
  async function document(
    filename: string,
    type: DocType,
    payload: Record<string, string>,
    legibility: 'CLEAR' | 'DEGRADED' | 'UNREADABLE' = 'CLEAR',
    detected: DetectedDocType = type,
    title = type.replaceAll('_', ' '),
  ) {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    const page = pdf.addPage([600, 380]),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawRectangle({ x: 0, y: 0, width: 600, height: 380, color: rgb(0.96, 0.97, 0.99) });
    page.drawText('SYNTHETIC SAMPLE - NOT A REAL DOCUMENT', {
      x: 30,
      y: 340,
      size: 13,
      font,
      color: rgb(0.4, 0.35, 0.7),
    });
    page.drawText(title, { x: 30, y: 295, size: 24, font });
    let y = 250;
    for (const [key, value] of Object.entries(payload)) {
      page.drawText(
        `${key.replaceAll('_', ' ')}: ${legibility === 'UNREADABLE' ? '[illegible]' : value}`,
        {
          x: 30,
          y,
          size: 12,
          font,
          color: legibility === 'DEGRADED' ? rgb(0.75, 0.75, 0.75) : rgb(0.15, 0.2, 0.3),
        },
      );
      y -= 32;
    }
    const bytes = await pdf.save();
    await writeFile(`fixtures/documents/${filename}.pdf`, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (mapping[hash]) throw new Error(`Duplicate fixture content: ${filename}`);
    mapping[hash] = {
      detected_document_type: detected,
      legibility,
      legibility_issues: legibility === 'CLEAR' ? [] : ['Synthetic degraded sample'],
      fields: ['OTHER', 'UNKNOWN'].includes(detected)
        ? {}
        : Object.fromEntries(
            Object.entries(payload).map(([k, v]) => [
              k,
              {
                value: legibility === 'UNREADABLE' ? null : v,
                confidence:
                  legibility === 'DEGRADED' ? 0.6 : legibility === 'UNREADABLE' ? 0 : 0.99,
              },
            ]),
          ),
    };
  }
  const payloads = demoDocuments(demoForm());
  for (const [type, p] of Object.entries(payloads))
    await document(type.toLowerCase(), type as DocType, p);
  await document(
    'blurred_pan',
    'PAN_CARD',
    demoDocuments(demoForm(3, 'Deccan Home Foods')).PAN_CARD,
    'UNREADABLE',
  );
  await document('conflicting_pan', 'PAN_CARD', demoDocuments(demoForm(99)).PAN_CARD);
  await document('low_confidence_gst', 'GST_CERTIFICATE', payloads.GST_CERTIFICATE, 'DEGRADED');
  await document(
    'wrong_type_pan',
    'PAN_CARD',
    payloads.BANK_PROOF,
    'CLEAR',
    'BANK_PROOF',
    'BANK STATEMENT - WRONG UPLOAD SLOT',
  );
  await document(
    'unrelated',
    'PAN_CARD',
    { shopping: 'Apples, rice, tea' },
    'CLEAR',
    'OTHER',
    'GROCERY LIST',
  );
  await document('unknown_document', 'PAN_CARD', {}, 'UNREADABLE', 'UNKNOWN', '???');
  await writeFile('fixtures/extractions.json', JSON.stringify(mapping, null, 2));
  await mkdir('apps/web/public/samples', { recursive: true });
  for (const name of ['pan_card', 'gst_certificate', 'bank_proof', 'unrelated', 'unknown_document'])
    await copyFile(`fixtures/documents/${name}.pdf`, `apps/web/public/samples/${name}.pdf`);
  await writeFile('fixtures/sample-application.json', JSON.stringify(demoForm(), null, 2) + '\n');
  await copyFile(
    'fixtures/sample-application.json',
    'apps/web/public/samples/sample-application.json',
  );
  console.log('Nine synthetic PDF fixtures and matching sample form generated.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await generateFixtures();
