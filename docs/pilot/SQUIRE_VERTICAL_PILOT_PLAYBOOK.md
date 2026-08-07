# Squire Vertical Pilot Playbook

**Pilot length:** two weeks
**Pilot wedge:** one governed HubSpot-to-NetSuite or Squire-to-NetSuite flow
**Executive sponsor:** named in pilot kickoff
**Consultant owner:** named in pilot kickoff
**Technical owner:** named in pilot kickoff

## Entry Criteria

- Tenant row exists and is `active`.
- Embedded service token is provisioned for at least one ERP platform.
- Governance posture is configured through tenant settings.
- Pilot flow template is selected and documented.
- Reconciliation and lineage evidence rows are either enabled or explicitly marked out of pilot scope.

## Success Metrics

1. Cycle time from source-record readiness to target-record write.
2. Percentage of writes requiring human approval.
3. Approval queue resolution time.
4. Reconciliation exceptions opened and resolved.
5. Lineage chains queryable for sampled records.
6. Operator adoption feedback from consultant owner.

## Exit Criteria

- At least one pilot flow completes with governance evidence.
- At least one sampled target record has a queryable lineage chain.
- Pilot readiness packet records any manual step and any evidence gap.
- Executive sponsor chooses continue, pause, or stop.

## Provisioning

See [`PILOT_PROVISIONING_RUNBOOK.md`](./PILOT_PROVISIONING_RUNBOOK.md) for the
operator commands that provision a pilot tenant, mint its embedded service
token, and verify the resulting artifact.
