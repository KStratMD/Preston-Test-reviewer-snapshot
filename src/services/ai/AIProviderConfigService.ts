import fs from 'fs';
import path from 'path';
import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { AIProviderMode } from './providers/types';
import { RuleBasedProvider } from './providers/RuleBasedProvider';
import { CloudAIProvider } from './providers/CloudAIProvider';
import { LocalLLMProvider } from './providers/LocalLLMProvider';

export interface StoredAIConfig {
  mode: AIProviderMode;
  cloud?: { model?: string };
  local?: { baseUrl?: string; model?: string };
}

@injectable()
export class AIProviderConfigService {
  private readonly logger: Logger;
  private readonly configDir: string;
  private readonly filePath: string;
  private cache: StoredAIConfig | null = null;

  constructor(@inject(TYPES.Logger) logger: Logger, @inject(TYPES.ConfigDirectory) configDir: string) {
    this.logger = logger;
    this.configDir = configDir || 'integrations';
    const dir = path.resolve(process.cwd(), this.configDir);
    try { 
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); 
    } catch {
      // Ignore directory creation errors
    }
    this.filePath = path.join(dir, 'ai-provider.json');
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.cache = JSON.parse(raw);
      } else {
        this.cache = { mode: 'rule-based' };
        this.save();
      }
    } catch (e) {
      this.logger.warn('Failed to load AI provider config; defaulting to rule-based', { error: String(e) });
      this.cache = { mode: 'rule-based' };
    }
  }

  private save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (e) {
      this.logger.warn('Failed to persist AI provider config', { error: String(e) });
    }
  }

  public getConfig(): StoredAIConfig {
    return this.cache || { mode: 'rule-based' };
  }

  public setConfig(cfg: StoredAIConfig) {
    this.cache = cfg;
    this.save();
  }

  public getProvider(logger: Logger) {
    const cfg = this.getConfig();
    if (cfg.mode === 'cloud-api') return new CloudAIProvider(logger, { model: cfg.cloud?.model });
    if (cfg.mode === 'local-llm') return new LocalLLMProvider(logger, { baseUrl: cfg.local?.baseUrl, model: cfg.local?.model });
    return new RuleBasedProvider(logger);
  }
}

