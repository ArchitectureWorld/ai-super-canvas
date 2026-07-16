import { expect, test } from '@playwright/test';

const expectedModelsEnvironment = process.env.E2E_EXPECTED_MODELS;
const expectedModels = expectedModelsEnvironment === undefined
  ? undefined
  : expectedModelsEnvironment.split(',').map((model) => model.trim()).filter(Boolean);
const expectedDefaultModelEnvironment = process.env.E2E_EXPECTED_DEFAULT_MODEL;
const expectedDefaultModel = expectedDefaultModelEnvironment === undefined
  ? undefined
  : expectedDefaultModelEnvironment.trim();

test('runs the structured growth golden path in a browser', async ({ page }) => {
  await page.goto('/');

  const trunk = page.getByRole('textbox', { name: '主干活文档' });
  await expect(trunk).toBeVisible();
  await expect(page.getByLabel('主干生长点')).toBeVisible();

  const trunkBox = await trunk.boundingBox();
  if (!trunkBox) throw new Error('主干节点未渲染');
  await page.mouse.move(trunkBox.x + 30, trunkBox.y + 30);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await expect(page.getByLabel('节点设置')).toContainText('主干活文档');

  const trunkModel = page.getByLabel('主干活文档 模型');
  const modelOptions = await trunkModel.locator('option').evaluateAll((options) => (
    options.map((option) => (option as HTMLOptionElement).value)
  ));
  const currentModel = await trunkModel.inputValue();
  if (expectedModels === undefined) {
    expect(modelOptions.length).toBeGreaterThan(0);
  } else {
    expect(modelOptions).toEqual(expectedModels);
  }
  if (expectedDefaultModel === undefined) {
    expect(modelOptions).toContain(currentModel);
  } else {
    expect(currentModel).toBe(expectedDefaultModel);
  }
  const alternativeModel = modelOptions.find((model) => model !== currentModel);
  if (alternativeModel) {
    await trunkModel.selectOption(alternativeModel);
    await expect(trunkModel).toHaveValue(alternativeModel);
  }

  const plane = page.getByTestId('canvas-plane');
  const initialTransform = await plane.evaluate((element) => getComputedStyle(element).transform);
  const stage = page.getByLabel('结构化生长画布');
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error('画布未渲染');
  await page.mouse.move(stageBox.x + stageBox.width - 90, stageBox.y + 200);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(280);
  await page.mouse.move(stageBox.x + stageBox.width - 190, stageBox.y + 250);
  await page.mouse.up({ button: 'right' });
  await expect.poll(() => plane.evaluate((element) => getComputedStyle(element).transform)).not.toBe(initialTransform);

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
  await expect(page.getByRole('textbox', { name: '主干活文档' })).toHaveValue(/## 关于/);
});

test('zooms around the pointer without hijacking panel or horizontal wheel input', async ({ page }) => {
  await page.goto('/');

  const stage = page.getByLabel('结构化生长画布');
  const plane = page.getByTestId('canvas-plane');
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error('画布未渲染');
  const pointer = {
    x: stageBox.x + stageBox.width - 280,
    y: stageBox.y + stageBox.height / 2,
  };
  const readPointerWorldPosition = () => plane.evaluate((element, clientPoint) => {
    const stageElement = element.parentElement;
    if (!stageElement) throw new Error('画布平面缺少容器');
    const stageRect = stageElement.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    const localX = clientPoint.x - stageRect.left - stageElement.clientLeft;
    const localY = clientPoint.y - stageRect.top - stageElement.clientTop;
    return {
      scale: matrix.a,
      transform: getComputedStyle(element).transform,
      worldX: (localX - matrix.e) / matrix.a,
      worldY: (localY - matrix.f) / matrix.d,
    };
  }, pointer);

  await page.mouse.move(pointer.x, pointer.y);
  const beforeZoom = await readPointerWorldPosition();
  await page.mouse.wheel(0, -40);
  await expect.poll(async () => (await readPointerWorldPosition()).scale).toBeGreaterThan(beforeZoom.scale);
  const afterZoom = await readPointerWorldPosition();
  expect(afterZoom.worldX).toBeCloseTo(beforeZoom.worldX, 3);
  expect(afterZoom.worldY).toBeCloseTo(beforeZoom.worldY, 3);

  const beforeHorizontalWheel = afterZoom.transform;
  await page.mouse.wheel(80, 0);
  await expect.poll(() => plane.evaluate((element) => getComputedStyle(element).transform))
    .toBe(beforeHorizontalWheel);

  const panel = page.getByLabel('节点设置');
  const panelBox = await panel.boundingBox();
  if (!panelBox) throw new Error('节点设置未渲染');
  await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
  const beforePanelWheel = await plane.evaluate((element) => getComputedStyle(element).transform);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => plane.evaluate((element) => getComputedStyle(element).transform))
    .toBe(beforePanelWheel);
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
  await expect(branchPanel).toContainText('面板内输入不会遮挡画布。');

  await branchPanel.getByRole('button', { name: '提炼成果' }).click();
  await expect(page.getByLabel('节点设置')).toContainText('关于');
  await expect(page.getByLabel('AI Composer')).toHaveCount(0);
});
