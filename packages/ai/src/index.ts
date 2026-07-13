export const AI_PACKAGE_NAME = '@ai-super-canvas/ai' as const;

export interface AiProviderConfig {
  apiKey: string;
  model: string;
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
