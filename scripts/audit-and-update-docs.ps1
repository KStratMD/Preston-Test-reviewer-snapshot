# Comprehensive Documentation Audit and Update Script
# Audits current codebase state and updates live documentation accordingly.

param(
    [switch]$NoTestRun,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Convert-Count {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $digits = $Value -replace '[^\d]', ''
    if ([string]::IsNullOrWhiteSpace($digits)) { return $null }
    return [int]$digits
}

function Format-Count {
    param([int]$Value)
    return ('{0:N0}' -f $Value)
}

function Parse-TestOutput {
    param([string]$Output)

    if ([string]::IsNullOrWhiteSpace($Output)) { return $null }

    # Strip ANSI escape codes — Jest embeds color sequences when
    # captured via cmd.exe /c even without a tty, and the invisible
    # \x1b[32m...\x1b[39m bytes between tokens break the regexes.
    # This was the root cause of the E2E and integration parse
    # failures in the April 2026 Phase 2 run.
    $Output = $Output -replace '\x1b\[[0-9;]*m', ''
    $Output = $Output -replace '\e\[[0-9;]*m', ''

    $result = [ordered]@{
        TestSuitesPassed = $null
        TestSuitesTotal  = $null
        TestsPassed      = $null
        TestsSkipped     = 0
        TestsTotal       = $null
        TestTimeSeconds  = $null
    }

    # Test suites — handles all Jest summary variants:
    #   "385 passed, 385 total"
    #   "1 failed, 384 passed, 385 total"
    #   "1 failed, 2 skipped, 21 passed, 22 of 24 total"
    #   "2 skipped, 22 passed, 22 of 24 total"
    # The optional groups consume "N failed, " and "N skipped, " if
    # present, and "N of " before the total if Jest prints that form.
    if ($Output -match 'Test Suites:\s*(?:[\d,]+\s+failed[,\s]+)?(?:[\d,]+\s+skipped[,\s]+)?([\d,]+)\s+passed[,\s]+(?:[\d,]+\s+of\s+)?([\d,]+)\s+total') {
        $result.TestSuitesPassed = Convert-Count $matches[1]
        $result.TestSuitesTotal = Convert-Count $matches[2]
    }

    # Tests patterns (most specific first)
    if ($Output -match 'Tests:\s*([\d,]+)\s+failed[,\s]+([\d,]+)\s+skipped[,\s]+([\d,]+)\s+passed[,\s]+([\d,]+)\s+total') {
        $result.TestsSkipped = Convert-Count $matches[2]
        $result.TestsPassed = Convert-Count $matches[3]
        $result.TestsTotal = Convert-Count $matches[4]
    } elseif ($Output -match 'Tests:\s*([\d,]+)\s+skipped[,\s]+([\d,]+)\s+passed[,\s]+([\d,]+)\s+total') {
        $result.TestsSkipped = Convert-Count $matches[1]
        $result.TestsPassed = Convert-Count $matches[2]
        $result.TestsTotal = Convert-Count $matches[3]
    } elseif ($Output -match 'Tests:\s*([\d,]+)\s+passed[,\s]+([\d,]+)\s+total') {
        $result.TestsPassed = Convert-Count $matches[1]
        $result.TestsTotal = Convert-Count $matches[2]
    }

    # Time
    if ($Output -match 'Time:\s*([\d.]+)\s*s') {
        $result.TestTimeSeconds = [math]::Round([decimal]$matches[1])
    }

    if (-not $result.TestSuitesPassed -or -not $result.TestsPassed) {
        return $null
    }

    if (-not $result.TestSuitesTotal) {
        $result.TestSuitesTotal = $result.TestSuitesPassed
    }

    if (-not $result.TestsTotal) {
        $result.TestsTotal = $result.TestsPassed + $result.TestsSkipped
    }

    return [PSCustomObject]$result
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Documentation Audit & Update System" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# STEP 1: AUDIT ACTUAL CODEBASE STATE
# ============================================================================

Write-Host "[STEP 1] Auditing Actual Codebase State..." -ForegroundColor Yellow
Write-Host ""

$currentDate = Get-Date -Format "MMMM d, yyyy"
$currentMonth = Get-Date -Format "MMMM yyyy"
Write-Host "  Current Date: $currentDate" -ForegroundColor Gray

$testOutputFile = "test-output.log"
$testOutput = ""
$maxAgeMinutes = 60
$usingCache = $false

if (Test-Path $testOutputFile) {
    $fileAge = (Get-Date) - (Get-Item $testOutputFile).LastWriteTime
    if ($fileAge.TotalMinutes -lt $maxAgeMinutes) {
        Write-Host "  Using cached test output from $testOutputFile ($('{0:N0}' -f $fileAge.TotalMinutes) min old)..." -ForegroundColor Gray
        $testOutput = Get-Content $testOutputFile -Raw
        $usingCache = $true
    } else {
        Write-Host "  Cached test output is stale ($('{0:N0}' -f $fileAge.TotalMinutes) min old)." -ForegroundColor Gray
    }
}

if (-not $usingCache -and -not $NoTestRun) {
    Write-Host "  Running npm test to refresh metrics..." -ForegroundColor Gray
    Write-Host "  (This may take 3-5 minutes...)" -ForegroundColor Gray
    try {
        $testOutput = & cmd.exe /c "npm test 2>&1"
        if ($testOutput -is [array]) {
            $testOutput = $testOutput -join "`n"
        }
        if ($testOutput) {
            $testOutput | Out-File -FilePath $testOutputFile -Encoding utf8
            Write-Host "  Saved fresh test output to $testOutputFile" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  Warning: npm test execution failed: $_" -ForegroundColor Yellow
    }
}

if (-not $usingCache -and $NoTestRun) {
    Write-Host "  NoTestRun enabled; skipping npm test execution." -ForegroundColor Gray
}

$parsed = Parse-TestOutput -Output $testOutput
if (-not $parsed) {
    Write-Host "  ERROR: Unable to parse current test metrics from test output." -ForegroundColor Red
    Write-Host "  Run: npm test > test-output.log (or run this script without -NoTestRun)" -ForegroundColor Red
    Write-Host "  Aborting to prevent stale/incorrect documentation updates." -ForegroundColor Red
    exit 1
}

$testSuitesPassed = [int]$parsed.TestSuitesPassed
$testSuitesTotal = [int]$parsed.TestSuitesTotal
$testsPassed = [int]$parsed.TestsPassed
$testsSkipped = [int]$parsed.TestsSkipped
$testsTotal = [int]$parsed.TestsTotal
$testTime = $parsed.TestTimeSeconds

# --- E2E Portal Tests ---
$e2ePassed = 0
$e2eSuites = 0
$e2eOutputFile = "e2e-test-output.log"
$e2eUsingCache = $false

if (Test-Path $e2eOutputFile) {
    $e2eFileAge = (Get-Date) - (Get-Item $e2eOutputFile).LastWriteTime
    if ($e2eFileAge.TotalMinutes -lt $maxAgeMinutes) {
        $e2eOutput = Get-Content $e2eOutputFile -Raw
        $e2eUsingCache = $true
    }
}

if (-not $e2eUsingCache -and -not $NoTestRun) {
    Write-Host "  Running E2E portal tests..." -ForegroundColor Gray
    try {
        $e2eOutput = & cmd.exe /c "npx jest --config=jest.e2e.config.cjs --forceExit 2>&1"
        if ($e2eOutput -is [array]) { $e2eOutput = $e2eOutput -join "`n" }
        if ($e2eOutput) { $e2eOutput | Out-File -FilePath $e2eOutputFile -Encoding utf8 }
    } catch {
        Write-Host "  Warning: E2E tests failed: $_" -ForegroundColor Yellow
    }
} elseif ($e2eUsingCache) {
    Write-Host "  Using cached E2E output from $e2eOutputFile ($('{0:N0}' -f $e2eFileAge.TotalMinutes) min old)..." -ForegroundColor Gray
}

$e2eParsed = Parse-TestOutput -Output $e2eOutput
if ($e2eParsed) {
    $e2ePassed = [int]$e2eParsed.TestsPassed
    $e2eSuites = [int]$e2eParsed.TestSuitesPassed
    Write-Host "  [OK] E2E Portal Tests: $e2ePassed passed, $e2eSuites suites" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Could not parse E2E test output; using 0." -ForegroundColor Yellow
}

# --- Integration Tests ---
$intPassed = 0
$intSkipped = 0
$intSuites = 0
$intOutputFile = "integration-test-output.log"
$intUsingCache = $false

if (Test-Path $intOutputFile) {
    $intFileAge = (Get-Date) - (Get-Item $intOutputFile).LastWriteTime
    if ($intFileAge.TotalMinutes -lt $maxAgeMinutes) {
        $intOutput = Get-Content $intOutputFile -Raw
        $intUsingCache = $true
    }
}

if (-not $intUsingCache -and -not $NoTestRun) {
    Write-Host "  Running integration tests..." -ForegroundColor Gray
    try {
        $intOutput = & cmd.exe /c "npx jest --config=jest.slow.config.cjs --testPathPatterns=tests/integration --forceExit 2>&1"
        if ($intOutput -is [array]) { $intOutput = $intOutput -join "`n" }
        if ($intOutput) { $intOutput | Out-File -FilePath $intOutputFile -Encoding utf8 }
    } catch {
        Write-Host "  Warning: Integration tests failed: $_" -ForegroundColor Yellow
    }
} elseif ($intUsingCache) {
    Write-Host "  Using cached integration output from $intOutputFile ($('{0:N0}' -f $intFileAge.TotalMinutes) min old)..." -ForegroundColor Gray
}

$intParsed = Parse-TestOutput -Output $intOutput
if ($intParsed) {
    $intPassed = [int]$intParsed.TestsPassed
    $intSkipped = [int]$intParsed.TestsSkipped
    $intSuites = [int]$intParsed.TestSuitesPassed
    Write-Host "  [OK] Integration Tests: $intPassed passed, $intSkipped skipped, $intSuites suites" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Could not parse integration test output; using 0." -ForegroundColor Yellow
}

# --- Grand Totals ---
$grandPassed = $testsPassed + $e2ePassed + $intPassed
$grandSkipped = $testsSkipped + $intSkipped
$grandSuites = $testSuitesPassed + $e2eSuites + $intSuites
$grandTotal = $grandPassed + $grandSkipped
Write-Host "  [OK] Grand Total: $grandPassed passed, $grandSkipped skipped, $grandTotal total, $grandSuites suites" -ForegroundColor Green

$testsExecuted = $testsTotal - $testsSkipped
if ($testsExecuted -lt 0) {
    $testsExecuted = $testsPassed
}

$executedPassRate = if ($testsExecuted -gt 0) {
    [math]::Round(($testsPassed / $testsExecuted) * 100, 2)
} else { 0 }

$executedPassRateText = if (($executedPassRate % 1) -eq 0) {
    '{0:N0}' -f $executedPassRate
} else {
    '{0:N2}' -f $executedPassRate
}

Write-Host "  [OK] Test Suites: $testSuitesPassed passed, $testSuitesTotal total" -ForegroundColor Green
Write-Host "  [OK] Tests: $testsPassed passed, $testsSkipped skipped, $testsTotal total" -ForegroundColor Green
if ($testTime) {
    Write-Host "  [OK] Test Time: ~$testTime seconds" -ForegroundColor Green
}

$coverageFile = "coverage/coverage-summary.json"
$coverageStmt = $null
$coverageBranch = $null
if (Test-Path $coverageFile) {
    $coverage = Get-Content $coverageFile | ConvertFrom-Json
    if ($coverage.total.statements.pct -ne $null) {
        $coverageStmt = [math]::Round([decimal]$coverage.total.statements.pct, 2)
    }
    if ($coverage.total.branches.pct -ne $null) {
        $coverageBranch = [math]::Round([decimal]$coverage.total.branches.pct, 2)
    }
    Write-Host "  [OK] Coverage: $coverageStmt% statements, $coverageBranch% branches" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Coverage file not found (coverage/coverage-summary.json). Coverage text will not be auto-updated." -ForegroundColor Yellow
}

$connectorFiles = Get-ChildItem -Path "src/connectors" -Filter "*Connector.ts" -ErrorAction SilentlyContinue
$connectorCount = $connectorFiles.Count
Write-Host "  [OK] Connectors: $connectorCount implemented" -ForegroundColor Green

$agentFiles = Get-ChildItem -Path "src/services/ai/orchestrator/agents" -Filter "*Agent.ts" -ErrorAction SilentlyContinue
$agentCount = $agentFiles.Count
Write-Host "  [OK] AI Agents: $agentCount implemented" -ForegroundColor Green

$packageJson = Get-Content "package.json" | ConvertFrom-Json
$version = $packageJson.version
Write-Host "  [OK] Version: $version" -ForegroundColor Green

$providerFiles = Get-ChildItem -Path "src/services/ai/providers" -Filter "*Provider.ts" -ErrorAction SilentlyContinue
if (-not $providerFiles) {
    $providerFiles = Get-ChildItem -Path "src/providers" -Filter "*Provider.ts" -ErrorAction SilentlyContinue
}
$aiProviderCount = ($providerFiles | Where-Object { $_.Name -notmatch 'test|spec|Base|Abstract|Interface' }).Count
if ($aiProviderCount -eq 0) {
    Write-Host "  [WARN] Could not infer provider count from files." -ForegroundColor Yellow
} else {
    Write-Host "  [OK] AI Provider Implementations: $aiProviderCount" -ForegroundColor Green
}

Write-Host ""

# ============================================================================
# STEP 2: BUILD CANONICAL VALUES FROM AUDIT
# ============================================================================

Write-Host "[STEP 2] Building Canonical Values..." -ForegroundColor Yellow
Write-Host ""

$testsPassedFmt = Format-Count $testsPassed
$testsSkippedFmt = Format-Count $testsSkipped
$testsTotalFmt = Format-Count $testsTotal
$testsExecutedFmt = Format-Count $testsExecuted
$testSuitesFmt = Format-Count $testSuitesPassed

# Grand total formatted values (unit + E2E + integration)
$grandPassedFmt = Format-Count $grandPassed
$grandSkippedFmt = Format-Count $grandSkipped
$grandSuitesFmt = Format-Count $grandSuites
$grandTotalFmt = Format-Count $grandTotal
$e2ePassedFmt = Format-Count $e2ePassed
$e2eSuitesFmt = Format-Count $e2eSuites
$intPassedFmt = Format-Count $intPassed
$intSkippedFmt = Format-Count $intSkipped
$intSuitesFmt = Format-Count $intSuites

$testPassRate = "$executedPassRateText% executed pass rate ($testsPassedFmt/$testsExecutedFmt executed tests passed, $testsSkippedFmt skipped)"
$testCountFull = "$testPassRate across $testSuitesFmt suites"
$testCountWithCoverage = if ($coverageStmt -ne $null) {
    "$testCountFull - $coverageStmt% coverage"
} else {
    $testCountFull
}

$standardReplacements = [ordered]@{
    # NOTE: "Last Updated" bumps are NOT in this map. They are applied
    # conditionally below — only if a file's content actually changed in this
    # run via one of the substantive replacements. Mechanical date-only bumps
    # mislead readers (the field is supposed to mean "this content was reviewed
    # on this date") and create git-blame noise. See PR #655 review for the
    # decision.

    "\b\d{4,}[\d,]*/[\d,]+ executed tests passed" = "$testsPassedFmt/$testsExecutedFmt executed tests passed"
    "\b\d{4,}[\d,]*/[\d,]+ tests passing" = "$testsPassedFmt/$testsExecutedFmt tests passing"
    "\b\d{4,}[\d,]*/[\d,]+ tests passed" = "$testsPassedFmt/$testsTotalFmt tests passed"
    "\b\d{4,}[\d,]* total tests" = "$testsTotalFmt total tests"
    "\b\d{4,}[\d,]* passing tests" = "$testsPassedFmt passing tests"
    "\b\d{4,}[\d,]* tests passing" = "$testsPassedFmt tests passing"
    "\b\d{4,}[\d,]* passed, [\d,]+ skipped" = "$testsPassedFmt passed, $testsSkippedFmt skipped"
    # A ratio ("N / N test suites") means the GRAND total; a bare count means
    # the unit profile. Handle the ratio first — this map is [ordered] — and
    # then guard the bare rule with a lookbehind so it cannot match the RIGHT
    # side of a ratio.
    #
    # The lookbehind is what actually fixes this, not the ordering: each rule
    # runs over the whole file, so an unguarded bare rule re-corrupts the ratio
    # the previous rule just fixed, turning "627 / 627 test suites passed" into
    # "627 / 566 test suites passed". That is a mixed baseline which reconciles
    # to nothing and which a count sweep cannot see, because both halves look
    # like current numbers. Copilot caught exactly this on PR #1015.
    "[\d,]+[ \t]{1,3}/[ \t]{1,3}[\d,]+ test suites" = "$grandSuitesFmt / $grandSuitesFmt test suites"
    "[\d,]+/[\d,]+ test suites" = "$grandSuitesFmt/$grandSuitesFmt test suites"
    "(?<![\d,][ \t]*/[ \t]*)\b\d{2,4} test suites\b" = "$testSuitesFmt test suites"
    "\b\d{2,4}/\d{2,4} suites\b" = "$testSuitesFmt/$testSuitesFmt suites"

    # CLAUDE.md test table rows (unit, E2E, integration, total)
    "\| Unit \| ``npm test`` \| [\d,]+ passing \([\d,]+ skipped\), [\d,]+ suites \|" = "| Unit | ``npm test`` | $testsPassedFmt passing ($testsSkippedFmt skipped), $testSuitesFmt suites |"
    "\| E2E Portals \| ``npm run test:e2e:portals`` \| [\d,]+ passing, [\d,]+ suites \|" = "| E2E Portals | ``npm run test:e2e:portals`` | $e2ePassedFmt passing, $e2eSuitesFmt suites |"
    "\| Integration \| ``npm run test:integration`` \| [\d,]+ passing \([\d,]+ skipped\), [\d,]+ suites \|" = "| Integration | ``npm run test:integration`` | $intPassedFmt passing ($intSkippedFmt skipped), $intSuitesFmt suites |"
    "\| \*\*Total\*\* \| - \| \*\*[\d,]+ passing\*\* \([\d,]+ suites\) \|" = "| **Total** | - | **$grandPassedFmt passing** ($grandSuitesFmt suites) |"

    # Executive package / vision doc grand total patterns
    "[\d,]+\s*/\s*[\d,]+ tests passed validate" = "$grandPassedFmt / $grandTotalFmt tests passed validate"
    "[\d,]+\s*/\s*[\d,]+ total passed" = "$grandPassedFmt / $grandTotalFmt total passed"
    "\| Tests Passing \| [\d,]+ / [\d,]+ \|" = "| Tests Passing | $grandPassedFmt / $grandTotalFmt |"
    "\| Test Suites \| [\d,]+ \|" = "| Test Suites | $grandSuitesFmt |"

    # Executive package suite patterns (grand total suites)
    "[\d,]+ / [\d,]+ suites passed" = "$grandSuitesFmt / $grandSuitesFmt suites passed"
    "[\d,]+ / [\d,]+ suites\b" = "$grandSuitesFmt / $grandSuitesFmt suites"
    "\(\d{3,}[\d,]* suites\)" = "($grandSuitesFmt suites)"
    "across \d{3,}[\d,]* suites" = "across $grandSuitesFmt suites"

    # Executive package "X tests, 100% pass rate" short form
    "\b\d{4,}[\d,]* tests, 100% pass rate" = "$grandPassedFmt tests, 100% pass rate"

    # HTML fallback text patterns (executive hub, media demo, etc.)
    "Executed Tests \([\d,]+ passed, [\d,]+ skipped\)" = "Executed Tests ($grandPassedFmt passed, $grandSkippedFmt skipped)"
    "[\d,]+ passing tests \([\d,]+ total including [\d,]+ skipped\)" = "$grandPassedFmt passing tests ($grandTotalFmt total including $grandSkippedFmt skipped)"

    # Grand-total skipped count (only when adjacent to grand total numbers like 9,207/9,237)
    "\b\d{4,}[\d,]* of \d{4,}[\d,]* tests passed with [\d,]+ intentionally skipped" = "$grandPassedFmt of $grandTotalFmt tests passed with $grandSkippedFmt intentionally skipped"
    "\b\d{4,}[\d,]*/[\d,]+ tests passed \([\d,]+ skipped\)" = "$grandPassedFmt/$grandTotalFmt tests passed ($grandSkippedFmt skipped)"
    "\*\*[\d,]+ intentionally skipped\*\*" = "**$grandSkippedFmt intentionally skipped**"
    # A trailing ", N skipped" / "(N skipped)" after the grand ratio carries
    # none of the numbers the ratio rules sweep, so it survived every
    # re-baseline while the ratio around it moved (Copilot, PR #1015 R2: eleven
    # docs reading "12,762 / 12,788 tests passed, 16 skipped" — a 26 gap).
    # Anchoring the pattern on the freshly-written grand numbers means it can
    # only ever touch the skip count that belongs to them, and running AFTER
    # the ratio rules in this [ordered] map means those numbers exist by the
    # time it fires.
    "($grandPassedFmt\s*/\s*$grandTotalFmt tests pass(?:ed|ing)(?:, | \())[\d,]+ skipped" = "`${1}$grandSkippedFmt skipped"
    "($grandPassedFmt\s*/\s*$grandTotalFmt tests pass(?:ed|ing) with )[\d,]+ intentionally skipped" = "`${1}$grandSkippedFmt intentionally skipped"

    # Duplicated "across X suites" phrases from prior audit runs
    "across \d{3,}[\d,]* suites across \d{3,}[\d,]* test suites" = "across $grandSuitesFmt test suites"

    # "N total across M suites" — N is the grand TOTAL (incl. skipped), not the
    # passed count. Writing $grandPassedFmt here corrupted "12,760 total" to
    # "12,734 total" in a "passed / total" parenthetical (Copilot R1 + Codex on
    # PR #1035); the only live match phrases it as "<passed> passed / <total>
    # total across <suites> suites".
    "[\d,]+ total across [\d,]+ suites" = "$grandTotalFmt total across $grandSuitesFmt suites"

    # Canonical metrics breakdown
    "[\d,]+ unit \([\d,]+ skipped\), [\d,]+ integration \([\d,]+ skipped\), [\d,]+ E2E" = "$testsPassedFmt unit ($testsSkippedFmt skipped), $intPassedFmt integration ($intSkippedFmt skipped), $e2ePassedFmt E2E"

    # AI provider name lists (catch all common variants)
    "OpenAI/Claude/LMStudio" = "OpenAI/Claude/OpenRouter/LMStudio"
    "OpenAI, Claude, LMStudio" = "OpenAI, Claude, OpenRouter, LMStudio"
    "\d+ operational \(OpenAI, Claude, LMStudio\)" = "4 operational (OpenAI, Claude, OpenRouter, LMStudio)"
    "\d+ operational \(OpenAI, Claude, OpenRouter, LMStudio\)" = "4 operational (OpenAI, Claude, OpenRouter, LMStudio)"
    "\d+ production-ready providers" = "4 production-ready providers"
    "\d+ production-ready AI providers" = "4 production-ready AI providers"
    "\d+ production-ready \(OpenAI" = "4 production-ready (OpenAI"
    "\d+ real AI providers" = "4 real AI providers"
    "\d+ real LLM providers" = "4 real LLM providers"
    "\d+ production AI [Pp]roviders" = "4 production AI providers"
    "\d+ verified AI providers" = "4 verified AI providers"

    "\b12 SuiteCentral Modules\b" = "Core SuiteCentral Modules"
    "\b[Oo]ur twelve vertical modules\b" = "our core module set"

    "^version \d+\.\d+\.\d+$" = "version $version"
    "^Version: \d+\.\d+\.\d+$" = "Version: $version"
}

Write-Host "  [OK] Canonical test message: $testCountFull" -ForegroundColor Gray
if ($coverageStmt -ne $null) {
    Write-Host "  [OK] With coverage: $testCountWithCoverage" -ForegroundColor Gray
}
Write-Host "  [OK] Current date: $currentDate" -ForegroundColor Gray
Write-Host "  [OK] Version: $version" -ForegroundColor Gray
Write-Host ""

# ============================================================================
# STEP 3: APPLY UPDATES TO LIVE DOCUMENTATION
# ============================================================================

Write-Host "[STEP 3] Updating Documentation Files..." -ForegroundColor Yellow
Write-Host ""

$filesUpdated = 0
$changesApplied = @()

# Files the drift gate never scans must not be swept either. The category-(b)
# entries in .baseline-drift.json:excludePaths include rebuilt wiki HTML whose
# vintage markers Quartz strips at render (HTML comments don't survive into
# the .html), so those files CANNOT be fenced — sweeping them rewrites frozen
# COUPLED baselines (third strike, 2026-07-18: 379/379, 404/404, 392/392 all
# became the current unit count again). Symmetry contract: this sweep skips
# exactly what scripts/check-baseline-drift.mjs excludes (same prefix-match
# semantics as its isExcluded()), so nothing the sweep would update is ever
# outside the gate's view, and nothing outside the gate's view is swept.
# FAIL CLOSED (Codex review on #1035): a missing or malformed
# .baseline-drift.json means the sweep cannot know what is frozen — proceeding
# without exclusions is exactly the corruption this guard exists to prevent,
# so abort instead of scanning unprotected.
if (-not (Test-Path ".baseline-drift.json")) {
    Write-Host "  [ERROR] .baseline-drift.json not found - cannot determine frozen paths; refusing to sweep." -ForegroundColor Red
    exit 1
}
$driftExcludePrefixes = @()
try {
    $driftConfig = Get-Content ".baseline-drift.json" -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $driftConfig.excludePaths) { throw "excludePaths missing" }
    $driftExcludePrefixes = @($driftConfig.excludePaths)
} catch {
    Write-Host "  [ERROR] .baseline-drift.json is unreadable or has no excludePaths - refusing to sweep." -ForegroundColor Red
    exit 1
}
$repoRootPath = (Get-Location).Path

function Test-DriftExcluded {
    param([string]$FullName)
    if ($driftExcludePrefixes.Count -eq 0) { return $false }
    $rel = $FullName
    if ($rel.StartsWith($repoRootPath)) {
        $rel = $rel.Substring($repoRootPath.Length)
    }
    $rel = ($rel -replace '\\', '/').TrimStart('/')
    foreach ($prefix in $driftExcludePrefixes) {
        if ($rel.StartsWith($prefix) -or $rel -eq ($prefix -replace '/+$', '')) { return $true }
    }
    return $false
}

$allFiles = Get-ChildItem -Path "." -Include "*.md", "*.html" -File -Recurse |
    Where-Object {
        $_.FullName -notmatch "node_modules|vendor|\.git|\.claude|\.worktrees|\.codegraph" -and
        $_.FullName -notmatch "[/\\]_?archive[/\\]|[/\\]deprecated[/\\]" -and
        $_.FullName -notmatch "[/\\]docs[/\\]sessions[/\\]|[/\\]docs[/\\]milestones[/\\]" -and
        $_.FullName -notmatch "[/\\]docs[/\\]plans[/\\]" -and
        $_.FullName -notmatch "[/\\]docs[/\\]refactoring[/\\]|[/\\]docs[/\\]audit[/\\]" -and
        $_.FullName -notmatch "[/\\]Squire-Executive-Package[/\\](?!.*Squire-Executive-Package-v2)" -and
        $_.FullName -notmatch "[/\\]docs[/\\]testing[/\\]test-runs[/\\]" -and
        $_.Name -notmatch "^MODULE_\d.*LESSON_SUMMARY" -and
        $_.Name -notmatch "^COMPREHENSIVE-TEST-REPORT-" -and
        $_.Name -ne "AGENTS.md" -and
        $_.Name -ne "TEST_FAILURE_ANALYSIS.md" -and
        -not (Test-DriftExcluded $_.FullName)
    }

Write-Host "  Found $($allFiles.Count) files to audit" -ForegroundColor Gray
Write-Host ""

foreach ($file in $allFiles) {
    $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }

    $originalContent = $content
    $fileChanges = @()
    $isHtmlFile = $file.Extension -eq ".html"

    $frozenTail = $null
    if ($file.Name -eq "CLAUDE.md") {
        $splitMarker = "## Recent Changes"
        $splitIndex = $content.IndexOf($splitMarker)
        if ($splitIndex -gt 0) {
            $frozenTail = $content.Substring($splitIndex)
            $content = $content.Substring(0, $splitIndex)
        }
    }

    # Text fenced by whole-line `<!-- vintage:<id> -->` / `<!-- /vintage -->`
    # markers is a point-in-time snapshot, not a claim about now: a progression
    # tail ("up from 12,214 on June 12"), a slide-vintage citation, a frozen
    # ingest. Re-baselining it rewrites history — and worse, these baselines are
    # COUPLED (9,364 tests / 392 suites / 68.71% coverage were measured
    # together), so bumping one number strands the rest and produces a snapshot
    # that never existed. Same marker contract as scripts/check-baseline-drift.mjs,
    # which scope-skips these blocks; every tool that rewrites baselines must
    # honour them or the two disagree about what is frozen.
    #
    # Each block is swapped for an index placeholder, the replacement pass runs
    # over what is left, and the blocks are restored verbatim afterwards.
    $vintageBlocks = @()
    $content = [regex]::Replace(
        $content,
        '(?ms)^[ \t]*<!--[ \t]*vintage:[^>]*-->[ \t]*\r?$(?:.*?^[ \t]*<!--[ \t]*/vintage[ \t]*-->[ \t]*\r?$|.*\z)',
        {
            param($m)
            $script:vintageBlocks += $m.Value
            "<<<VINTAGE_FROZEN_$($script:vintageBlocks.Count - 1)>>>"
        }
    )

    foreach ($pattern in $standardReplacements.Keys) {
        if ($content -match $pattern) {
            $content = $content -replace $pattern, $standardReplacements[$pattern]
            $fileChanges += "Updated: $pattern"
        }
    }

    $testPatterns = @(
        "[\d,]+ tests passing across [\d,]+ test suites",
        "[\d,]+ passing, [\d,]+ skipped",
        "100% pass rate \([\d,]+/[\d,]+ executed tests passed, [\d,]+ skipped\)",
        "Test Coverage\*\*: [\d,]+ tests"
    )

    foreach ($pattern in $testPatterns) {
        if ($content -match $pattern) {
            if ($isHtmlFile) {
                $content = $content -replace $pattern, $testCountFull
            } else {
                $content = $content -replace $pattern, $testCountWithCoverage
            }
            $fileChanges += "Test counts updated to current"
            break
        }
    }

    if (-not $isHtmlFile -and $coverageStmt -ne $null -and $content -match '\d+(\.\d+)?%\s+(coverage|statements?)') {
        $content = $content -replace '(\d+(\.\d+)?)(% coverage)', "$coverageStmt`${3}"
        $content = $content -replace '(\d+(\.\d+)?)(% statements?)', "$coverageStmt`${3}"
        $fileChanges += "Coverage updated to $coverageStmt%"
    }

    if ($content -match '(September|August|July) 2025' -and $file.Name -notmatch '2025-\d{2}') {
        $content = $content -replace '(September|August|July) 2025', $currentMonth
        $fileChanges += "Updated to current month"
    }

    if ($content -match '\d+ AI providers' -or $content -match '\d+ providers configured') {
        $content = $content -replace '\d+ AI providers', "$aiProviderCount AI providers"
        $content = $content -replace '\d+ providers configured', "$aiProviderCount providers configured"
        $fileChanges += "AI provider count updated"
    }

    if ($content -match '\d+ connectors implemented' -or $content -match '\d+ connector implementations') {
        $content = $content -replace '\d+ connectors implemented', "$connectorCount connectors implemented"
        $content = $content -replace '\d+ connector implementations', "$connectorCount connector implementations"
        $fileChanges += "Connector count updated"
    }

    if ($file.Name -eq 'FAQ.md') {
        if ($content -match '\*\*Test Status\*\*: \d+') {
            $content = $content -replace '\*\*Test Status\*\*: \d+ tests passing \([^)]+\)', "**Test Status**: $testsPassedFmt tests passing ($executedPassRateText% executed pass rate, $testsSkippedFmt skipped)"
            $fileChanges += "FAQ test status updated"
        }
        if ($content -match '\*\*Version\*\*: \d+\.\d+\.\d+') {
            $content = $content -replace '\*\*Version\*\*: \d+\.\d+\.\d+', "**Version**: $version"
            $fileChanges += "FAQ version updated"
        }
    }

    # Conditional "Last Updated" / "**Date**" bump:
    # Run AFTER all substantive (non-date) replacements above. The flag is
    # computed here so any earlier replacement (testPatterns, coverage, month,
    # provider/connector counts, FAQ-specific) can drive the date bump. Files
    # with no substantive change keep their existing date — "Last Updated"
    # is supposed to mean "this content was reviewed/edited on this date";
    # mechanical bumps mislead readers and create git-blame noise.
    #
    # CLAUDE.md note: the frozenTail split above (lines ~459-466) sliced the
    # "## Recent Changes" tail out of $content. Comparing $content directly
    # to $originalContent would always be true for CLAUDE.md (head ≠ full
    # file) and trigger a spurious bump even with no substantive edit. So
    # compare against the would-be-rebuilt content (head + tail) instead.
    #
    # Comparison note: PowerShell's -ne on strings is case-insensitive and
    # culture-aware by default. Use [string]::Equals with Ordinal so a
    # hypothetical future replacement that only changes case (or contains
    # locale-sensitive Unicode) is correctly detected as a substantive edit.
    # The change comparison must see the RESTORED text (placeholders would make
    # every vintage-bearing file compare as changed and take a spurious date
    # bump), but the date bump itself must run while the placeholders are still
    # IN $content — a frozen "Last Updated:"-style date inside a vintage block
    # must stay verbatim even when the rest of the file changed. So: restore
    # into a comparison copy, decide, bump the still-fenced content, and only
    # then restore for real (below, after the bump).
    $restoredForComparison = $content
    for ($vi = $vintageBlocks.Count - 1; $vi -ge 0; $vi--) {
        $restoredForComparison = $restoredForComparison.Replace("<<<VINTAGE_FROZEN_$vi>>>", $vintageBlocks[$vi])
    }

    $comparisonContent = if ($frozenTail) { $restoredForComparison + $frozenTail } else { $restoredForComparison }
    $contentChangedBySubstantiveReplacements = -not [string]::Equals($comparisonContent, $originalContent, [System.StringComparison]::Ordinal)

    if ($contentChangedBySubstantiveReplacements) {
        if (-not $isHtmlFile) {
            if ($content -match 'Last Updated\*\*: [A-Za-z]+ \d{1,2}, \d{4}') {
                $content = $content -replace 'Last Updated\*\*: [A-Za-z]+ \d{1,2}, \d{4}', "Last Updated**: $currentDate"
                $fileChanges += "Last Updated date bumped (content-driven)"
            }
            if ($content -match 'Last Updated: [A-Za-z]+ \d{1,2}, \d{4}') {
                $content = $content -replace 'Last Updated: [A-Za-z]+ \d{1,2}, \d{4}', "Last Updated: $currentDate"
                $fileChanges += "Last Updated date bumped (content-driven)"
            }
            if ($content -match '\*\*Date\*\*: [A-Za-z]+ \d{1,2}, \d{4}') {
                $content = $content -replace '\*\*Date\*\*: [A-Za-z]+ \d{1,2}, \d{4}', "**Date**: $currentDate"
                $fileChanges += "Date bumped (content-driven)"
            }
        } else {
            if ($content -match 'Last Updated: [A-Za-z]+ \d{1,2}, \d{4}' -and
                $content -notmatch 'Last Updated: <span x-text' -and
                $content -notmatch 'Last Updated: \$\{') {
                $content = $content -replace '(<!--[^>]*Last Updated: )[A-Za-z]+ \d{1,2}, \d{4}', "`${1}$currentDate"
                $fileChanges += "HTML static date bumped (content-driven)"
            }
        }
    }

    # Restore the frozen vintage blocks AFTER the conditional date bump so
    # their dates stay verbatim; the comparison above already used the
    # restored copy, so no spurious date bumps result from this ordering.
    for ($vi = $vintageBlocks.Count - 1; $vi -ge 0; $vi--) {
        $content = $content.Replace("<<<VINTAGE_FROZEN_$vi>>>", $vintageBlocks[$vi])
    }

    if ($frozenTail) {
        $content = $content + $frozenTail
    }

    # Write gate: matches the date-bump gate above (ordinal, case-sensitive,
    # locale-independent) so a case-only or locale-sensitive substantive
    # change is consistently detected by both gates. Without this, the
    # date-bump gate could fire (and log a change) while the write gate
    # silently skipped the file write — a worse failure mode than the
    # pre-PR uniform case-insensitive behavior.
    if (-not [string]::Equals($content, $originalContent, [System.StringComparison]::Ordinal)) {
        $filesUpdated++
        $relativePath = $file.FullName.Replace((Get-Location).Path + '\\', '')
        if ($DryRun) {
            Write-Host "  [DRY-RUN] $relativePath" -ForegroundColor Yellow
        } else {
            Set-Content -Path $file.FullName -Value $content -NoNewline
            Write-Host "  [OK] $relativePath" -ForegroundColor Green
        }
        foreach ($change in $fileChanges) {
            Write-Host "     - $change" -ForegroundColor Gray
        }
        $changesApplied += [PSCustomObject]@{
            File = $relativePath
            Changes = ($fileChanges -join '; ')
        }
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Audit & Update Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[INFO] Codebase State (Source of Truth):" -ForegroundColor Yellow
Write-Host "  Unit Tests: $testsPassedFmt passed, $testsSkippedFmt skipped - $testSuitesFmt suites" -ForegroundColor White
Write-Host "  E2E Portal Tests: $e2ePassedFmt passed - $e2eSuitesFmt suites" -ForegroundColor White
Write-Host "  Integration Tests: $intPassedFmt passed, $intSkippedFmt skipped - $intSuitesFmt suites" -ForegroundColor White
Write-Host "  Grand Total: $grandPassedFmt passed, $grandSkippedFmt skipped - $grandSuitesFmt suites" -ForegroundColor Cyan
if ($coverageStmt -ne $null) {
    Write-Host "  Coverage: $coverageStmt% statements, $coverageBranch% branches" -ForegroundColor White
}
Write-Host "  Version: $version" -ForegroundColor White
Write-Host "  Connectors: $connectorCount" -ForegroundColor White
Write-Host "  AI Agents: $agentCount" -ForegroundColor White
Write-Host "  AI Providers: $aiProviderCount configured" -ForegroundColor White
Write-Host ""

Write-Host "[INFO] Documentation Updates:" -ForegroundColor Yellow
Write-Host "  Files Scanned: $($allFiles.Count)" -ForegroundColor White
Write-Host "  Files $(if ($DryRun) { 'Would Update' } else { 'Updated' }): $filesUpdated" -ForegroundColor Green
Write-Host ""

if ($filesUpdated -gt 0) {
    Write-Host "Next Steps:" -ForegroundColor Yellow
    if ($DryRun) {
        Write-Host "  1. Re-run without -DryRun to apply changes" -ForegroundColor White
    } else {
        Write-Host "  1. Review changes: git diff" -ForegroundColor White
        Write-Host "  2. Commit when ready" -ForegroundColor White
    }
} else {
    Write-Host "[OK] No documentation changes required." -ForegroundColor Green
}

Write-Host ""
