import 'reflect-metadata';
import { DatabaseService } from '../../src/database/DatabaseService';
import { Logger } from '../../src/utils/Logger';
import { AIConfigurationService } from '../../src/services/ai/AIConfigurationService';

// Use a unique DB file per run to avoid state bleed between tests
function makeDb() {
  process.env.DB_TYPE = 'sqlite';
  delete process.env.SQLITE_BOOL_PARAM_PATCH; // ensure default ON
  const logger = new Logger('SQLiteBoolTest');
  const dbService = new DatabaseService(logger as any);
  return dbService;
}

describe('SQLite boolean parameter handling', () => {
  it('inserts succeed when patch is ON (default)', async () => {
    const dbService = makeDb();
    await dbService.initialize();
    const svc = new AIConfigurationService(dbService as any);

    const provider = await svc.saveProviderConfig({
      userId: 101,
      providerType: 'openai',
      providerName: 'OpenAI',
      isActive: true,
      isDefault: false,
      configuration: { a: true, nested: { b: false }, arr: [true, false] },
    });

    const task = await svc.saveTaskModelConfig({
      userId: 101,
      taskType: 'field_mapping',
      providerConfigId: provider.id!,
      modelVersion: 'gpt-4o',
      modelParameters: { useTools: true, opts: { strict: false } },
      isActive: true,
      priority: 1,
    });

    await svc.logUsage({
      userId: 101,
      providerConfigId: provider.id!,
      taskModelConfigId: task.id!,
      taskType: 'field_mapping',
      providerType: 'openai',
      modelVersion: 'gpt-4o',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      estimatedCost: 0.0001,
      requestType: 'test',
      executionTimeMs: 1,
      success: true,
      errorMessage: undefined,
      recordsProcessed: 1,
      fieldsAnalyzed: 1,
    });

    await dbService.shutdown();
  });

  it('inserts may fail when patch is OFF (expect binding error)', async () => {
    const dbService = makeDb();
    process.env.SQLITE_BOOL_PARAM_PATCH = '0'; // disable
    await dbService.initialize();
    const svc = new AIConfigurationService(dbService as any);

    let error: any = null;
    try {
      await svc.saveProviderConfig({
        userId: 102,
        providerType: 'openai',
        providerName: 'OpenAI',
        isActive: true, // raw boolean
        isDefault: false,
        configuration: { a: true },
      });
    } catch (e) {
      error = e;
    } finally {
      await dbService.shutdown();
    }

    expect(error).toBeTruthy();
    expect(String(error.message || error)).toMatch(/bind|SQLite3 can only bind/i);
  });
});
