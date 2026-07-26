import { expect, test } from '@playwright/test';

const storagePrefix = 'ai-super-canvas.control-plane-test.';

test.beforeEach(async ({ page }) => {
  await page.goto('/control-plane-test');
  await page.evaluate((prefix) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  }, storagePrefix);
  await page.reload();
});

test('shows a new PostgreSQL-backed test surface instead of the old canvas', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '真实后端闭环' })).toBeVisible();
  await expect(page.getByText('PostgreSQL', { exact: true })).toBeVisible();
  await expect(page.getByText('DeterministicFakeRuntime', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建测试 Session' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '主干活文档' })).toHaveCount(0);
});
