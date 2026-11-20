import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { DOC_TYPES } from '../../packages/shared/src/index.js';

for (const scenario of ['valid', 'unrelated', 'unknown_document', 'extraction_failure'] as const) {
  test(`PDF upload: ${scenario} has accurate overview and document statuses`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/login');
    await page.getByRole('button', { name: 'Merchant Submit & track' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('link', { name: 'New application', exact: true }).click();
    await page.getByRole('button', { name: 'Use PDF sample details' }).click();
    for (let i = 0; i < 3; i++)
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    for (const [index, type] of DOC_TYPES.entries()) {
      const input = page.locator('input[type=file]').nth(index);
      if (index === 0 && scenario === 'extraction_failure') {
        await input.setInputFiles({
          name: 'corrupt-sample.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.7\nThis file is corrupt and has no PDF objects.'),
        });
      } else {
        const filename = index === 0 && scenario !== 'valid' ? scenario : type.toLowerCase();
        await input.setInputFiles(`fixtures/documents/${filename}.pdf`);
      }
    }
    const download = await request.get('/samples/pan_card.pdf');
    expect(download.ok()).toBe(true);
    expect(await download.body()).toEqual(await readFile('fixtures/documents/pan_card.pdf'));
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Submit application', exact: true }).click();
    await expect(page).toHaveURL(/\/merchant\/applications\/[a-f0-9-]+$/);
    const pan = page.getByTestId('document-PAN_CARD');
    await expect(page.getByTestId('document-GST_CERTIFICATE').locator('.badge')).toHaveText(
      'Completed',
      { timeout: 180000 },
    );
    await expect(page.getByTestId('document-BANK_PROOF').locator('.badge')).toHaveText(
      'Completed',
      { timeout: 180000 },
    );
    if (scenario === 'valid') {
      await expect(pan.locator('.badge')).toHaveText('Completed');
      await expect(page.getByText('4 of 4 checks passed')).toBeVisible({ timeout: 45000 });
    } else {
      await expect(pan.locator('.badge')).toHaveText(
        scenario === 'extraction_failure' ? 'Failed' : 'Needs Info',
      );
      await expect(page.locator('.check-grid .badge')).toHaveText([
        'Blocked',
        'Blocked',
        'Blocked',
        'Blocked',
      ]);
      if (scenario === 'extraction_failure') {
        await expect(pan).toContainText('A reviewer can reprocess', { timeout: 45000 });
      } else {
        await expect(pan).toContainText(
          scenario === 'unrelated' ? 'Detected: Other' : 'Detected: Unknown',
        );
      }
    }
    await page.screenshot({ path: `test-results/upload-${scenario}.png`, fullPage: true });
    await page.getByRole('tab', { name: 'Fields & documents', exact: true }).click();
    await expect(page.getByText('Extraction is pending', { exact: true })).toHaveCount(0);
    if (scenario === 'extraction_failure')
      await expect(page.getByText('Extraction failed', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
