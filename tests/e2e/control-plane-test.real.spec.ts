import { readFile, writeFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

const storagePrefix = 'ai-super-canvas.control-plane-test.';
const lastSessionKey =
  'ai-super-canvas.control-plane-test.last-session';
const acceptanceIdPattern = /^[a-zA-Z0-9_-]{8,128}$/;
const uuidPattern = /^[0-9a-f-]{36}$/i;

interface AcceptanceArtifacts {
  manifestPath: string;
  screenshotPath: string;
  storageStatePath: string;
}

interface AcceptanceManifest {
  schemaVersion: 1;
  acceptanceId: string;
  beforeMessage: string;
  afterMessage: string;
  sessionIdBefore: string;
  sessionIdAfter?: string;
  commitSha: string;
  imageId: string;
  containerIdBefore: string;
  containerIdAfter?: string;
  storageStatePath: string;
  screenshotPath: string;
  createdAt: string;
  completedAt?: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function acceptanceArtifacts(): {
  acceptanceId: string;
  artifacts: AcceptanceArtifacts;
} {
  const acceptanceId = requiredEnvironment(
    'CONTROL_PLANE_ACCEPTANCE_ID',
  );
  if (!acceptanceIdPattern.test(acceptanceId)) {
    throw new Error('CONTROL_PLANE_ACCEPTANCE_ID is not filesystem-safe');
  }
  const artifactDirectory = requiredEnvironment(
    'CONTROL_PLANE_ACCEPTANCE_ARTIFACT_DIR',
  );
  return {
    acceptanceId,
    artifacts: {
      manifestPath:
        `${artifactDirectory}/control-plane-${acceptanceId}.manifest.json`,
      screenshotPath:
        `${artifactDirectory}/control-plane-${acceptanceId}.png`,
      storageStatePath:
        `${artifactDirectory}/control-plane-${acceptanceId}.storage.json`,
    },
  };
}

async function readManifest(
  path: string,
): Promise<AcceptanceManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('schemaVersion' in parsed)
    || parsed.schemaVersion !== 1
  ) {
    throw new Error('Acceptance manifest is malformed');
  }
  return parsed as AcceptanceManifest;
}

async function storedSessionId(page: Page): Promise<string> {
  const value = await page.evaluate(
    (key) => localStorage.getItem(key),
    lastSessionKey,
  );
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new Error('The browser did not store a valid Session pointer');
  }
  return value;
}

