import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Bound all input pages and pixels. Never silently skip a page: a later page may
// contain contradictory evidence or a different document.
export async function documentImages(bytes: Buffer, mime: string): Promise<string[]> {
  if (mime !== 'application/pdf') {
    const image = await loadImage(bytes);
    if (image.width * image.height > 24_000_000)
      throw new Error('Image dimensions exceed the supported limit');
    const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
    const canvas = createCanvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return [canvas.toBuffer('image/png').toString('base64')];
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    standardFontDataUrl:
      path.resolve('node_modules/pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 3) throw new Error('Upload at most three pages per document');
    const images: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const maxSide = pdf.numPages > 1 ? 1000 : 1400;
      const viewport = page.getViewport({
        scale: Math.min(2, maxSide / Math.max(base.width, base.height)),
      });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d') as any, viewport }).promise;
      images.push(canvas.toBuffer('image/png').toString('base64'));
      page.cleanup();
    }
    return images;
  } finally {
    await loading.destroy();
  }
}
