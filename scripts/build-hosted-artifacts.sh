#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PUBLIC_DIR="${REPO_ROOT}/public"
DOCS_DIR="${REPO_ROOT}/docs"
TARGET_DIR="${1:-${REPO_ROOT}/dist/hosted}"
PUBLIC_OFFLINE_PACKAGE="${PUBLIC_DIR}/downloads/suitecentral-offline-package.zip"
API_BASE_DEFAULT="https://api.kstratmdconsulting.com"
API_BASE="${API_BASE:-$API_BASE_DEFAULT}"
API_BASE_CSP="${API_BASE%/}"
if [ -z "$API_BASE_CSP" ]; then
  API_BASE_CSP="$API_BASE_DEFAULT"
fi

copy_dir_contents() {
  local src="$1"
  local dest="$2"
  if [ ! -d "$src" ]; then
    echo "ERROR: Missing directory: $src"
    exit 1
  fi
  mkdir -p "$dest"
  cp -R "${src}/." "$dest/"
}

# --- Rebuild the Brain1 wiki before the copy step so the hosted output
# --- is always a fresh render of the source vault. This is the spec §6
# --- requirement — the hosted path MUST NOT ship whatever stale content
# --- happens to be sitting in public/wiki/.
BRAIN1_QUARTZ_DEFAULT="${SCRIPT_DIR}/../../Brain1-quartz"
BRAIN1_QUARTZ="${BRAIN1_QUARTZ_PATH:-$BRAIN1_QUARTZ_DEFAULT}"

