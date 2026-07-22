import { expect, test } from '@playwright/test';

test('creates a branch from a text anchor and explicitly writes its conclusion back', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.removeItem('ai-super-canvas.gate-0.workspace.v1');
    localStorage.removeItem('ai-super-canvas.gate-0.canvas-layout.v1');
  });
  await page.reload();

  const trunk = page.getByRole('textbox', { name: '主干活文档' });
  await expect(trunk).toBeVisible();
  await trunk.click();
  await page.keyboard.press('Control+A');
  await page.getByRole('button', { name: '＋ 长出分支' }).click();
  await expect(page.getByText(/分支：围绕“从一个清晰的问题开始/)).toBeVisible();

  await page.getByLabel('AI Composer').fill('先验证锚点、分支与回写是否构成可理解的工作流。');
  await page.getByRole('button', { name: '↑' }).click();
  await expect(
    page.getByText('先验证锚点、分支与回写是否构成可理解的工作流。', {
      exact: true,
    }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: '提炼成果' }).click();

  await page.getByRole('button', { name: '预览 Diff · 滋养主干 →' }).click();
  await page.getByRole('button', { name: '确认回写主干' }).click();
  await expect(trunk).toHaveValue(/## 关于/);
  const storedLayout = await page.evaluate(() => (
    localStorage.getItem('ai-super-canvas.gate-0.canvas-layout.v1')
  ));
  expect(storedLayout).not.toBeNull();
  expect(JSON.parse(storedLayout!).selectedNodeId).not.toBe('trunk');

  await page.reload();
  await expect(page.getByRole('textbox', { name: '主干活文档' })).toHaveValue(/## 关于/);
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem('ai-super-canvas.gate-0.canvas-layout.v1')
  ))).toBe(storedLayout);
  expect(pageErrors).toEqual([]);
});
