# Pilot Provisioning Runbook

This runbook drives `scripts/provision-pilot-tenant.mjs`, which is a thin
orchestration wrapper. Token minting is delegated to the existing TypeScript
CLI `npm run rotate-embedded-service-token`; this script never writes to
embedded-token storage directly.

The script accepts exactly one of `--dry-run`, `--apply`, or `--verify`.
`--platform` must be one of `netsuite` or `business_central`.

## Dry Run

Prints the deterministic provisioning plan without touching token storage or
tenant configuration:

```bash
npm run provision:pilot-tenant -- \
  --tenant t_squire_pilot \
  --platform netsuite \
  --platform-account-id TSTDRV2698307 \
  --dry-run
```

## Apply

Mints the embedded service token through the existing TypeScript CLI and
writes the resulting `{rawToken, tokenHash}` plus deterministic plan to the
artifact at `--output`. The artifact is the only input that `--verify`
trusts and is the only place the raw bearer token is stored — stdout prints
a redacted summary (`"rawTokenRedacted": true`) so the token never lands in
terminal scrollback or CI logs. Read the raw token from the artifact file
and hand it to the platform admin over the secure channel your organization
uses for shared secrets:

```bash
npm run provision:pilot-tenant -- \
  --tenant t_squire_pilot \
  --platform netsuite \
  --platform-account-id TSTDRV2698307 \
  --apply \
  --output ./pilot-provisioning.json
```

## Verification

Reads the artifact written by `--apply` and fails closed when the file is
missing or its `tenantId`, `platform`, `platformAccountId`, or
`embeddedServiceToken.{rawToken,tokenHash}` fields are missing or do not
match the CLI arguments. The companion audits confirm that the resulting
tenant configuration uses encrypted secret rows and the documented
governance-posture reader:

```bash
npm run provision:pilot-tenant -- \
  --tenant t_squire_pilot \
  --platform netsuite \
  --platform-account-id TSTDRV2698307 \
  --verify \
  --provisioning-output ./pilot-provisioning.json
npm run audit-secret-key-encryption
npm run audit-governance-posture-reads
```
