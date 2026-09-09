/**
 * Operator CLI for embedded role grants.
 *
 * This is the only way a privileged role enters the system. The embedded host
 * cannot mint one: before the grant table existed, a host-bootstrap body
 * carrying `["admin","approver"]` authorized itself over its own tenant's
 * governance queue (measured 2026-09-03).
 *
 *   npm run embedded-role:grant -- --tenant t1 --platform netsuite \
 *       --account acct_1 --user u1 --role approver --granted-by kerry
 *   npm run embedded-role:grant -- --tenant t1 --platform netsuite \
 *       --account acct_1 --user u1 --role approver --granted-by kerry \
 *       --expires-at 2026-12-31T00:00:00.000Z
 *   npm run embedded-role:grant -- --revoke erg_xxx --granted-by kerry
 *
 * The secret is printed ONCE and never stored in the clear. It must reach the
 * user out of band — not through the host operator, who is precisely the party
 * the grant exists to stop from self-appointing.
 */
import 'reflect-metadata';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { EmbeddedRoleGrantRepository } from '../services/embedded/EmbeddedRoleGrantRepository';
import type { DatabaseService } from '../database/DatabaseService';
import {
  conformanceRefusalMessage,
  isAssertionConformanceVerified,
} from '../embedded/assertionConformance';

const ROLES = ['viewer', 'requester', 'approver', 'admin'] as const;
type Role = (typeof ROLES)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  // `--role --granted-by kerry` would otherwise silently take '--granted-by'
  // as the role and produce a CHECK-constraint failure far from the cause.
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function must(name: string): string {
  const value = arg(name);
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Parse and validate every argument BEFORE opening the database, so an
 * operator typo fails immediately instead of after a connect-and-migrate.
 */
function parseArgs():
  | { kind: 'revoke'; grantedBy: string; revokeId: string }
  | {
      kind: 'grant';
      grantedBy: string;
      tenantId: string;
      platform: string;
      account: string;
      userId: string;
      role: Role;
      expiresAt: string | null;
      acceptUnverified: boolean;
    } {
  const grantedBy = must('granted-by');

  const revokeId = arg('revoke');
  if (revokeId !== undefined) return { kind: 'revoke', grantedBy, revokeId };

  const role = must('role');
  if (!isRole(role)) throw new Error(`--role must be one of ${ROLES.join('|')}`);

  const expiresAt = arg('expires-at') ?? null;
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('--expires-at must be an ISO 8601 timestamp');
  }

  return {
    kind: 'grant',
    grantedBy,
    tenantId: must('tenant'),
    platform: must('platform'),
    account: must('account'),
    userId: must('user'),
    role,
    expiresAt,
    acceptUnverified: process.argv.includes('--i-accept-unverified-assertions'),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs();

  // getAsync, not get: DatabaseService has asynchronous dependencies, and a
  // synchronous construct fails with "You are attempting to construct
  // Symbol(DatabaseService) in a synchronous way". src/cli/credential-manager.ts
  // resolves its services the same way.
  const dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
  await dbService.initialize();
  const repo = await container.getAsync<EmbeddedRoleGrantRepository>(TYPES.EmbeddedRoleGrantRepository);

  const grantedBy = parsed.grantedBy;

  if (parsed.kind === 'revoke') {
    const revokeId = parsed.revokeId;
    const revoked = await repo.revoke(revokeId, grantedBy);
    // Distinguish "closed it" from "there was nothing open" — an operator
    // revoking in an incident needs to know which one happened.
    process.stdout.write(
      revoked ? `revoked ${revokeId}\n` : `no open grant ${revokeId} — nothing was revoked\n`,
    );
    if (!revoked) process.exitCode = 1;
    return;
  }

  // A grant is only useful if the platform's HMAC agrees with this server's,
  // and that cannot be established from this repository. Refusing here turns a
  // silent failure — assertions that never verify, presenting as a permanent
  // 403 with no explanation — into a message at the moment the grant would have
  // been created. The escape hatch exists for a platform where the assertion
  // path is deliberately unused, and it names what it is.
  if (!isAssertionConformanceVerified(parsed.platform) && !parsed.acceptUnverified) {
    throw new Error(conformanceRefusalMessage(parsed.platform));
  }

  const { expiresAt } = parsed;
  const { row, secret } = await repo.grant({
    tenant_id: parsed.tenantId,
    platform: parsed.platform,
    platform_account_id: parsed.account,
    user_id: parsed.userId,
    role: parsed.role,
    source: 'squire_operator',
    granted_by: grantedBy,
    expires_at: expiresAt,
  });

  process.stdout.write(
    `granted ${row.id}: ${row.role} to ${row.user_id} in ` +
      `${row.tenant_id}/${row.platform}/${row.platform_account_id}\n`,
  );
  if (expiresAt !== null) process.stdout.write(`expires ${expiresAt}\n`);
  process.stdout.write(
    'secret (shown once — deliver to the user out of band, never to the host ' +
      `operator): ${secret}\n`,
  );
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
