import { injectable, inject, optional } from 'inversify';
import { sql } from 'kysely';
import { TYPES } from '../../inversify/types';
import { mcpGatewayConfig } from '../../config/env';
import type { Logger } from '../../utils/Logger';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database } from '../../database/types';
import type { Kysely } from 'kysely';

export interface MCPPolicy {
  allowlist: string[];
  denylist: string[];
  disabledTenants: string[];
  defaultBehavior: 'suitecentral_allow_external_explicit';
  dbPolicies?: MCPToolPolicy[];
}

export interface MCPPolicyDecision {
  allowed: boolean;
  reason: string;
  matchedAllowPattern?: string;
  matchedDenyPattern?: string;
}

export type MCPPolicyAction = 'allow' | 'deny';

export interface MCPToolPolicy {
  id: number;
  tenantId: string;
  systemName: string;
  toolPattern: string;
  action: MCPPolicyAction;
  createdAt: Date;
}

interface MCPToolPolicyRow {
  id: number;
  tenant_id: string;
  system_name: string;
  tool_pattern: string;
  action: MCPPolicyAction;
  created_at: string | Date;
}

interface MCPPolicyServiceOptions {
  allowlist?: string;
  denylist?: string;
  disabledTenants?: string;
  dbCacheTtlMs?: number;
}

