import { describe, expect, it } from 'vitest';
import { getModelCatalog } from './index';

describe('model catalog', () => {
  it('reads the selectable models and default from one environment source', () => {
    expect(getModelCatalog({
      AI_AVAILABLE_MODELS: 'gpt-5, deepseek-chat, gpt-5-mini',
      AI_DEFAULT_MODEL: 'deepseek-chat',
    })).toEqual({
      models: ['gpt-5', 'deepseek-chat', 'gpt-5-mini'],
      defaultModel: 'deepseek-chat',
    });
  });

  it('uses a safe local catalog when no model environment is provided', () => {
    expect(getModelCatalog({})).toEqual({
      models: ['gpt-5', 'gpt-5-mini', 'deepseek-chat'],
      defaultModel: 'gpt-5',
    });
  });

  it('uses the first configured model when the configured default is unavailable', () => {
    expect(getModelCatalog({
      AI_AVAILABLE_MODELS: 'gpt-5-mini,deepseek-chat',
      AI_DEFAULT_MODEL: 'gpt-5',
    })).toEqual({
      models: ['gpt-5-mini', 'deepseek-chat'],
      defaultModel: 'gpt-5-mini',
    });
  });

  it('ignores blank defaults while trimming and de-duplicating the configured catalog', () => {
    expect(getModelCatalog({
      AI_AVAILABLE_MODELS: ' gpt-5, , deepseek-chat, gpt-5, ',
      AI_DEFAULT_MODEL: '   ',
      OPENAI_MODEL: ' deepseek-chat ',
    })).toEqual({
      models: ['gpt-5', 'deepseek-chat'],
      defaultModel: 'deepseek-chat',
    });
  });
});