rebuild_wiki() {
  if [ ! -f "${BRAIN1_QUARTZ}/package.json" ]; then
    echo "[hosted:build] ERROR: Brain1-quartz not found at ${BRAIN1_QUARTZ}" >&2
    echo "[hosted:build] Set BRAIN1_QUARTZ_PATH or check out the Brain1-quartz repo beside Preston-Test." >&2
    echo "[hosted:build] In CI, add an actions/checkout step for KStratMD/Brain1-quartz" >&2
    echo "[hosted:build] before hosted:build runs. The hosted build path refuses to proceed with" >&2
    echo "[hosted:build] a stale public/wiki/ per spec §6." >&2
    exit 1
  fi
  if [ -z "${NOTEBOOKLM_PUBLIC_URL:-}" ]; then
    echo "[hosted:build] ERROR: NOTEBOOKLM_PUBLIC_URL must be set before rebuilding the wiki." >&2
    echo "[hosted:build] See docs/archive/superseded/2026-04/superpowers/specs/2026-04-15-brain1-wiki-search-and-ai-queryable-design.md §5.1 (archived) for the single-source-of-truth contract." >&2
    exit 1
  fi
  echo "[hosted:build] rebuilding wiki at ${BRAIN1_QUARTZ}"
  (cd "${BRAIN1_QUARTZ}" && npm install --no-audit --no-fund --prefer-offline)
  # Refuse to substitute against a dirty Brain1-quartz content tree.
  # The substitution is in-place; if content/**.md has uncommitted
  # token edits, the substitution would overwrite the author's
  # original token literals and `git stash` afterwards would only
  # preserve the substituted dates (data loss). In CI this is always
  # clean (fresh checkout); locally, the author must commit or stash
  # content/ changes before invoking npm run hosted:build.
  #
  # Fail-closed: capture status output AND exit code explicitly (no
  # 2>/dev/null swallowing, no piped grep that could close the pipe
  # early under pipefail). If git itself errors (BRAIN1_QUARTZ_PATH
  # isn't a git checkout, etc.), bail rather than silently proceeding.
  # `--ignored` ALSO surfaces ignored files (e.g., gitignored draft
  # .md files under content/). substitute-verification-tokens.mjs
  # walks every .md on disk regardless of tracking, so an ignored
  # draft with token literals would be overwritten with no git copy
  # to restore — Copilot PR #806 R15.
  if ! brain1_status=$(cd "${BRAIN1_QUARTZ}" && git status --porcelain --ignored -- content/); then
    echo "[hosted:build] ERROR: 'git status' failed in ${BRAIN1_QUARTZ}" >&2
    echo "[hosted:build] (not a git checkout, or git error). Refusing to mutate content/" >&2
    echo "[hosted:build] without a verified-clean tree state." >&2
    exit 1
  fi
  if [ -n "$brain1_status" ]; then
    echo "[hosted:build] ERROR: Brain1-quartz content/ has uncommitted, untracked, or ignored entries." >&2
    echo "[hosted:build] Refusing to substitute verification-date tokens in place — that" >&2
    echo "[hosted:build] would overwrite token literals in tracked-modified files AND in" >&2
    echo "[hosted:build] untracked or ignored .md files (no git copy to restore from)." >&2
    echo "[hosted:build] Recovery options (pick whichever fits):" >&2
    echo "[hosted:build]   - tracked-modified (' M' lines): commit, or 'git stash'" >&2
    echo "[hosted:build]   - untracked        ('??' lines): commit, 'git stash -u', or move/remove" >&2
    echo "[hosted:build]   - ignored          ('!!' lines): move or remove" >&2
    echo "[hosted:build] in ${BRAIN1_QUARTZ}, then re-run." >&2
    echo "$brain1_status" | sed 's|^|  |' >&2
    exit 1
  fi
  # Set up a restore-on-exit trap BEFORE substituting. Without the trap,
  # `set -e` would exit the script on any failure in npm run build:full
  # or rsync, leaving Brain1-quartz/content/ dirty with rendered dates
  # (Copilot PR #806 R17). The trap fires on success OR failure, so the
  # restore is guaranteed. `git checkout` on an already-clean tree is a
  # no-op, so re-firing in the happy path is harmless.
  # Note: trap survives until script exit (global). Other rebuild_wiki
  # invocations are not expected; if added later, consider scoping with
  # `trap - EXIT` after the work block.
  # Trap restore: if the original exit was success (0) but the restore
  # itself fails, promote to exit 1 so the operator sees a non-zero
  # status that matches the dirty-tree reality (Copilot PR #806 R19).
  # If the original exit was already non-zero, preserve that status.
  trap '_brain1_orig=$?; if ! (cd "${BRAIN1_QUARTZ}" && git checkout -- content/) >/dev/null 2>&1; then echo "[hosted:build] WARNING: failed to restore ${BRAIN1_QUARTZ}/content to clean state" >&2; echo "[hosted:build] Manual recovery: git -C \"${BRAIN1_QUARTZ}\" checkout -- content/" >&2; if [ "$_brain1_orig" -eq 0 ]; then _brain1_orig=1; fi; fi; exit "$_brain1_orig"' EXIT
  # Substitute {{lastVerified*}} tokens in Brain1-quartz content using
  # Preston-Test's .baseline-drift.json:current.asOfDate as the single
  # source of truth. Runs in-place against the (now-clean) Brain1-quartz
  # working tree before Quartz builds.
  echo "[hosted:build] substituting verification-date tokens in ${BRAIN1_QUARTZ}/content"
  node "${REPO_ROOT}/scripts/substitute-verification-tokens.mjs" \
    --dir "${BRAIN1_QUARTZ}/content" \
    --baseline "${REPO_ROOT}/.baseline-drift.json"
  (cd "${BRAIN1_QUARTZ}" && NOTEBOOKLM_PUBLIC_URL="${NOTEBOOKLM_PUBLIC_URL}" npm run build:full)
  mkdir -p "${PUBLIC_DIR}/wiki"
  rsync -a --delete "${BRAIN1_QUARTZ}/public/" "${PUBLIC_DIR}/wiki/"
  # Restore happens via the EXIT trap above — covers both the
  # happy path and any failure in build:full / rsync.
}

rebuild_wiki