@injectable()
export class MCPPolicyService {
  private readonly allowlist: string[];
  private readonly denylist: string[];
  private readonly disabledTenants: Set<string>;
  private readonly dbCacheTtlMs: number;
  private readonly policyCache = new Map<string, { expiresAt: number; policies: MCPToolPolicy[] }>();
  private readonly db?: Kysely<Database>;

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @optional() @inject(TYPES.DatabaseService) dbService?: DatabaseService,
    options?: MCPPolicyServiceOptions
  ) {
    const config = {
      allowlist: options?.allowlist ?? mcpGatewayConfig.policy.allowlist,
      denylist: options?.denylist ?? mcpGatewayConfig.policy.denylist,
      disabledTenants: options?.disabledTenants ?? mcpGatewayConfig.policy.disabledTenants,
    };

    this.allowlist = this.parseCsv(config.allowlist);
    this.denylist = this.parseCsv(config.denylist);
    this.disabledTenants = new Set(this.parseCsv(config.disabledTenants));
    this.dbCacheTtlMs = options?.dbCacheTtlMs ?? 30000;

    try {
      this.db = dbService?.getDatabase();
    } catch {
      this.db = undefined;
    }

    this.logger.info('MCP policy service initialized', {
      allowlistCount: this.allowlist.length,
      denylistCount: this.denylist.length,
      disabledTenantCount: this.disabledTenants.size,
      dbBackedPolicies: Boolean(this.db),
      dbCacheTtlMs: this.dbCacheTtlMs,
    });
  }

  async evaluateToolAccess(tenantId: string, system: string, toolName: string): Promise<MCPPolicyDecision> {
    const normalizedTenant = (tenantId || '').trim();
    const normalizedSystem = (system || '').trim().toLowerCase();
    const normalizedTool = (toolName || '').trim();
    const target = `${normalizedSystem}.${normalizedTool}`;

    if (normalizedTenant && this.disabledTenants.has(normalizedTenant)) {
      return {
        allowed: false,
        reason: `tenant_disabled:${normalizedTenant}`,
      };
    }

    const denyMatch = this.findMatchingPattern(this.denylist, target);
    if (denyMatch) {
      return {
        allowed: false,
        reason: `denylist_match:${denyMatch}`,
        matchedDenyPattern: denyMatch,
      };
    }

    const dbPolicyMatch = await this.findDbPolicyMatch(normalizedTenant, normalizedSystem, normalizedTool);
    if (dbPolicyMatch?.denyPolicy) {
      return {
        allowed: false,
        reason: `db_deny:${dbPolicyMatch.denyPolicy.id}`,
        matchedDenyPattern: `${dbPolicyMatch.denyPolicy.systemName}.${dbPolicyMatch.denyPolicy.toolPattern}`,
      };
    }

    if (normalizedSystem === 'suitecentral') {
      return {
        allowed: true,
        reason: 'suitecentral_default_allow',
      };
    }

    if (dbPolicyMatch?.allowPolicy) {
      return {
        allowed: true,
        reason: `db_allow:${dbPolicyMatch.allowPolicy.id}`,
        matchedAllowPattern: `${dbPolicyMatch.allowPolicy.systemName}.${dbPolicyMatch.allowPolicy.toolPattern}`,
      };
    }

    const allowMatch = this.findMatchingPattern(this.allowlist, target);
    if (allowMatch) {
      return {
        allowed: true,
        reason: `allowlist_match:${allowMatch}`,
        matchedAllowPattern: allowMatch,
      };
    }

    return {
      allowed: false,
      reason: this.allowlist.length > 0
        ? 'external_tool_not_allowlisted'
        : 'external_tools_require_allowlist',
    };
  }

  async isToolAllowed(tenantId: string, system: string, toolName: string): Promise<boolean> {
    const decision = await this.evaluateToolAccess(tenantId, system, toolName);
    return decision.allowed;
  }

  async getPolicy(tenantId: string): Promise<MCPPolicy> {
    return {
      allowlist: [...this.allowlist],
      denylist: [...this.denylist],
      disabledTenants: Array.from(this.disabledTenants),
      defaultBehavior: 'suitecentral_allow_external_explicit',
      dbPolicies: await this.listToolPolicies(tenantId),
    };
  }

  async listToolPolicies(tenantId: string): Promise<MCPToolPolicy[]> {
    const normalizedTenant = (tenantId || '').trim();
    if (!normalizedTenant || !this.db) {
      return [];
    }

    const now = Date.now();
    const cached = this.policyCache.get(normalizedTenant);
    if (cached && cached.expiresAt > now) {
      return cached.policies;
    }

    const result = await sql<MCPToolPolicyRow>`
      SELECT id, tenant_id, system_name, tool_pattern, action, created_at
      FROM mcp_tool_policies
      WHERE tenant_id = ${normalizedTenant}
      ORDER BY id ASC
    `.execute(this.db);

    const policies = (result.rows as MCPToolPolicyRow[]).map(row => this.mapPolicyRow(row));
    this.policyCache.set(normalizedTenant, {
      expiresAt: now + this.dbCacheTtlMs,
      policies,
    });

    return policies;
  }

  async upsertToolPolicy(input: {
    tenantId: string;
    systemName: string;
    toolPattern: string;
    action: MCPPolicyAction;
  }): Promise<MCPToolPolicy> {
    if (!this.db) {
      throw new Error('MCP tool policy persistence is unavailable (database not configured)');
    }

    const tenantId = input.tenantId.trim();
    const systemName = input.systemName.trim().toLowerCase();
    const toolPattern = input.toolPattern.trim();
    const action = input.action;

    if (!tenantId || !systemName || !toolPattern) {
      throw new Error('tenantId, systemName, and toolPattern are required');
    }

    if (action !== 'allow' && action !== 'deny') {
      throw new Error('action must be either "allow" or "deny"');
    }

    const result = await sql<MCPToolPolicyRow>`
      INSERT INTO mcp_tool_policies (tenant_id, system_name, tool_pattern, action)
      VALUES (${tenantId}, ${systemName}, ${toolPattern}, ${action})
      ON CONFLICT (tenant_id, system_name, tool_pattern)
      DO UPDATE SET action = EXCLUDED.action
      RETURNING id, tenant_id, system_name, tool_pattern, action, created_at
    `.execute(this.db);

    const row = (result.rows[0] as MCPToolPolicyRow | undefined);
    if (!row) {
      throw new Error('Failed to upsert MCP tool policy');
    }

    this.invalidatePolicyCache(tenantId);
    return this.mapPolicyRow(row);
  }

  async deleteToolPolicy(id: number, tenantId?: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('MCP tool policy persistence is unavailable (database not configured)');
    }

    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('id must be a positive integer');
    }

    if (tenantId && tenantId.trim().length > 0) {
      const result = await sql`
        DELETE FROM mcp_tool_policies
        WHERE id = ${id} AND tenant_id = ${tenantId.trim()}
      `.execute(this.db);
      this.invalidatePolicyCache(tenantId.trim());
      return Number(result.numAffectedRows || 0n) > 0;
    }

    const result = await sql`
      DELETE FROM mcp_tool_policies
      WHERE id = ${id}
    `.execute(this.db);
    this.policyCache.clear();
    return Number(result.numAffectedRows || 0n) > 0;
  }

  private parseCsv(value?: string): string[] {
    if (!value) {
      return [];
    }

    return value
      .split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0);
  }

  private findMatchingPattern(patterns: string[], value: string): string | undefined {
    return patterns.find(pattern => this.matchesPattern(pattern, value));
  }

  private async findDbPolicyMatch(
    tenantId: string,
    systemName: string,
    toolName: string
  ): Promise<{ allowPolicy?: MCPToolPolicy; denyPolicy?: MCPToolPolicy } | undefined> {
    if (!tenantId || !this.db) {
      return undefined;
    }

    const policies = await this.listToolPolicies(tenantId);
    if (policies.length === 0) {
      return undefined;
    }

    const matching = policies.filter(policy =>
      this.matchesPattern(policy.systemName, systemName) &&
      (this.matchesPattern(policy.toolPattern, toolName) || this.matchesPattern(policy.toolPattern, `${systemName}.${toolName}`))
    );

    if (matching.length === 0) {
      return undefined;
    }

    const denyPolicy = matching.find(policy => policy.action === 'deny');
    const allowPolicy = matching.find(policy => policy.action === 'allow');
    return { allowPolicy, denyPolicy };
  }

  private invalidatePolicyCache(tenantId?: string): void {
    if (!tenantId) {
      this.policyCache.clear();
      return;
    }
    this.policyCache.delete(tenantId);
  }

  private mapPolicyRow(row: MCPToolPolicyRow): MCPToolPolicy {
    return {
      id: Number(row.id),
      tenantId: row.tenant_id,
      systemName: row.system_name,
      toolPattern: row.tool_pattern,
      action: row.action,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }

  /**
   * Glob-style pattern match without regex (ReDoS-safe).
   * Supports `*` as a wildcard for zero-or-more characters.
   */
  private matchesPattern(pattern: string, value: string): boolean {
    if (pattern === '*') {
      return true;
    }

    if (!pattern.includes('*')) {
      return pattern.toLowerCase() === value.toLowerCase();
    }

    const lowerPattern = pattern.toLowerCase();
    const lowerValue = value.toLowerCase();
    const segments = lowerPattern.split('*');

    let pos = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.length === 0) {
        continue;
      }

      if (i === 0) {
        // First segment must match at the start
        if (!lowerValue.startsWith(seg)) {
          return false;
        }
        pos = seg.length;
      } else if (i === segments.length - 1) {
        // Last segment must match at the end
        if (!lowerValue.endsWith(seg)) {
          return false;
        }
        // Ensure no overlap with already-consumed prefix
        if (lowerValue.length - seg.length < pos) {
          return false;
        }
        pos = lowerValue.length;
      } else {
        const idx = lowerValue.indexOf(seg, pos);
        if (idx === -1) {
          return false;
        }
        pos = idx + seg.length;
      }
    }

    return true;
  }
}
