# A1 Credential-Containment Evidence

Status: local containment complete; authenticated Railway metadata check complete; external-provider rotation remains pending.

- Branch: `readiness-a1-credential-containment`
- Containment commit: `013ce55a87f00bfd1ac4ff79028d310724cac777`
- Prior clean parent: `708b5cca99ebf02aee33de66a8b517b38830e5b1`
- Date recorded: 2026-08-03 (America/Denver)

## Approval scope

KStratMD authorized:

1. Redaction of the two tracked inline authentication fields in `src/examples/suitecentral-config.json`.
2. A value-safe Railway check for variable presence and persisted seeded-record authentication fields.
3. Rotation only of confirmed secret-bearing credentials.

No production values are recorded in this note.

## Tracked artifact resolution

The A1.4 report-only audit identified two credential-shaped fields in `src/examples/suitecentral-config.json`, record `squire_to_suitecentral_customers`. The fields were removed in the containment commit. The source and target systems now declare `credentialSource: "environment"`; no inline authentication object remains.

The post-change audit reports:

```text
npm run audit:configuration-artifacts
 audit-configuration-artifacts: OK (no credential-bearing JSON artifacts found)
```

Rollback is `git revert 013ce55a87f00bfd1ac4ff79028d310724cac777`. The pre-change artifact remains available in the parent commit for review; it is not reproduced here.

## Exposure evidence

The exposure audit recorded the following value-safe evidence:

- GitHub deployment history records 514 Railway production deployments from 2026-02-20 through 2026-08-02; the latest recorded production deployment succeeded. See the repository [deployment history](https://github.com/KStratMD/Preston-Test/deployments).
- Historical hosted code compiled and ran `loadSampleDataIfNeeded` (`src/index.ts`), which could seed sample configurations from deployment environment credentials when storage was empty.
- At the original hosted revision, configuration read routes were mounted without authentication and returned raw configurations. Authentication was added on 2026-05-28 (`src/routes/configuration.ts` history).
- The current `GET https://api.kstratmdconsulting.com/api/configurations` response is 403, so the endpoint is closed today. Current closure does not prove that historical exposure never occurred.

Potentially affected credential families, conditional on production variables having been populated, are Salesforce client credentials; NetSuite account, consumer, and token credentials; Dynamics client credentials and token endpoint configuration; and Business Central client credentials and token endpoint configuration. Historical presence and values are not established by this evidence.

## Railway check status

The authorized metadata-only check was completed in the signed-in Railway session for project Squire Demo, environment production, service Preston-Test-main:

- 66 service variables are present by name. Connector-related names present: DYNAMICS_CLIENT_ID, DYNAMICS_CLIENT_SECRET, DYNAMICS_RESOURCE_URL, DYNAMICS_TENANT_ID, NETSUITE_ACCOUNT_ID, NETSUITE_BASE_URL, NETSUITE_CONSUMER_KEY, NETSUITE_CONSUMER_SECRET, NETSUITE_TOKEN_ID, and NETSUITE_TOKEN_SECRET.
- No Salesforce or Business Central variable names were present in the visible service-variable inventory.
- The deployed /app/integrations directory contains no JSON configuration files, and the value-safe scan found no persisted seeded-record authentication key paths. This establishes the current container state only; it does not prove that an earlier ephemeral container never held records.
- Values remained masked throughout. No show/copy action was used; no production credential value was printed, copied, transmitted, or logged.
- No rotation was performed. Railway can store replacements, but it cannot mint replacement Dynamics or NetSuite credentials; replacing those values without vendor-issued credentials would either invent credentials or break the service. The confirmed rotation list is therefore the external-provider families represented by DYNAMICS_CLIENT_SECRET, NETSUITE_CONSUMER_SECRET, and NETSUITE_TOKEN_SECRET, with their paired identifiers reviewed together at the provider. After vendor rotation, the new values must be entered in Railway and the service redeployed.

## Verification

All checks below were run against the containment commit on the Windows worktree unless marked WSL:

- Focused A1 Jest gate: 5 suites, 108 tests passed.
- Full unit profile: 644 suites passed, 1 skipped; 13,578 tests passed, 10 skipped.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run check:any-budget`: passed at the existing budget.
- `npm run check:strict-null-budget`: passed at the existing budget.
- Core coverage: 107 suites, 2,447 tests passed; core coverage budget passed for 87 files.
- `npm run audit-route-policy`: passed.
- `npm run audit-tenant-isolation-invariant`: passed.
- `npm run audit-secret-key-encryption`: passed.
- `npm run audit:configuration-artifacts`: passed.
- WSL exact-SHA worktree: Node 22.22.2, environment-parity audit, typecheck, focused A1 Jest gate, artifact audit, encryption audit, sync-status harness, encryption regression harness, and route-abstention harness passed.

The full Jest run emits existing test-path diagnostics and simulated error logs, but exited 0 with the pass counts above.