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

test('shows the composer only inside the selected branch panel', async ({ page }) => {
  await page.goto('/');

  const trunk = page.getByRole('textbox', { name: '主干活文档' });
  await expect(trunk).toBeVisible();
  await expect(page.locator('.canvas-composer')).toHaveCount(0);
  await expect(page.getByLabel('AI Composer')).toHaveCount(0);

  await trunk.click();
  await expect(page.getByLabel('节点设置')).toContainText('主干活文档');
  await expect(page.getByLabel('AI Composer')).toHaveCount(0);

  await page.keyboard.press('Control+A');
  await page.getByRole('button', { name: '＋ 长出分支' }).click();

  const branchPanel = page.getByLabel('节点设置');
  const composer = branchPanel.getByLabel('AI Composer');
  await expect(composer).toBeVisible();
  await composer.fill('面板内输入不会遮挡画布。');
  await composer.press('Enter');
  await expect(branchPanel.getByText('面板内输入不会遮挡画布。', { exact: true })).toBeVisible();

  await branchPanel.getByRole('button', { name: '提炼成果' }).click();
  await expect(page.getByLabel('节点设置')).toContainText('关于');
  await expect(page.getByLabel('AI Composer')).toHaveCount(0);
});