copy_file() {
  local src="$1"
  local dest="$2"
  if [ ! -f "$src" ]; then
    echo "ERROR: Missing file: $src"
    exit 1
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

ensure_hosted_offline_package() {
  local dest="${TARGET_DIR}/downloads/suitecentral-offline-package.zip"

  if [ -f "${PUBLIC_OFFLINE_PACKAGE}" ]; then
    copy_file "${PUBLIC_OFFLINE_PACKAGE}" "${dest}"
    return
  fi

  echo "Hosted offline package not found at ${PUBLIC_OFFLINE_PACKAGE}; skipping download artifact copy."
}

append_wiki_pretty_url_redirects() {
  local redirects_file="$1"
  local wiki_root="${TARGET_DIR}/wiki"

  if [ ! -d "$wiki_root" ]; then
    return
  fi

  local html
  while IFS= read -r -d '' html; do
    local rel="${html#${TARGET_DIR}/}"
    local rel_without_html="${rel%.html}"
    local pretty_route="/${rel_without_html}"
    printf '%s /%s 200\n' "$pretty_route" "$rel" >> "$redirects_file"

    if [[ "$rel" == */index.html ]]; then
      local dir_route="/${rel%/index.html}"
      printf '%s /%s 200\n' "$dir_route" "$rel" >> "$redirects_file"
    fi
  done < <(find "$wiki_root" -type f -name '*.html' -print0 | sort -z)
}

echo "Preparing hosted artifact directory: ${TARGET_DIR}"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

ensure_hosted_offline_package

copy_dir_contents "${PUBLIC_DIR}/Squire-Executive-Package-v2" "${TARGET_DIR}/Squire-Executive-Package-v2"
copy_dir_contents "${PUBLIC_DIR}/squire-v2-media-demo" "${TARGET_DIR}/squire-v2-media-demo"
copy_dir_contents "${PUBLIC_DIR}/wiki" "${TARGET_DIR}/wiki"
copy_dir_contents "${PUBLIC_DIR}/executive" "${TARGET_DIR}/executive"
copy_dir_contents "${PUBLIC_DIR}/media/demos" "${TARGET_DIR}/media/demos"
copy_dir_contents "${PUBLIC_DIR}/js" "${TARGET_DIR}/js"
# Mark THIS artifact as the hosted static demo (NOT keyed on hostname — a real
# deployed Express app must keep "/"→home and its live dashboards). The shell JS
# reads window.__IH_HOSTED__; stamp it only into the hosted copy of that file.
ih_shell_js="${TARGET_DIR}/js/integration-hub-shell.js"
if [ -f "${ih_shell_js}" ]; then
  printf 'window.__IH_HOSTED__=true;\n%s' "$(cat "${ih_shell_js}")" > "${ih_shell_js}.tmp"
  mv "${ih_shell_js}.tmp" "${ih_shell_js}"
  echo "[hosted:build] stamped window.__IH_HOSTED__ into js/integration-hub-shell.js"
else
  echo "[hosted:build] ERROR: ${ih_shell_js} missing after copy" >&2
  exit 1
fi
copy_dir_contents "${PUBLIC_DIR}/css" "${TARGET_DIR}/css"
copy_dir_contents "${PUBLIC_DIR}/data" "${TARGET_DIR}/data"
copy_dir_contents "${PUBLIC_DIR}/components" "${TARGET_DIR}/components"
copy_dir_contents "${PUBLIC_DIR}/universal" "${TARGET_DIR}/universal"
copy_dir_contents "${PUBLIC_DIR}/vendor" "${TARGET_DIR}/vendor"
copy_dir_contents "${PUBLIC_DIR}/webfonts" "${TARGET_DIR}/webfonts"
copy_file "${PUBLIC_DIR}/vendor-tailwind.css" "${TARGET_DIR}/vendor-tailwind.css"
copy_file "${PUBLIC_DIR}/help-chat-widget.html" "${TARGET_DIR}/help-chat-widget.html"
copy_file "${PUBLIC_DIR}/compliance-dashboard.html" "${TARGET_DIR}/compliance-dashboard.html"
copy_file "${PUBLIC_DIR}/code-architecture-dashboard.html" "${TARGET_DIR}/code-architecture-dashboard.html"
copy_file "${PUBLIC_DIR}/suitecentral-deployment-options-dashboard.html" "${TARGET_DIR}/suitecentral-deployment-options-dashboard.html"
copy_file "${PUBLIC_DIR}/ai-field-mapping-editor.html" "${TARGET_DIR}/ai-field-mapping-editor.html"
copy_file "${PUBLIC_DIR}/ai-configuration-dashboard.html" "${TARGET_DIR}/ai-configuration-dashboard.html"
copy_file "${PUBLIC_DIR}/connector-ecosystem.html" "${TARGET_DIR}/connector-ecosystem.html"
copy_file "${PUBLIC_DIR}/ai-usage-dashboard.html" "${TARGET_DIR}/ai-usage-dashboard.html"
copy_file "${PUBLIC_DIR}/roi-calculator.html" "${TARGET_DIR}/roi-calculator.html"
copy_file "${PUBLIC_DIR}/integration-wizard-5step.html" "${TARGET_DIR}/integration-wizard-5step.html"
copy_file "${PUBLIC_DIR}/mdm-central.html" "${TARGET_DIR}/mdm-central.html"
copy_file "${PUBLIC_DIR}/admin-templates.html" "${TARGET_DIR}/admin-templates.html"
copy_file "${PUBLIC_DIR}/Integration-Command-Center.html" "${TARGET_DIR}/Integration-Command-Center.html"
# Integration Hub shell injects a Review top-tab → /review-hub.html on the hosted
# dashboards above. Ship the hub as an EVIDENCE-ONLY surface: review-hub.html hides
# its "Live Dashboards" section on hosted (those need the running backend), so we
# ship only the static-friendly pages it links to — the Portfolio evidence page +
# its data — plus the docs/review evidence tree (copied below). The live operational
# dashboards (system-status / metrics-viewer / cost-transparency) are deliberately
# NOT shipped. check-integration-hub-shell.mjs asserts this set fail-closed.
copy_file "${PUBLIC_DIR}/review-hub.html" "${TARGET_DIR}/review-hub.html"
copy_file "${PUBLIC_DIR}/squire-portfolio-evidence.html" "${TARGET_DIR}/squire-portfolio-evidence.html"
copy_file "${PUBLIC_DIR}/portfolio-evidence.json" "${TARGET_DIR}/portfolio-evidence.json"
copy_file "${PUBLIC_DIR}/ai-config-manager.js" "${TARGET_DIR}/ai-config-manager.js"
copy_file "${PUBLIC_DIR}/enhanced-back-navigation.js" "${TARGET_DIR}/enhanced-back-navigation.js"
copy_file "${PUBLIC_DIR}/universal-navigation.js" "${TARGET_DIR}/universal-navigation.js"
# Legacy filename expected by ai-usage-dashboard.html.
copy_file "${PUBLIC_DIR}/vendor/chart.umd.min.js" "${TARGET_DIR}/vendor/chart.js"
copy_file "${REPO_ROOT}/SQUIRE_BUSINESS_CASE.md" "${TARGET_DIR}/SQUIRE_BUSINESS_CASE.md"

# Preserve the docs links referenced by hosted pages. The whole docs/review tree
# (~368K of reviewer evidence: proof-cards, benchmark, crosswalk, route-tenant
# coverage, squire-product-cards) backs the hosted review-hub.html tiles.
copy_dir_contents "${DOCS_DIR}/review" "${TARGET_DIR}/docs/review"
copy_dir_contents "${DOCS_DIR}/suiteapp" "${TARGET_DIR}/docs/suiteapp"
copy_dir_contents "${DOCS_DIR}/research" "${TARGET_DIR}/docs/research"
copy_dir_contents "${DOCS_DIR}/deliverables" "${TARGET_DIR}/docs/deliverables"
copy_file "${DOCS_DIR}/01_VISION_DOCUMENT.md" "${TARGET_DIR}/docs/01_VISION_DOCUMENT.md"
copy_file "${DOCS_DIR}/INDEX.md" "${TARGET_DIR}/docs/INDEX.md"
copy_file "${DOCS_DIR}/api/API-DOCUMENTATION.md" "${TARGET_DIR}/docs/api/API-DOCUMENTATION.md"
copy_file "${DOCS_DIR}/architecture/ARCHITECTURE.md" "${TARGET_DIR}/docs/architecture/ARCHITECTURE.md"
copy_file "${DOCS_DIR}/architecture/suitecentral-code-architecture-infographic.png" "${TARGET_DIR}/docs/architecture/suitecentral-code-architecture-infographic.png"
copy_file "${DOCS_DIR}/architecture/suitecentral-deployment-options-infographic.png" "${TARGET_DIR}/docs/architecture/suitecentral-deployment-options-infographic.png"
copy_file "${DOCS_DIR}/operations/DEPLOYMENT-GUIDE.md" "${TARGET_DIR}/docs/operations/DEPLOYMENT-GUIDE.md"
copy_file "${DOCS_DIR}/deployment/SQUIRE-NETSUITE-MCP-SETUP-GUIDE.md" "${TARGET_DIR}/docs/deployment/SQUIRE-NETSUITE-MCP-SETUP-GUIDE.md"
copy_file "${DOCS_DIR}/strategic/executive-overview.md" "${TARGET_DIR}/docs/strategic/executive-overview.md"
copy_file "${DOCS_DIR}/strategic/SUITECENTRAL_2_DEPLOYMENT_OPTIONS.md" "${TARGET_DIR}/docs/strategic/SUITECENTRAL_2_DEPLOYMENT_OPTIONS.md"
copy_file "${DOCS_DIR}/squire/squire-suitecentral-mindmap.html" "${TARGET_DIR}/docs/squire/squire-suitecentral-mindmap.html"

cat > "${TARGET_DIR}/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuiteCentral 2.0 - Squire Presentation Entry</title>
  <meta name="description" content="Hosted presentation entry for SuiteCentral 2.0 AI integration governance.">
  <meta http-equiv="refresh" content="1; url=/Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html">
  <link rel="canonical" href="/Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
</head>
<body class="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
  <main class="mx-auto flex min-h-screen max-w-4xl items-center px-6 py-10">
    <section class="w-full rounded-2xl border border-slate-700 bg-slate-900/85 p-8 shadow-2xl shadow-black/30">
      <p class="inline-flex items-center gap-2 rounded-full bg-cyan-500/15 px-3 py-1 text-xs font-semibold text-cyan-300">
        <i class="fas fa-signs-post"></i>
        Recommended Presentation Entry
      </p>
      <h1 class="mt-4 text-3xl font-bold tracking-tight text-white">SuiteCentral 2.0</h1>
      <p class="mt-1 text-lg text-slate-300">Squire presentation entry</p>
      <p class="mt-4 text-sm leading-relaxed text-slate-400">
        Redirecting to the curated Start Here review path for a controlled executive presentation flow.
      </p>
      <div class="mt-6 flex flex-wrap gap-3">
        <a
          href="/Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html"
          class="inline-flex items-center gap-2 rounded-lg border border-cyan-300 bg-cyan-500/15 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/25"
        >
          <i class="fas fa-arrow-right"></i>
          Open Start Here
        </a>
        <a
          href="/Squire-Executive-Package-v2/19-DECISION-PATH-STANDALONE.html"
          class="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/25"
        >
          <i class="fas fa-route"></i>
          Open Decision Path
        </a>
        <a
          href="/squire-v2-media-demo/"
          class="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-500/15 px-4 py-2 text-sm font-semibold text-violet-200 hover:bg-violet-500/25"
        >
          <i class="fas fa-compass"></i>
          Open Demo Hub
        </a>
      </div>
    </section>
  </main>
  <script>
    setTimeout(() => {
      window.location.replace('/Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html');
    }, 700);
  </script>
</body>
</html>
HTML

cat > "${TARGET_DIR}/_redirects" <<'EOF'
/ /Squire-Executive-Package-v2/15-START-HERE-ASYNC-STANDALONE.html 302
EOF

# Offline-package redirect. The zip is ~48 MiB (over CF Pages' 25 MiB per-file
# deploy limit), so it's hosted on OneDrive via
# scripts/upload-offline-package-to-onedrive.mjs. That script writes the share
# URL to $GITHUB_ENV (or a local shell export) as OFFLINE_PACKAGE_SHARE_URL,
# and we emit a 302 here so every link at /wiki/downloads/... still resolves.
if [ -n "${OFFLINE_PACKAGE_SHARE_URL:-}" ]; then
  printf '/wiki/downloads/suitecentral-offline-package.zip %s 302\n' "${OFFLINE_PACKAGE_SHARE_URL}" \
    >> "${TARGET_DIR}/_redirects"
  # Back-compat for the legacy path used by the video demo and README docs.
  printf '/downloads/suitecentral-offline-package.zip %s 302\n' "${OFFLINE_PACKAGE_SHARE_URL}" \
    >> "${TARGET_DIR}/_redirects"
  echo "[hosted:build] wired offline-package 302 → ${OFFLINE_PACKAGE_SHARE_URL}"
else
  echo "[hosted:build] OFFLINE_PACKAGE_SHARE_URL not set; /wiki/downloads/suitecentral-offline-package.zip will 404 on the deploy."
fi

# NOTE: Do NOT call append_wiki_pretty_url_redirects here.
# Cloudflare Pages' built-in Pretty URLs feature natively serves
# foo.html when the browser requests foo (extensionless). Adding
# _redirects 200-rewrites on top creates an infinite redirect loop
# (CF strips .html via 308, _redirects rewrites back to .html, repeat).
# The mini package has its own file-mode resolution in
# package-squire-exec-v2-mini.ts; local dev uses Express middleware.

cat > "${TARGET_DIR}/robots.txt" <<'EOF'
User-agent: *
Disallow: /
EOF

cat > "${TARGET_DIR}/_headers" <<EOF
/*
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com data:; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' ${API_BASE_CSP} https://cloudflareinsights.com; upgrade-insecure-requests

/*.html
  Cache-Control: no-cache, no-store, must-revalidate

/index.html
  Cache-Control: no-cache, no-store, must-revalidate

/js/*
  Cache-Control: no-cache

/*.css
  Cache-Control: no-cache

/media/demos/*
  Cache-Control: public, max-age=604800

/wiki/*.md
  Content-Type: text/markdown; charset=utf-8

/wiki/llms.txt
  Content-Type: text/plain; charset=utf-8

/wiki/llms-full.txt
  Content-Type: text/plain; charset=utf-8

/wiki/brain1-wiki.zip
  Content-Type: application/zip

/wiki/downloads/*.pdf
  Content-Type: application/pdf
EOF

API_BASE="$API_BASE" bash "${SCRIPT_DIR}/rewrite-api-urls.sh" "${TARGET_DIR}"

echo "Hosted artifact build complete."