test('real PostgreSQL journey before service restart', async ({ page }) => {
  test.skip(
    process.env.RUN_REAL_CONTROL_PLANE_E2E !== '1',
    'Use scripts/test-control-plane-restart.sh against the deployed service.',
  );

  const { acceptanceId, artifacts } = acceptanceArtifacts();
  const beforeMessage = `重启前验收 ${acceptanceId}`;
  const afterMessage = `重启后验收 ${acceptanceId}`;
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/control-plane-test');

  await expect(page.getByRole('heading', { name: '真实后端闭环' })).toBeVisible();
  await expect(page.getByText('后端已就绪', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建测试 Session' }).click();
  await expect(page.getByText(
    'Session 已连接 Fake Runtime',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText('Session 可用', { exact: true })).toBeVisible();
  await expect(page.getByText(
    '历史已恢复，但旧 Fake Runtime 已不可用。请新建测试 Session。',
    { exact: true },
  )).toHaveCount(0);
  const sessionIdBefore = await storedSessionId(page);

  const textbox = page.getByRole('textbox', { name: '测试消息' });
  await expect(textbox).toBeEnabled();
  await textbox.fill(beforeMessage);
  await page.getByRole('button', { name: '发送到真实后端' }).click();

  await expect(page.getByText(
    '回复已写入 PostgreSQL',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText(beforeMessage, { exact: true })).toBeVisible();
  await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
  await expect(page.getByLabel('已持久化 Run 事件')).toContainText(
    'run.completed',
  );
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth
    <= document.documentElement.clientWidth
  ))).toBe(true);

  const storedValues = await page.evaluate((prefix) => (
    Object.entries(localStorage).filter(([key]) => key.startsWith(prefix))
  ), storagePrefix);
  expect(storedValues).toEqual([[lastSessionKey, sessionIdBefore]]);
  expect(JSON.stringify(storedValues)).not.toContain(beforeMessage);
  expect(JSON.stringify(storedValues)).not.toContain('fake fake');

  await page.reload();
  await expect(page.getByText(beforeMessage, { exact: true })).toBeVisible();
  await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
  await expect(page.getByText('Session 可用', { exact: true })).toBeVisible();
  await expect(page.getByText(
    '历史已恢复，但旧 Fake Runtime 已不可用。请新建测试 Session。',
    { exact: true },
  )).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeEnabled();
  expect(pageErrors).toEqual([]);

  await page.context().storageState({ path: artifacts.storageStatePath });
  const manifest: AcceptanceManifest = {
    schemaVersion: 1,
    acceptanceId,
    beforeMessage,
    afterMessage,
    sessionIdBefore,
    commitSha: requiredEnvironment('CONTROL_PLANE_COMMIT_SHA'),
    imageId: requiredEnvironment('CONTROL_PLANE_IMAGE_ID'),
    containerIdBefore: requiredEnvironment(
      'CONTROL_PLANE_CONTAINER_ID_BEFORE',
    ),
    storageStatePath: artifacts.storageStatePath,
    screenshotPath: artifacts.screenshotPath,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    artifacts.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
});

test('real PostgreSQL journey after service restart', async ({ browser }) => {
  test.skip(
    process.env.RUN_REAL_CONTROL_PLANE_RESTART_E2E !== '1',
    'Use scripts/test-control-plane-restart.sh against the deployed service.',
  );

  const { acceptanceId, artifacts } = acceptanceArtifacts();
  const manifest = await readManifest(artifacts.manifestPath);
  expect(manifest.acceptanceId).toBe(acceptanceId);
  expect(manifest.storageStatePath).toBe(artifacts.storageStatePath);
  expect(manifest.commitSha).toBe(
    requiredEnvironment('CONTROL_PLANE_COMMIT_SHA'),
  );
  expect(manifest.imageId).toBe(
    requiredEnvironment('CONTROL_PLANE_IMAGE_ID'),
  );
  expect(manifest.containerIdBefore).toBe(
    requiredEnvironment('CONTROL_PLANE_CONTAINER_ID_BEFORE'),
  );

  const context = await browser.newContext({
    storageState: manifest.storageStatePath,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  try {
    await page.goto('/control-plane-test');
    await expect(page.getByText(
      manifest.beforeMessage,
      { exact: true },
    )).toBeVisible();
    await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
    await expect(page.getByText(
      '历史已恢复，但旧 Fake Runtime 已不可用。请新建测试 Session。',
      { exact: true },
    )).toBeVisible();
    expect(await storedSessionId(page)).toBe(manifest.sessionIdBefore);

    await page.getByRole('button', { name: '新建测试 Session' }).click();
    await expect(page.getByText(
      'Session 已连接 Fake Runtime',
      { exact: true },
    )).toBeVisible();
    const sessionIdAfter = await storedSessionId(page);
    expect(sessionIdAfter).not.toBe(manifest.sessionIdBefore);

    await page.getByRole('textbox', { name: '测试消息' }).fill(
      manifest.afterMessage,
    );
    await page.getByRole('button', { name: '发送到真实后端' }).click();
    await expect(page.getByText(
      '回复已写入 PostgreSQL',
      { exact: true },
    )).toBeVisible();
    await expect(page.getByText(
      manifest.afterMessage,
      { exact: true },
    )).toBeVisible();
    await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
    await expect(page.getByLabel('已持久化 Run 事件')).toContainText(
      'run.completed',
    );

    await page.reload();
    await expect(page.getByText(
      manifest.afterMessage,
      { exact: true },
    )).toBeVisible();
    await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
    await expect(page.getByText('Session 可用', { exact: true })).toBeVisible();
    await expect(page.getByText(
      '历史已恢复，但旧 Fake Runtime 已不可用。请新建测试 Session。',
      { exact: true },
    )).toHaveCount(0);
    expect(await storedSessionId(page)).toBe(sessionIdAfter);
    expect(pageErrors).toEqual([]);

    await page.screenshot({
      path: artifacts.screenshotPath,
      fullPage: true,
    });
    await writeFile(
      artifacts.manifestPath,
      `${JSON.stringify({
        ...manifest,
        sessionIdAfter,
        containerIdAfter: requiredEnvironment(
          'CONTROL_PLANE_CONTAINER_ID_AFTER',
        ),
        completedAt: new Date().toISOString(),
      } satisfies AcceptanceManifest, null, 2)}\n`,
      'utf8',
    );
  } finally {
    await context.close();
  }
});
