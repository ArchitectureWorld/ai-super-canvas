import { expect, test } from '@playwright/test';

test('runs the structured growth golden path in a browser', async ({ page }) => {
  await page.goto('/');

  const trunk = page.getByLabel('主干活文档');
  await expect(trunk).toBeVisible();
  await trunk.click();
  await page.keyboard.press('Control+A');

  await page.getByRole('button', { name: '＋ 长出分支' }).click();
  await expect(page.getByText(/分支：围绕“从一个清晰的问题开始/)).toBeVisible();

  await page.getByLabel('AI Composer').fill('验证这个分支可以继续生长。');
  await page.getByRole('button', { name: '↑' }).click();
  await expect(page.getByText('验证这个分支可以继续生长。', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: '提炼成果' }).click();
  await page.getByRole('button', { name: '预览 Diff · 滋养主干 →' }).click();
  await page.getByRole('button', { name: '确认回写主干' }).click();

  await expect(trunk).toHaveValue(/## 关于/);
  await page.reload();
  await expect(page.getByLabel('主干活文档')).toHaveValue(/## 关于/);
});
