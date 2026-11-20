import { it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { documentImages } from '../apps/api/src/document-images.js';
import { localExtract, localSchema } from '../apps/api/src/local-extraction.js';
import { parseExtraction } from '../apps/api/src/extraction.js';
afterEach(() => vi.unstubAllGlobals());
it('renders PDF pages into actual PNGs and rejects malformed or oversized-page documents', async () => {
  const images = await documentImages(
    await readFile('fixtures/documents/gst_certificate.pdf'),
    'application/pdf',
  );
  expect(images).toHaveLength(1);
  expect(Buffer.from(images[0], 'base64').subarray(1, 4).toString()).toBe('PNG');
  await expect(
    documentImages(Buffer.from('%PDF-not-a-document'), 'application/pdf'),
  ).rejects.toThrow();
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage();
  await expect(documentImages(Buffer.from(await pdf.save()), 'application/pdf')).rejects.toThrow(
    'three pages',
  );
});
it('sends image content and constrained schema to the model without declared form identifiers', async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              detected_document_type: 'OTHER',
              legibility: 'CLEAR',
              legibility_issues: [],
              fields: {},
            }),
          },
        },
      ],
    }),
  });
  vi.stubGlobal('fetch', fetch);
  const output = parseExtraction(
    await localExtract({
      doc_type: 'PAN_CARD',
      storage_key: '../../fixtures/documents/unrelated.pdf',
      mime_type: 'application/pdf',
    }),
    'PAN_CARD',
  );
  expect(output.detected_document_type).toBe('OTHER');
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(request.messages[1].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  expect(request.response_format.json_schema.schema).toEqual(localSchema('PAN_CARD'));
  expect(
    request.response_format.json_schema.schema.properties.detected_document_type.enum,
  ).toContain('UNKNOWN');
  expect(output.fields.pan_number.value).toBeNull();
});
it('fails closed on an unavailable model or truncated response; never substitutes fixtures', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    });
  vi.stubGlobal('fetch', fetch);
  const doc = {
    doc_type: 'PAN_CARD',
    storage_key: '../../fixtures/documents/pan_card.pdf',
    mime_type: 'application/pdf',
  };
  await expect(localExtract(doc)).rejects.toThrow('503');
  await expect(localExtract(doc)).rejects.toThrow('incomplete');
});
