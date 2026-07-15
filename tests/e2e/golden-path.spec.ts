import { expect, test } from '@playwright/test';

test('creates a branch from a text anchor and explicitly writes its conclusion back', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('ai-super-canvas.gate-0.workspace.v1'));
  await page.reload();

  const trunk = page.getByLabel('主干文本');
  await expect(trunk).toBeVisible();
  await trunk.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(0, 6);
    element.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await page.getByRole('button', { name: '从选区创建分支' }).click();
  await expect(page.getByRole('heading', { name: '围绕“从一个清晰的”的探索' })).toBeVisible();

  await page.getByLabel('分支消息').fill('先验证锚点、分支与回写是否构成可理解的工作流。');
  await page.getByRole('button', { name: '写入分支' }).click();
  await page.getByRole('button', { name: '生成演示结论卡' }).click();
  await expect(page.getByRole('heading', { name: '建议：先完成可回写纵切' })).toBeVisible();

  await page.getByRole('button', { name: '回写主干' }).click();
  await expect(page.getByText('主干修订 2')).toBeVisible();
  await expect(trunk).toContainText('先完成可回写纵切');

  await page.reload();
  await expect(page.getByText('主干修订 2')).toBeVisible();
  await expect(page.getByLabel('主干文本')).toContainText('先完成可回写纵切');
  expect(pageErrors).toEqual([]);
});
