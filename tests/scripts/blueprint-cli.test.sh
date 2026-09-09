#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
SERVER_PID=''
cleanup() { if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi; rm -rf "$TMP"; }
trap cleanup EXIT
export NODE_ENV=test DOTENV_CONFIG_QUIET=true
export GITHUB_TOKEN=fixture-token GITHUB_REPOSITORY=o/r
export BP_ROOT="$ROOT" BP_TMP="$TMP"
CLI=(node "$ROOT/node_modules/ts-node/dist/bin.js" --transpile-only --project "$ROOT/tsconfig.dev.json" "$ROOT/src/cli/blueprint.ts")
run() {
  local expected=$1; shift
  local code=0
  (cd "$TMP"; "${CLI[@]}" "$@") > "$TMP/out" 2> "$TMP/err" || code=$?
  if [[ "$code" != "$expected" ]]; then cat "$TMP/out" "$TMP/err"; printf 'FAIL: expected %s, got %s\n' "$expected" "$code"; exit 1; fi
}
FIXTURE="$ROOT/tests/fixtures/blueprints/shopify-netsuite-order-to-cash.v1.json"
run 0 validate "$FIXTURE"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.env.BP_TMP+"/out"));if(r.executable||!r.reasons.includes("attestations not verified against GitHub"))process.exit(1)'
run 0 export "$FIXTURE" --out "$TMP/export"
[[ $(find "$TMP/export" -maxdepth 1 -type f | wc -l) -eq 5 ]]
run 0 questionnaire
grep -q 'Blueprint discovery questionnaire' "$TMP/out"
run 2 validate "$TMP/missing.json"
GITHUB_TOKEN='' run 2 verify-and-validate --pull 5 --head abc

