module.exports = {
  timeout: 30000,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    baseURL: process.env.DEMO_URL || 'http://localhost:3000',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  testDir: 'tests/playwright',
};

// PR 10a NOTE: the CSP frame-ancestors test
// (tests/playwright/embedded/csp-frame-ancestors.spec.ts) needs two
// HTTPS-served hostnames mapped to the local test server (e.g.
// `attacker.example.test:8443`, `embedded.suitecentral.test:8443`).
// Playwright doesn't have a direct config knob for this; the test sets
// these up via launch-args (`--ignore-certificate-errors`, `--host-resolver-rules`)
// inside the spec itself. If the spec is moved to a webServer-launched
// flow in PR 10b, lift the resolver-rules into a Playwright `webServer`
// block here.
