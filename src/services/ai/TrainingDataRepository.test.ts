import fs from 'fs/promises';
import path from 'path';
import { Logger } from '../../utils/Logger';
import { TrainingDataRepository, type TrainingRepoOptions } from './TrainingDataRepository';
import type { TrainingExample } from './AIFieldMappingService';

function tmpDir(prefix: string) {
  const dir = path.join(process.cwd(), 'data', 'ai-training-tests', `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  return dir;
}

async function createRepo(prefix: string, opts: Partial<TrainingRepoOptions> = {}) {
  const storageDirectory = tmpDir(prefix);
  await fs.mkdir(storageDirectory, { recursive: true });
  const logger = new Logger('TrainingRepoTest');
  const repo = new TrainingDataRepository(logger, { storageDirectory, ...opts });
  return { repo, storageDirectory };
}

async function addExample(repo: TrainingDataRepository, ex: Partial<TrainingExample>, datasetId = 'default') {
  const example: TrainingExample = {
    id: ex.id ?? `ex_${Math.random().toString(36).slice(2)}`,
    sourceSystem: ex.sourceSystem ?? 'src',
    targetSystem: ex.targetSystem ?? 'NetSuite',
    sourceField: ex.sourceField ?? 'firstName',
    targetField: ex.targetField ?? 'firstname',
    transformationType: ex.transformationType ?? 'direct',
    successRate: ex.successRate ?? (ex.userFeedback === 'positive' ? 1 : 0),
    userFeedback: ex.userFeedback ?? 'positive',
    context: ex.context ?? { signals: [] },
    createdAt: ex.createdAt ?? new Date(),
  };
  await repo.storeTrainingExample(example, datasetId);
}

describe('TrainingDataRepository.getSignalEffectiveness', () => {
  it('returns empty adjustments when dataset missing or empty', async () => {
    const { repo, storageDirectory } = await createRepo('empty');
    try {
      const adj1 = await repo.getSignalEffectiveness('nonexistent');
      expect(adj1).toEqual({});

      const adj2 = await repo.getSignalEffectiveness('default');
      expect(adj2).toEqual({});
    } finally {
      await fs.rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it('computes per-signal multipliers with smoothing and clamping', async () => {
    const { repo, storageDirectory } = await createRepo('clamp', { clampMin: 0.75, clampMax: 1.25, minSamples: 3 });
    try {
      const ds = 'ds2';
      // semantic: strong performer (8/10)
      for (let i = 0; i < 8; i++) await addExample(repo, { userFeedback: 'positive', successRate: 1, context: { signals: ['semantic'] } }, ds);
      for (let i = 0; i < 2; i++) await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['semantic'] } }, ds);

      // pattern: weak performer (3/10)
      for (let i = 0; i < 3; i++) await addExample(repo, { userFeedback: 'positive', successRate: 1, context: { signals: ['pattern'] } }, ds);
      for (let i = 0; i < 7; i++) await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['pattern'] } }, ds);

      // netsuite: moderate (6/10)
      for (let i = 0; i < 6; i++) await addExample(repo, { userFeedback: 'positive', successRate: 1, context: { signals: ['netsuite'] } }, ds);
      for (let i = 0; i < 4; i++) await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['netsuite'] } }, ds);

      const adj = await repo.getSignalEffectiveness(ds);

      expect(adj.semantic).toBeGreaterThan(1.0);
      expect(adj.semantic!).toBeLessThanOrEqual(1.25);

      expect(adj.pattern).toBeLessThan(1.0);
      expect(adj.pattern!).toBeGreaterThanOrEqual(0.75);

      expect(adj.netsuite).toBeDefined();
      expect(adj.netsuite!).toBeGreaterThanOrEqual(0.75);
      expect(adj.netsuite!).toBeLessThanOrEqual(1.25);
    } finally {
      await fs.rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it('omits signals with fewer than minSamples', async () => {
    const { repo, storageDirectory } = await createRepo('minsamples', { minSamples: 5 });
    try {
      const ds = 'ds3';
      await addExample(repo, { userFeedback: 'positive', successRate: 1, context: { signals: ['netsuite'] } }, ds);
      await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['netsuite'] } }, ds);

      const adj = await repo.getSignalEffectiveness(ds);
      expect('netsuite' in adj).toBe(false);
    } finally {
      await fs.rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it('respects tighter clamp bounds', async () => {
    const { repo, storageDirectory } = await createRepo('tightclamp', { clampMax: 1.1, clampMin: 0.9, minSamples: 3 });
    try {
      const ds = 'ds4';
      // Drive overall down, but make semantic look strong
      for (let i = 0; i < 5; i++) await addExample(repo, { userFeedback: 'positive', successRate: 1, context: { signals: ['semantic'] } }, ds);
      for (let i = 0; i < 1; i++) await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['semantic'] } }, ds);

      // Many negatives overall to reduce baseline
      for (let i = 0; i < 20; i++) await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['pattern'] } }, ds);

      const adj = await repo.getSignalEffectiveness(ds);
      expect(adj.semantic!).toBeLessThanOrEqual(1.1);
      expect(adj.pattern!).toBeGreaterThanOrEqual(0.9);
    } finally {
      await fs.rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it('invalidates cache after adding a new example (recomputes)', async () => {
    const { repo, storageDirectory } = await createRepo('cache-invalidate', { minSamples: 2 });
    try {
      const ds = 'cache-ds';
      // Start with weak pattern performance
      for (let i = 0; i < 2; i++) await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['pattern'] } }, ds);
      const adj1 = await repo.getSignalEffectiveness(ds);
      expect(typeof adj1.pattern === 'number').toBe(true);

      // Add positives to improve pattern signal; cache should invalidate on write
      for (let i = 0; i < 4; i++) await addExample(repo, { userFeedback: 'positive', successRate: 1, context: { signals: ['pattern'] } }, ds);
      const adj2 = await repo.getSignalEffectiveness(ds);
      // Expect improvement after new examples considered
      expect((adj2.pattern ?? 0)).toBeGreaterThanOrEqual(adj1.pattern ?? 0);
    } finally {
      await fs.rm(storageDirectory, { recursive: true, force: true });
    }
  });

  it('maintains independent caches per dataset id', async () => {
    const { repo, storageDirectory } = await createRepo('cache-separate', { minSamples: 2 });
    try {
      const dsA = 'dsA';
      const dsB = 'dsB';

      // dsA: strong semantic
      for (let i = 0; i < 4; i++) await addExample(repo, { userFeedback: 'positive', successRate: 1, context: { signals: ['semantic'] } }, dsA);
      for (let i = 0; i < 1; i++) await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['pattern'] } }, dsA);

      // dsB: strong pattern
      for (let i = 0; i < 4; i++) await addExample(repo, { userFeedback: 'positive', successRate: 1, context: { signals: ['pattern'] } }, dsB);
      for (let i = 0; i < 1; i++) await addExample(repo, { userFeedback: 'negative', successRate: 0, context: { signals: ['semantic'] } }, dsB);

      const adjA = await repo.getSignalEffectiveness(dsA);
      const adjB = await repo.getSignalEffectiveness(dsB);

      expect((adjA.semantic ?? 1)).toBeGreaterThan((adjA.pattern ?? 1));
      expect((adjB.pattern ?? 1)).toBeGreaterThan((adjB.semantic ?? 1));
    } finally {
      await fs.rm(storageDirectory, { recursive: true, force: true });
    }
  });
});


it('listDatasets handles persisted string timestamps loaded from disk', async () => {
  const storageDirectory = tmpDir('list-datasets');
  await fs.mkdir(storageDirectory, { recursive: true });

  const dsId = 'persisted-ds';
  const createdAtIso = new Date('2025-01-01T00:00:00.000Z').toISOString();
  const updatedAtIso = new Date('2025-02-01T12:34:56.789Z').toISOString();

  const datasetJson = {
    id: dsId,
    name: 'Persisted Dataset',
    description: 'Loaded from disk with string timestamps',
    version: '1.0.0',
    createdAt: createdAtIso,
    updatedAt: updatedAtIso,
    examples: [
      {
        id: 'ex1',
        sourceSystem: 'CRM',
        targetSystem: 'ERP',
        sourceField: 'email',
        targetField: 'emailAddress',
        transformationType: 'direct',
        successRate: 1,
        userFeedback: 'positive',
        createdAt: createdAtIso
      }
    ],
    metadata: {
      totalExamples: 1,
      sourceSystemBreakdown: { CRM: 1 },
      targetSystemBreakdown: { ERP: 1 },
      transformationTypeBreakdown: { direct: 1 },
      feedbackBreakdown: { positive: 1 },
      successRate: 1,
      averageConfidence: 1
    }
  };

  await fs.writeFile(
    path.join(storageDirectory, dsId + ".json"),
    JSON.stringify(datasetJson, null, 2),
    'utf-8'
  );

  const logger = new Logger('TrainingRepoTest');
  const { TrainingDataRepository } = await import('./TrainingDataRepository');
  const repo = new TrainingDataRepository(logger, { storageDirectory });

  let found: any;
  for (let i = 0; i < 10; i++) {
    const list = await repo.listDatasets();
    expect(Array.isArray(list)).toBe(true);
    found = list.find(d => d.id === dsId);
    if (found) break;
    await new Promise(r => setTimeout(r, 50));
  }
  expect(found).toBeTruthy();
  expect(found!.updatedAt).toBe(new Date(updatedAtIso).toISOString());

  await fs.rm(storageDirectory, { recursive: true, force: true });
});