BP_DOCS=docs/blueprints
mkdir -p "$TMP/pr/$BP_DOCS"
node <<'NODE'
const fs=require('fs'); const spec=JSON.parse(fs.readFileSync(process.env.BP_ROOT+'/tests/fixtures/blueprints/shopify-netsuite-order-to-cash.v1.json'));
spec.metadata.evidenceLevel='validated';spec.systems.forEach(s=>s.evidenceLevel=2);
fs.writeFileSync(process.env.BP_TMP+'/pr/' + ['docs','blueprints','example.json'].join('/'),JSON.stringify(spec));
NODE
git -C "$TMP/pr" init -q
git -C "$TMP/pr" add "$BP_DOCS/example.json"
git -C "$TMP/pr" -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture
HEAD_SHA=$(git -C "$TMP/pr" rev-parse HEAD)
export HEAD_SHA
node <<'NODE'
const fs=require('fs'),t=process.env.BP_TMP;
const state={pull:{user:{login:'someone-else'},state:'open',merged:false,head:{sha:process.env.HEAD_SHA,repo:{full_name:'o/r'}},base:{sha:'base0',ref:'Working-Branch'}},reviews:[{id:77,state:'APPROVED',commit_id:process.env.HEAD_SHA,submitted_at:'2026-09-07T00:00:00Z',user:{login:'KStratMD'}}],files:[{filename:['docs','blueprints','example.json'].join('/'),status:'added'}],contents:{[['docs','blueprints','example.json'].join('/')]:fs.readFileSync(t+'/pr/' + ['docs','blueprints','example.json'].join('/'),'utf8'),'docs/blueprint/approvers.json':fs.readFileSync(process.env.BP_ROOT+'/docs/blueprint/approvers.json','utf8')}};
fs.writeFileSync(t+'/state.json',JSON.stringify(state));fs.writeFileSync(t+'/requests','');
NODE
node "$ROOT/tests/helpers/fakeGithubApi.mjs" "$TMP/state.json" "$TMP/port" "$TMP/requests" > "$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do [[ -s "$TMP/port" ]] && break; sleep 0.05; done
[[ -s "$TMP/port" ]]
export GITHUB_API_URL="http://127.0.0.1:$(cat "$TMP/port")"
run 0 verify-and-validate --pull 5 --head "$HEAD_SHA"
node <<'NODE'
const fs=require('fs'),crypto=require('crypto'),t=process.env.BP_TMP;
const envelope=JSON.parse(fs.readFileSync(t+'/out'));
const state=JSON.parse(fs.readFileSync(t+'/state.json'));
const expected=crypto.createHash('sha256').update(JSON.stringify(state.reviews.map(r=>[String(r.id),r.state,r.commit_id,r.user.login,r.submitted_at]).sort())).digest('hex');
if(!envelope.validation.executable||envelope.verification.reviewStateHash!==expected)throw Error('envelope mismatch');
fs.copyFileSync(t+'/out',t+'/previous-envelope.json');
const posts=fs.readFileSync(t+'/requests','utf8').trim().split('\n').map(JSON.parse).filter(r=>r.method==='POST');
if(posts.length!==1||posts[0].path!=='/repos/o/r/statuses/'+process.env.HEAD_SHA||posts[0].body.state!=='success')throw Error('status mismatch');
NODE
# Dismiss the approval; a failed dispatcher must not preserve its authority.
node -e 'const fs=require("fs"),p=process.env.BP_TMP+"/state.json",s=JSON.parse(fs.readFileSync(p));s.reviews[0].state="DISMISSED";fs.writeFileSync(p,JSON.stringify(s))'
mkdir "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/bin/gh"
chmod +x "$TMP/bin/gh"
node -e 'const fs=require("fs"),yaml=require(process.env.BP_ROOT+"/node_modules/js-yaml");const w=yaml.load(fs.readFileSync(process.env.BP_ROOT+"/.github/workflows/blueprint-verify-dispatch.yml","utf8"));fs.writeFileSync(process.env.BP_TMP+"/dispatch.sh",w.jobs.dispatch.steps[0].run)'
dispatch_code=0
PATH="$TMP/bin:$PATH" BASE_REF=Working-Branch PULL_NUMBER=5 bash "$TMP/dispatch.sh" || dispatch_code=$?
[[ "$dispatch_code" -eq 1 ]]
TS_NODE_PROJECT="$ROOT/tsconfig.dev.json" node -r "$ROOT/node_modules/ts-node/register/transpile-only" <<'NODE'
const fs=require('fs'),root=process.env.BP_ROOT;
const {assertFresh}=require(root+'/src/blueprint/freshness');const {githubApi}=require(root+'/src/blueprint/githubReviews');
(async()=>{const result=await assertFresh(JSON.parse(fs.readFileSync(process.env.BP_TMP+'/previous-envelope.json')),{owner:'o',repo:'r',pullNumber:5,specPath:['docs','blueprints','example.json'].join('/'),api:githubApi('fixture-token','o','r',5)});if(result.reason!=='verification_stale')throw Error(JSON.stringify(result));})().catch(e=>{console.error(e);process.exitCode=1});
NODE
run 0 verify-and-validate --pull 5 --head "$HEAD_SHA"
node -e 'if(JSON.parse(require("fs").readFileSync(process.env.BP_TMP+"/out")).validation.executable)process.exit(1)'
node -e 'const fs=require("fs"),p=process.env.BP_TMP+"/state.json",s=JSON.parse(fs.readFileSync(p));s.reviews[0].state="APPROVED";s.reviews[0].commit_id="old";fs.writeFileSync(p,JSON.stringify(s))'
run 0 verify-and-validate --pull 5 --head "$HEAD_SHA"
node -e 'if(JSON.parse(require("fs").readFileSync(process.env.BP_TMP+"/out")).validation.executable)process.exit(1)'
# Fork decisions must work without fetching the private fork into pr/.
mv "$TMP/pr" "$TMP/pr-saved"
assert_metadata_status() {
  EXPECTED_STATE=$1 EXPECTED_DESCRIPTION=$2 node <<'NODE'
const fs=require('fs'),t=process.env.BP_TMP;
const requests=fs.readFileSync(t+'/requests','utf8').trim().split('\n').map(JSON.parse);
const last= requests.at(-1);
if(last.method!=='POST'||last.path!=='/repos/o/r/statuses/'+process.env.HEAD_SHA||last.body.state!==process.env.EXPECTED_STATE||last.body.description!==process.env.EXPECTED_DESCRIPTION)throw Error('metadata status mismatch');
const current=requests.slice(Number(fs.readFileSync(t+'/request-start','utf8')));
if(current.filter(r=>r.method==='POST').length!==1||last.body.context!=='blueprint-verify')throw Error('expected one fresh Blueprint status');
if(current.some(r=>/\/reviews$|\/contents\//.test(r.path)))throw Error('metadata path read approval/content data');
if(fs.readFileSync(t+'/out','utf8').trim())throw Error('metadata path emitted an envelope');
NODE
}
mark_requests() { node -e 'const fs=require("fs"),t=process.env.BP_TMP;fs.writeFileSync(t+"/request-start",String(fs.readFileSync(t+"/requests","utf8").trim().split("\n").length))'; }
node -e 'const fs=require("fs"),p=process.env.BP_TMP+"/state.json",s=JSON.parse(fs.readFileSync(p));s.pull.head.repo.full_name="fork/r";fs.writeFileSync(p,JSON.stringify(s))'
mark_requests
run 1 verify-and-validate --pull 5 --head "$HEAD_SHA"
assert_metadata_status failure 'blueprints from forks are not verified'
node -e 'const fs=require("fs"),p=process.env.BP_TMP+"/state.json",s=JSON.parse(fs.readFileSync(p));s.files=[];fs.writeFileSync(p,JSON.stringify(s))'
mark_requests
run 0 verify-and-validate --pull 5 --head "$HEAD_SHA"
assert_metadata_status success 'no blueprint changes'
node -e 'const fs=require("fs"),p=process.env.BP_TMP+"/state.json",s=JSON.parse(fs.readFileSync(p));s.pull.head.repo.full_name="o/r";fs.writeFileSync(p,JSON.stringify(s))'
mark_requests
run 0 verify-and-validate --pull 5 --head "$HEAD_SHA"
assert_metadata_status success 'no blueprint changes'
# A head change before either metadata-only status must publish nothing.
for has_blueprint in yes no; do
  HAS_BLUEPRINT="$has_blueprint" node <<'NODE'
const fs=require('fs'),t=process.env.BP_TMP,s=JSON.parse(fs.readFileSync(t+'/state.json'));
const requests=fs.readFileSync(t+'/requests','utf8').trim().split('\n').map(JSON.parse);
s.pull.head.repo.full_name='fork/r';
s.files=process.env.HAS_BLUEPRINT==='yes'?[{filename:['docs','blueprints','example.json'].join('/'),status:'added'}]:[];
s.moveAfterPullReads=requests.filter(r=>r.method==='GET'&&r.path==='/repos/o/r/pulls/5').length+1;
fs.writeFileSync(t+'/state.json',JSON.stringify(s));
NODE
  mark_requests
  run 1 verify-and-validate --pull 5 --head "$HEAD_SHA"
  node <<'NODE'
const fs=require('fs'),t=process.env.BP_TMP;
const requests=fs.readFileSync(t+'/requests','utf8').trim().split('\n').map(JSON.parse).slice(Number(fs.readFileSync(t+'/request-start','utf8')));
if(requests.some(r=>r.method==='POST')||fs.readFileSync(t+'/out','utf8').trim())throw Error('moving head published stale result');
if(requests.filter(r=>r.path==='/repos/o/r/pulls/5').length!==2||!fs.readFileSync(t+'/err','utf8').includes('head moved:'))throw Error('did not reach final head guard');
NODE
done
# Same-repository Blueprint data still requires the matching local checkout.
node -e 'const fs=require("fs"),p=process.env.BP_TMP+"/state.json",s=JSON.parse(fs.readFileSync(p));delete s.moveAfterPullReads;s.pull.head.repo.full_name="o/r";s.files=[{filename:["docs","blueprints","example.json"].join("/"),status:"added"}];fs.writeFileSync(p,JSON.stringify(s))'
mark_requests
run 1 verify-and-validate --pull 5 --head "$HEAD_SHA"
mv "$TMP/pr-saved" "$TMP/pr"
OTHER_SHA=$(printf 'a%.0s' {1..40})
OTHER_SHA="$OTHER_SHA" node -e 'const fs=require("fs"),p=process.env.BP_TMP+"/state.json",s=JSON.parse(fs.readFileSync(p));s.pull.head.sha=process.env.OTHER_SHA;fs.writeFileSync(p,JSON.stringify(s))'
run 1 verify-and-validate --pull 5 --head "$OTHER_SHA"
node <<'NODE'
const fs=require('fs'),t=process.env.BP_TMP;
const requests=fs.readFileSync(t+'/requests','utf8').trim().split('\n').map(JSON.parse).slice(Number(fs.readFileSync(t+'/request-start','utf8')));
if(requests.some(r=>r.method==='POST')||fs.readFileSync(t+'/out','utf8').trim())throw Error('invalid checkout published a status');
NODE
node -e 'const fs=require("fs"),p=process.env.BP_TMP+"/state.json",s=JSON.parse(fs.readFileSync(p));s.unavailable=true;fs.writeFileSync(p,JSON.stringify(s))'
run 1 verify-and-validate --pull 5 --head "$HEAD_SHA"
printf 'blueprint-cli.test.sh: all scenarios passed\n'
