import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderCurrentActiveModel, ProviderModelsDefinition } from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Static fallback catalog shipped as CloudCLI defaults until the real models
 * adapter (T5) reads the live list from `session/new`. Kept small and
 * generic since kiro-cli's agent/model catalog is server-provided, not fixed.
 */
export const KIRO_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'default', label: 'Default', description: 'Kiro default model' },
  ],
  DEFAULT: 'default',
};

/**
 * Model catalog adapter for Kiro. Returns the static fallback only; a later
 * task replaces this with a `session/new`-backed implementation per
 * `docs/kiro/design.md`.
 */
export class KiroProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return KIRO_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
