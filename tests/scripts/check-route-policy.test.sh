#!/usr/bin/env bash
# Regression harness for scripts/check-route-policy.mjs (PR-F0).
# Each scenario builds a synthetic repo under a temp dir and runs the gate
# with --root. Asserts exit code + a distinguishing output substring.
#
# Mutation snippets pass file paths to node as ARGUMENTS (process.argv[1]),
# never embedded in the -e script string — on Windows, MSYS path conversion
# applies to arguments but not to POSIX paths inside code strings.
set -u

SCRIPT="scripts/check-route-policy.mjs"
FAILURES=0

run_case() {
  local name="$1" expected_exit="$2" expect_substr="$3" root="$4"; shift 4
  local out exit_code
  out=$(node "$SCRIPT" --root "$root" "$@" 2>&1)
  exit_code=$?
  if [ "$exit_code" -ne "$expected_exit" ]; then
    echo "FAIL [$name]: expected exit $expected_exit, got $exit_code"; echo "$out" | head -10
    FAILURES=$((FAILURES+1)); return
  fi
  if ! printf '%s' "$out" | grep -qF "$expect_substr"; then
    echo "FAIL [$name]: output missing '$expect_substr'"; echo "$out" | head -10
    FAILURES=$((FAILURES+1)); return
  fi
  echo "ok  [$name]"
}

# mutate_file <path> <js-body reading process.argv[1]>
mutate_file() {
  local target="$1" body="$2"
  node -e "const fs=require('fs');const f=process.argv[1];$body" "$target"
}

