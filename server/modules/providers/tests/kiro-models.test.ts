import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  buildKiroModelsDefinition,
  KIRO_MODELS_CACHE_TTL_MS,
  KIRO_MODELS_EMPTY_CACHE_TTL_MS,
  KIRO_PREDEFINED_MODELS,
  KiroProviderModels,
  parseKiroModelCatalog,
  resetKiroModelCatalogCacheForTesting,
  seedKiroModelCatalog,
  type KiroModelCatalog,
} from '@/modules/providers/list/kiro/kiro-models.provider.js';
import { withKiroHome, writeKiroSession } from '@/modules/providers/tests/fixtures/kiro-home.js';

const SESSION_NEW_RESPONSE = {
  sessionId: 'sess_x',
  models: {
    currentModelId: 'claude-sonnet-5.5',
    availableModels: [
      { modelId: 'auto', name: 'Auto' },
      { modelId: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
      { modelId: 'claude-sonnet-5.5', name: 'duplicate is dropped' },
      { modelId: 'no-name-model' },
      { name: 'entry without an id is dropped' },
    ],
  },
};

const CATALOG: KiroModelCatalog = parseKiroModelCatalog(SESSION_NEW_RESPONSE)!;

beforeEach(() => {
  resetKiroModelCatalogCacheForTesting();
});

test('parseKiroModelCatalog keeps unique models with an id and the current model', () => {
  assert.deepEqual(CATALOG, {
    models: [
      { modelId: 'auto', name: 'Auto' },
      { modelId: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
      { modelId: 'no-name-model' },
    ],
    currentModelId: 'claude-sonnet-5.5',
  });
  assert.equal(parseKiroModelCatalog({}), null);
  assert.equal(parseKiroModelCatalog({ models: { availableModels: [] } }), null);
  assert.equal(parseKiroModelCatalog(null), null);
});

test('buildKiroModelsDefinition uses names as labels and the current model as default', () => {
  const definition = buildKiroModelsDefinition(CATALOG);
  assert.deepEqual(definition.OPTIONS, [
    { value: 'auto', label: 'Auto' },
    { value: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
    { value: 'no-name-model', label: 'no-name-model' },
  ]);
  assert.equal(definition.DEFAULT, 'claude-sonnet-5.5');

  // A current model that is not listed falls back to `auto`, then to the first model.
  assert.equal(buildKiroModelsDefinition({ models: CATALOG.models, currentModelId: 'gone' }).DEFAULT, 'auto');
  assert.equal(buildKiroModelsDefinition({ models: [{ modelId: 'only' }] }).DEFAULT, 'only');
});

test('getSupportedModels returns the discovered catalog and reads the CLI once', async () => {
  let reads = 0;
  const models = new KiroProviderModels(async () => {
    reads += 1;
    return CATALOG;
  });

  const [first, second] = await Promise.all([models.getSupportedModels(), models.getSupportedModels()]);
  assert.equal(first.DEFAULT, 'claude-sonnet-5.5');
  assert.deepEqual(second, first);
  await models.getSupportedModels();
  assert.equal(reads, 1, 'concurrent and repeated reads share one CLI run');
});

test('a stale catalog is served immediately and refreshed in the background', async () => {
  let now = 1_000;
  let reads = 0;
  const updated: KiroModelCatalog = { models: [{ modelId: 'new-model', name: 'New' }], currentModelId: 'new-model' };
  const models = new KiroProviderModels(async () => {
    reads += 1;
    return reads === 1 ? CATALOG : updated;
  }, () => now);

  assert.equal((await models.getSupportedModels()).DEFAULT, 'claude-sonnet-5.5');

  now += KIRO_MODELS_CACHE_TTL_MS + 1;
  assert.equal((await models.getSupportedModels()).DEFAULT, 'claude-sonnet-5.5', 'stale value served first');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await models.getSupportedModels()).DEFAULT, 'new-model', 'refresh landed');
  assert.equal(reads, 2);
});

test('a failed or empty read falls back to the static list and is retried sooner', async () => {
  let now = 5_000;
  let reads = 0;
  const models = new KiroProviderModels(async () => {
    reads += 1;
    if (reads === 1) {
      throw new Error('kiro-cli is not installed');
    }
    return CATALOG;
  }, () => now);

  assert.deepEqual(await models.getSupportedModels(), KIRO_PREDEFINED_MODELS);

  // Still inside the short empty-result window: the fallback is served without a new read.
  now += KIRO_MODELS_EMPTY_CACHE_TTL_MS - 1;
  assert.deepEqual(await models.getSupportedModels(), KIRO_PREDEFINED_MODELS);
  assert.equal(reads, 1);

  now += 2;
  await models.getSupportedModels();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await models.getSupportedModels()).DEFAULT, 'claude-sonnet-5.5');
  assert.equal(reads, 2);
});

test('the static fallback lists Auto first and defaults to it', () => {
  assert.equal(KIRO_PREDEFINED_MODELS.DEFAULT, 'auto');
  assert.equal(KIRO_PREDEFINED_MODELS.OPTIONS[0].value, 'auto');
  assert.ok(KIRO_PREDEFINED_MODELS.OPTIONS.length > 1);
});

test('seedKiroModelCatalog lets the picker reuse the runtime session/new response', async () => {
  let reads = 0;
  seedKiroModelCatalog(SESSION_NEW_RESPONSE);
  const models = new KiroProviderModels(async () => {
    reads += 1;
    return null;
  });

  assert.equal((await models.getSupportedModels()).DEFAULT, 'claude-sonnet-5.5');
  assert.equal(reads, 0);

  // A response without models does not clobber the cache.
  seedKiroModelCatalog({ sessionId: 'sess_y' });
  assert.equal((await models.getSupportedModels()).DEFAULT, 'claude-sonnet-5.5');
});

test('getCurrentActiveModel reads the session model from session.json, else the default', async () => {
  await withKiroHome(async (homeDir) => {
    await writeKiroSession(homeDir, {
      id: 'sess_c78d1a7b-bfc4-44de-b1c7-2547c2ebd9f4',
      workspacePath: 'c:\\users\\admin\\.kiro-ui\\workspace',
      modelId: 'auto',
    });
    await writeKiroSession(homeDir, {
      id: 'sess_no-model',
      workspacePath: 'c:\\users\\admin\\.kiro-ui\\workspace',
    });
    const models = new KiroProviderModels(async () => CATALOG);

    assert.deepEqual(
      await models.getCurrentActiveModel('sess_c78d1a7b-bfc4-44de-b1c7-2547c2ebd9f4'),
      { model: 'auto' },
    );
    assert.deepEqual(await models.getCurrentActiveModel('sess_no-model'), { model: 'claude-sonnet-5.5' });
    assert.deepEqual(await models.getCurrentActiveModel('sess_unknown'), { model: 'claude-sonnet-5.5' });
    assert.deepEqual(await models.getCurrentActiveModel('../../etc/passwd'), { model: 'claude-sonnet-5.5' });
    assert.deepEqual(await models.getCurrentActiveModel(), { model: 'claude-sonnet-5.5' });
  });
});
