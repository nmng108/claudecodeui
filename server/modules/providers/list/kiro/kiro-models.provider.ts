import os from 'node:os';

import { sessionsDb } from '@/modules/database/index.js';
import { KiroAcpClient } from '@/modules/providers/list/kiro/kiro-acp.client.js';
import {
  findKiroSessionDir,
  readKiroSessionJson,
} from '@/modules/providers/list/kiro/kiro-paths.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Static fallback catalog, used when `kiro-cli` cannot be started or has no
 * credentials. The live list comes from the `models` field of the ACP
 * `session/new` response (`availableModels` and `currentModelId`), so these ids
 * only need to be ones Kiro is known to accept.
 */
export const KIRO_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'Auto', description: 'Let Kiro choose the model.' },
    { value: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ],
  DEFAULT: 'auto',
};

/** One entry of the `availableModels` array in the ACP `session/new` response. */
export type KiroDiscoveredModel = { modelId: string; name?: string; description?: string };

/** What a catalog read returns: the advertised models and the one Kiro would use by default. */
export type KiroModelCatalog = { models: KiroDiscoveredModel[]; currentModelId?: string };

/** A fresh listing is reused for this long before it is refreshed in the background. */
export const KIRO_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
/** A failed or empty listing is retried sooner so a later login or install shows up quickly. */
export const KIRO_MODELS_EMPTY_CACHE_TTL_MS = 30 * 1000;
/** Upper bound on one `kiro-cli acp` discovery run. */
const KIRO_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Pulls the model catalog out of a `session/new` (or `session/load`) response.
 * Returns `null` when the response advertises no usable models.
 */
export function parseKiroModelCatalog(raw: unknown): KiroModelCatalog | null {
  const models = (raw as { models?: { availableModels?: unknown; currentModelId?: unknown } } | null)?.models;
  if (!models || !Array.isArray(models.availableModels)) {
    return null;
  }

  const seen = new Set<string>();
  const discovered: KiroDiscoveredModel[] = [];
  for (const entry of models.availableModels) {
    const record = entry as { modelId?: unknown; id?: unknown; name?: unknown; description?: unknown } | null;
    const modelId = readString(record?.modelId) ?? readString(record?.id);
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    discovered.push({
      modelId,
      ...(readString(record?.name) ? { name: readString(record?.name) } : {}),
      ...(readString(record?.description) ? { description: readString(record?.description) } : {}),
    });
  }

  if (discovered.length === 0) {
    return null;
  }

  return { models: discovered, ...(readString(models.currentModelId) ? { currentModelId: readString(models.currentModelId) } : {}) };
}

/** Turns a discovered catalog into the provider-neutral model definition. */
export function buildKiroModelsDefinition(catalog: KiroModelCatalog): ProviderModelsDefinition {
  const options: ProviderModelOption[] = catalog.models.map((model) => ({
    value: model.modelId,
    label: model.name ?? model.modelId,
    ...(model.description ? { description: model.description } : {}),
  }));
  const current = catalog.currentModelId;
  const defaultModel = current && options.some((option) => option.value === current)
    ? current
    : options.find((option) => option.value === 'auto')?.value ?? options[0].value;

  return { OPTIONS: options, DEFAULT: defaultModel };
}

/**
 * Starts a short-lived `kiro-cli acp`, creates a session to read the model list
 * from the response, and always disposes the child. Resolves `null` when the
 * CLI is missing, not signed in, times out, or lists nothing.
 */
export async function readKiroModelCatalog(): Promise<KiroModelCatalog | null> {
  const client = new KiroAcpClient({ cwd: os.homedir(), initTimeoutMs: KIRO_MODEL_DISCOVERY_TIMEOUT_MS });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const discovery = (async () => {
      await client.connect();
      const { raw } = await client.startSession();
      return parseKiroModelCatalog(raw);
    })();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), KIRO_MODEL_DISCOVERY_TIMEOUT_MS);
    });
    // The loser of the race must not surface as an unhandled rejection.
    discovery.catch(() => {});
    return await Promise.race([discovery, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    await client.close().catch(() => {});
  }
}

/** Process-wide listing cache, shared so the runtime can seed it from its own `session/new`. */
let cachedCatalog: { catalog: KiroModelCatalog | null; expiresAt: number } | null = null;
let pendingCatalog: Promise<KiroModelCatalog | null> | null = null;

/**
 * Remembers a catalog the runtime already received, so picking Kiro after a chat
 * has started does not spawn another `kiro-cli` process.
 */
export function seedKiroModelCatalog(raw: unknown, now: number = Date.now()): void {
  const catalog = parseKiroModelCatalog(raw);
  if (catalog) {
    cachedCatalog = { catalog, expiresAt: now + KIRO_MODELS_CACHE_TTL_MS };
  }
}

/** Clears the shared cache; tests call this between cases. */
export function resetKiroModelCatalogCacheForTesting(): void {
  cachedCatalog = null;
  pendingCatalog = null;
}

/** Provider registry model adapter for Kiro. */
export class KiroProviderModels implements IProviderModels {
  constructor(
    private readonly readCatalog: () => Promise<KiroModelCatalog | null> = readKiroModelCatalog,
    private readonly now: () => number = Date.now,
  ) {}

  private refreshCatalog(): Promise<KiroModelCatalog | null> {
    pendingCatalog ??= this.readCatalog()
      // The picker stays available when the CLI cannot be started.
      .catch(() => null)
      .then((catalog) => {
        const ttl = catalog ? KIRO_MODELS_CACHE_TTL_MS : KIRO_MODELS_EMPTY_CACHE_TTL_MS;
        cachedCatalog = { catalog, expiresAt: this.now() + ttl };
        return catalog;
      })
      .finally(() => {
        pendingCatalog = null;
      });
    return pendingCatalog;
  }

  /**
   * Serves the cached listing, refreshing it in the background once stale. Only
   * the first read after startup waits on `kiro-cli`.
   */
  private async readModelCatalog(): Promise<KiroModelCatalog | null> {
    if (!cachedCatalog) {
      return this.refreshCatalog();
    }
    if (this.now() >= cachedCatalog.expiresAt) {
      void this.refreshCatalog();
    }
    return cachedCatalog.catalog;
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const catalog = await this.readModelCatalog();
    return catalog ? buildKiroModelsDefinition(catalog) : KIRO_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId?.trim()) {
      // Kiro keeps the model of each session in its own session.json; the app
      // session id is translated to the Kiro one first.
      let providerSessionId = sessionId;
      try {
        providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;
      } catch {
        // Without a session row (or database) the id is already Kiro's own.
      }
      const sessionDir = await findKiroSessionDir(providerSessionId);
      const modelId = sessionDir ? readString((await readKiroSessionJson(sessionDir))?.modelId) : undefined;
      if (modelId) {
        return { model: modelId };
      }
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
