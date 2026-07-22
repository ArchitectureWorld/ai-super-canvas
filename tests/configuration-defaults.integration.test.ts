import { readFileSync } from 'node:fs';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeterministicFakeRuntime, getModelCatalog } from '../packages/ai/src';
import { createPostgresControlPlaneRepository } from '../packages/db/src';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for configuration integration tests');
}

function readDocumentedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const source = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    environment[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return environment;
}

describe('documented local-alpha model defaults', () => {
  const repository = createPostgresControlPlaneRepository(databaseUrl);

  beforeEach(async () => repository.resetTestData());
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => repository.close());

  it('boots and starts the selected .env.example model on DeterministicFakeRuntime', async () => {
    const environment = readDocumentedEnvironment();
    const availableModels = environment.AI_AVAILABLE_MODELS;
    const defaultModel = environment.AI_DEFAULT_MODEL;
    if (!availableModels || !defaultModel) {
      throw new Error('.env.example must document the local model catalog and default');
    }
    vi.stubEnv('AI_AVAILABLE_MODELS', availableModels);
    vi.stubEnv('AI_DEFAULT_MODEL', defaultModel);
    const catalog = getModelCatalog(environment);

    const bootstrap = await repository.bootstrapLocalAlpha({
      commandId: '90909090-9090-4090-8090-909090909090',
      authSubject: 'local:documented-defaults',
      displayName: 'Documented defaults owner',
    });
    const actor = {
      accountId: bootstrap.accountId,
      authSubject: bootstrap.authSubject,
    };
    const canvasSession = await repository.createRootSession({
      actor,
      commandId: '91919191-9191-4191-8191-919191919191',
      workflowId: bootstrap.workflowId,
      agentBindingId: bootstrap.agentBindingId,
      title: 'Documented default session',
    });
    expect(canvasSession.config.model).toMatchObject({
      runtimeKind: 'fake',
      providerKey: 'fake',
      modelKey: catalog.defaultModel,
    });

    const runtime = new DeterministicFakeRuntime();
    const binding = {
      canvasAgentBindingId: bootstrap.agentBindingId,
      isolationKey: `local-alpha:${bootstrap.accountId}`,
    };
    const runtimeSession = await runtime.createSession({
      commandId: canvasSession.commandReceiptId,
      binding,
      canvasSessionId: canvasSession.sessionId,
      model: {
        providerKey: canvasSession.config.model.providerKey,
        modelKey: canvasSession.config.model.modelKey,
      },
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: [],
        approvalRequiredToolKeys: [],
      },
      context: [],
    });
    await expect(runtime.startRun({
      commandId: '92929292-9292-4292-8292-929292929292',
      idempotencyKey: 'documented-default-run',
      binding,
      canvasRunId: '93939393-9393-4393-8393-939393939393',
      canvasSessionId: canvasSession.sessionId,
      externalSessionRef: runtimeSession.externalSessionRef,
      expectedHistoryDigest: runtimeSession.historyDigest!,
      prompt: {
        canvasMessageId: '94949494-9494-4494-8494-949494949494',
        role: 'user',
        content: 'Start with the documented default model',
      },
      model: {
        providerKey: canvasSession.config.model.providerKey,
        modelKey: canvasSession.config.model.modelKey,
      },
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: [],
        approvalRequiredToolKeys: [],
      },
      context: [],
    })).resolves.toMatchObject({
      externalRunRef: 'fake-run-1',
      acceptedAt: '1970-01-01T00:00:00.000Z',
    });
  });
});
