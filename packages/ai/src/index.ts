export const AI_PACKAGE_NAME = '@ai-super-canvas/ai' as const;

export interface AiProviderConfig {
  apiKey: string;
  model: string;
}

export interface ModelCatalog {
  models: string[];
  defaultModel: string;
}

const fallbackModels = ['gpt-5', 'gpt-5-mini', 'deepseek-chat'];

export function getModelCatalog(
  environment: NodeJS.ProcessEnv = process.env,
): ModelCatalog {
  const configuredModels = environment.AI_AVAILABLE_MODELS
    ?.split(',')
    .map((model) => model.trim())
    .filter(Boolean) ?? [];
  const models = [...new Set(configuredModels.length ? configuredModels : fallbackModels)];
  const candidateDefault = [environment.AI_DEFAULT_MODEL, environment.OPENAI_MODEL]
    .map((model) => model?.trim())
    .find((model): model is string => Boolean(model));
  const defaultModel = candidateDefault && models.includes(candidateDefault)
    ? candidateDefault
    : models[0]!;

  return { models, defaultModel };
}

export function requireAiProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AiProviderConfig {
  const apiKey = environment.OPENAI_API_KEY;
  const model = environment.OPENAI_MODEL;

  if (!apiKey || !model) {
    throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required');
  }

  return { apiKey, model };
}

export * from './runtime';