make_fixture() {
  # $1 = dir. Writes a minimal valid manifest+policy pair that PASSES.
  # The synthetic routePolicy.ts is annotation-free JS-in-TS on purpose:
  # typescript.transpileModule passes it through, so one fixture serves both.
  local d="$1"
  mkdir -p "$d/src/middleware/setup" "$d/src/routes/central" "$d/src/middleware/governance" "$d/src/services/governance"
  cat > "$d/src/middleware/setup/routeManifest.ts" <<'EOF'
export const ROUTE_MANIFEST = Object.freeze([
  { path: '/api/alpha', classification: 'tenant_required' },
  { path: '/api/beta', classification: 'public' },
]);
EOF
  cat > "$d/src/middleware/setup/routePolicy.ts" <<'EOF'
export const RATE_PROFILES = Object.freeze({
  tenant_api: { description: 'x', enforcedBy: 'declarative_only' },
  anonymous_read: { description: 'x', enforcedBy: 'declarative_only' },
});
export function routePrefixMatches(reqPath, prefix) {
  return reqPath === prefix || reqPath.startsWith(prefix + '/');
}
export const ROUTE_POLICY_MANIFEST = Object.freeze([
  { match: { pathPrefix: '/api/alpha' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },
  { match: { pathPrefix: '/api/beta' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },
]);
EOF
  # Minimal clean identity inventory used by the transitive Stage 3 guard.
  cat > "$d/src/services/governance/identityContext.ts" <<'EOF'
export function extractIdentityContext(req) {
  return { tenantId: 'fixture-tenant', userId: 'fixture-user' };
}
EOF
  cat > "$d/src/services/governance/resolveActor.ts" <<'EOF'
export function resolveActor(req) {
  return req.user?.id;
}
EOF
  cat > "$d/src/middleware/tenantStatusGate.ts" <<'EOF'
export function makeTenantStatusGate() {
  return (_req, _res, next) => next();
}
EOF
  cat > "$d/src/middleware/governanceMiddleware.ts" <<'EOF'
export function createGovernanceMiddleware() {
  return (_req, _res, next) => next();
}
EOF
  cat > "$d/src/middleware/governance/approvalQueueErrorHandler.ts" <<'EOF'
export async function handleApprovalQueueError() {
  return false;
}
EOF
  cat > "$d/src/routes/central/centralTenant.ts" <<'EOF'
export function resolveCentralTenantId(_req, _res) {
  return 'fixture-tenant';
}
EOF
  printf '' > "$d/.route-system-identity-baseline"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Composed so fixture-only file names never appear as bare repo-relative
# literals (the inbound-link gate would treat them as broken refs).
SI_DIR="src/routes"

# 1. valid fixture passes
make_fixture "$TMP/ok"
run_case "valid-fixture-ok" 0 "check-route-policy: OK" "$TMP/ok"

# 2. manifest path without a policy → POLICY_COVERAGE
make_fixture "$TMP/miss"
mutate_file "$TMP/miss/src/middleware/setup/routePolicy.ts" \
  "fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(/^.*\/api\/beta.*$/m,''));"
run_case "missing-policy" 1 "POLICY_COVERAGE" "$TMP/miss"

# 3. policy without a manifest path → ORPHAN_POLICY
make_fixture "$TMP/orphan"
mutate_file "$TMP/orphan/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n  { match: { pathPrefix: '/api/ghost' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },\"));
"
run_case "orphan-policy" 1 "ORPHAN_POLICY" "$TMP/orphan"

# 4. prefix with only a scoped policy (no base) → BASE_POLICY
make_fixture "$TMP/nobase"
mutate_file "$TMP/nobase/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  \"{ match: { pathPrefix: '/api/beta' }\",
  \"{ match: { pathPrefix: '/api/beta', methods: ['GET'] }\"));
"
run_case "missing-base-policy" 1 "BASE_POLICY" "$TMP/nobase"

# 5. tenant_required with a public base policy → CLASSIFICATION_CONSISTENCY
make_fixture "$TMP/mismatch"
mutate_file "$TMP/mismatch/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  \"{ match: { pathPrefix: '/api/alpha' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' }\",
  \"{ match: { pathPrefix: '/api/alpha' }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'tenant_api' }\"));
"
run_case "classification-mismatch" 1 "CLASSIFICATION_CONSISTENCY" "$TMP/mismatch"

# 6. rateProfile not in RATE_PROFILES → RATE_PROFILE_KEY
make_fixture "$TMP/badkey"
mutate_file "$TMP/badkey/src/middleware/setup/routePolicy.ts" \
  "fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(\"rateProfile: 'anonymous_read' }\", \"rateProfile: 'made_up' }\"));"
run_case "unknown-rate-profile" 1 "RATE_PROFILE_KEY" "$TMP/badkey"

# 7. unparseable policy module → exit 2 (fail closed)
make_fixture "$TMP/broken"
printf 'export const ROUTE_POLICY_MANIFEST = ][;;;' > "$TMP/broken/src/middleware/setup/routePolicy.ts"
run_case "broken-module-fails-closed" 2 "check-route-policy" "$TMP/broken"

# 8. the real repo passes
run_case "real-repo-ok" 0 "check-route-policy: OK" "."

# 9. equal prefix, overlapping methods, same specificity → AMBIGUOUS_OVERLAP
make_fixture "$TMP/ambig"
mutate_file "$TMP/ambig/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['GET'] }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['GET','POST'] }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },\"));
"
run_case "ambiguous-methods-overlap" 1 "AMBIGUOUS_OVERLAP" "$TMP/ambig"

# 10. two subpath refinements with statically-disjoint anchored literals → OK
make_fixture "$TMP/disjoint"
mutate_file "$TMP/disjoint/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n\" +
  \"  { match: { pathPrefix: '/api/alpha', subpath: /^\\\\/run(\\\\/|\$)/ }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'tenant_api' },\n\" +
  \"  { match: { pathPrefix: '/api/alpha', subpath: /^\\\\/schema(\\\\/|\$)/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },\"));
"
run_case "disjoint-subpaths-ok" 0 "check-route-policy: OK" "$TMP/disjoint"

# 11. two subpath refinements NOT statically disjoint → AMBIGUOUS_OVERLAP
make_fixture "$TMP/regexambig"
mutate_file "$TMP/regexambig/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n\" +
  \"  { match: { pathPrefix: '/api/alpha', subpath: /run/ }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'tenant_api' },\n\" +
  \"  { match: { pathPrefix: '/api/alpha', subpath: /r/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },\"));
"
run_case "undecidable-subpath-overlap" 1 "AMBIGUOUS_OVERLAP" "$TMP/regexambig"

# 12. direct and one-hop extractor calls are TRANSITIVE_SYSTEM_IDENTITY violations
make_fixture "$TMP/transitive"
cat > "$TMP/transitive/src/services/governance/resolveActor.ts" <<'EOF'
import { extractIdentityContext as readIdentity } from './identityContext';
export function resolveActor(req) { return readIdentity(req).userId; }
EOF
cat > "$TMP/transitive/src/routes/transitive.ts" <<'EOF'
import { resolveActor as actorForWrite } from '../services/governance/resolveActor';
export function handler(req) { return actorForWrite(req); }
EOF
run_case "transitive-system-identity" 1 "TRANSITIVE_SYSTEM_IDENTITY" "$TMP/transitive"

make_fixture "$TMP/transitive-namespace"
cat > "$TMP/transitive-namespace/src/services/governance/resolveActor.ts" <<'EOF'
import * as identity from './identityContext';
export function resolveActor(req) { return identity.extractIdentityContext(req).userId; }
EOF
cat > "$TMP/transitive-namespace/src/routes/transitiveNamespace.ts" <<'EOF'
import { resolveActor } from '../services/governance/resolveActor';
export function handler(req) { return resolveActor(req); }
EOF
run_case "transitive-namespace-system-identity" 1 "TRANSITIVE_SYSTEM_IDENTITY" "$TMP/transitive-namespace"

make_fixture "$TMP/unresolved"
cat > "$TMP/unresolved/src/routes/unresolved.ts" <<'EOF'
import { resolveActor } from '../services/governance/missingIdentityWrapper';
export function handler(req) { return resolveActor(req); }
EOF
run_case "unresolved-local-import-fails-closed" 2 "unresolved local import" "$TMP/unresolved"

# 14. unparsable HTTP-root source â†’ fail closed with exit 2
make_fixture "$TMP/malformed"
printf 'export function handler(req) { return (\n' > "$TMP/malformed/src/routes/malformed.ts"
run_case "malformed-source-fails-closed" 2 "TRANSITIVE_PARSE" "$TMP/malformed"

make_fixture "$TMP/si-new"
cat > "$TMP/si-new/src/routes/newRoute.ts" <<'EOF'
import { extractIdentityContext } from '../services/governance/identityContext';
export function handler(req) { return extractIdentityContext(req); }
EOF
run_case "system-identity-new-callsite" 1 "SYSTEM_IDENTITY" "$TMP/si-new"

# --write re-stamps the historical baseline but cannot suppress the transitive guard
node "$SCRIPT" --root "$TMP/si-new" --write >/dev/null 2>&1
run_case "system-identity-restamped" 1 "TRANSITIVE_SYSTEM_IDENTITY" "$TMP/si-new"
if ! grep -qF "$SI_DIR/newRoute.ts" "$TMP/si-new/.route-system-identity-baseline"; then
  echo "FAIL [baseline-written]: newRoute.ts not in re-stamped baseline"; FAILURES=$((FAILURES+1))
else
  echo "ok  [baseline-written]"
fi

# 14. stale baseline entry (file no longer calls) → SYSTEM_IDENTITY until re-stamped
make_fixture "$TMP/si-stale"
printf '%s/gone.ts\n' "$SI_DIR" > "$TMP/si-stale/.route-system-identity-baseline"
run_case "system-identity-stale-entry" 1 "SYSTEM_IDENTITY" "$TMP/si-stale"

# 15. --forbid-system-identity-fallback fails while baseline non-empty (F6 wiring)
run_case "forbid-flag-nonempty" 1 "SYSTEM_IDENTITY" "$TMP/si-new" --forbid-system-identity-fallback

# 16. doc-comment mention only (no call) → not counted
make_fixture "$TMP/si-comment"
cat > "$TMP/si-comment/src/routes/commentOnly.ts" <<'EOF'
// Role helpers only; see extractIdentityContext( for the JWT path.
export const x = 1;
EOF
run_case "comment-mention-not-counted" 0 "check-route-policy: OK" "$TMP/si-comment"

# 16b. PR-F5b-3: a route file calling ONLY resolveCentralTenantId is NO LONGER
# counted — that helper resolves attested anonymous demo reads to
# CENTRAL_DEMO_TENANT_ID, not SYSTEM_IDENTITY, so its callers cannot reach the
# system identity. (F5b counted it; the clause was deleted when the demo
# fixtures moved onto their own tenant.)
make_fixture "$TMP/si-central"
cat > "$TMP/si-central/src/routes/centralRoute.ts" <<'EOF'
import { resolveCentralTenantId } from './central/centralTenant';
export function handler(req, res) { return resolveCentralTenantId(req, res); }
EOF
run_case "helper-call-no-longer-counted" 0 "check-route-policy: OK" "$TMP/si-central"

# 17. missing baseline file (no --write) → exit 2 (fail closed)
make_fixture "$TMP/nobaseline"
rm "$TMP/nobaseline/.route-system-identity-baseline"
run_case "missing-baseline-fails-closed" 2 "baseline missing" "$TMP/nobaseline"

# 18. lifecycle-only mismatch (auth stays valid) → CLASSIFICATION_CONSISTENCY
make_fixture "$TMP/lifecycle"
mutate_file "$TMP/lifecycle/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  \"{ match: { pathPrefix: '/api/alpha' }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' }\",
  \"{ match: { pathPrefix: '/api/alpha' }, auth: 'required', lifecycle: 'not_applicable', rateProfile: 'tenant_api' }\"));
"
run_case "lifecycle-only-mismatch" 1 "CLASSIFICATION_CONSISTENCY" "$TMP/lifecycle"

# 19. exact-duplicate scoped policies → AMBIGUOUS_OVERLAP
make_fixture "$TMP/dup"
mutate_file "$TMP/dup/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['GET'] }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['GET'] }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },\"));
"
run_case "exact-duplicate-rejected" 1 "AMBIGUOUS_OVERLAP" "$TMP/dup"

# 20. case-insensitive flag voids the anchored-literal disjointness proof → AMBIGUOUS_OVERLAP
make_fixture "$TMP/flagambig"
mutate_file "$TMP/flagambig/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n\" +
  \"  { match: { pathPrefix: '/api/alpha', subpath: /^\\\\/run(\\\\/|\$)/i }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'tenant_api' },\n\" +
  \"  { match: { pathPrefix: '/api/alpha', subpath: /^\\\\/RUN(\\\\/|\$)/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },\"));
"
run_case "regex-flag-voids-disjointness" 1 "AMBIGUOUS_OVERLAP" "$TMP/flagambig"

# 21. same-subpath pair ordered by method presence (resolver specificity #3) → OK
make_fixture "$TMP/methodorder"
mutate_file "$TMP/methodorder/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n\" +
  \"  { match: { pathPrefix: '/api/alpha', subpath: /^\\\\/run(\\\\/|\$)/ }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['POST'], subpath: /^\\\\/run(\\\\/|\$)/ }, auth: 'platform_admin', lifecycle: 'not_applicable', rateProfile: 'tenant_api' },\"));
"
run_case "method-presence-orders-subpath-pair" 0 "check-route-policy: OK" "$TMP/methodorder"

# 22. multi-segment anchored literals with distinct tails are provably disjoint
make_fixture "$TMP/multiseg-ok"
mutate_file "$TMP/multiseg-ok/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['POST'], subpath: /^\\\\/mapping\\\\/suggestions(\\\\/|\$)/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['POST'], subpath: /^\\\\/mapping\\\\/feedback(\\\\/|\$)/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },\"));
"
run_case "multiseg-disjoint-ok" 0 "check-route-policy: OK" "$TMP/multiseg-ok"

# 23. nested multi-segment literals (one a prefix of the other) are AMBIGUOUS
make_fixture "$TMP/multiseg-nested"
mutate_file "$TMP/multiseg-nested/src/middleware/setup/routePolicy.ts" "
fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(
  'export const ROUTE_POLICY_MANIFEST = Object.freeze([',
  \"export const ROUTE_POLICY_MANIFEST = Object.freeze([\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['POST'], subpath: /^\\\\/mapping(\\\\/|\$)/ }, auth: 'public', lifecycle: 'not_applicable', rateProfile: 'anonymous_read' },\n\" +
  \"  { match: { pathPrefix: '/api/alpha', methods: ['POST'], subpath: /^\\\\/mapping\\\\/suggestions(\\\\/|\$)/ }, auth: 'required', lifecycle: 'enforce', rateProfile: 'tenant_api' },\"));
"
run_case "multiseg-nested-ambiguous" 1 "AMBIGUOUS_OVERLAP" "$TMP/multiseg-nested"

if [ "$FAILURES" -gt 0 ]; then echo "check-route-policy.test.sh: $FAILURES failure(s)"; exit 1; fi
echo "check-route-policy.test.sh: all scenarios passed"
