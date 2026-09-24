// Compute BASE_URL once and export it for test files
const resolveBaseUrl = () => {
    if (process.env.BASE_URL) return process.env.BASE_URL;
    try {
        const fs = require('fs');
        const path = require('path');
        const portFile = path.resolve(__dirname, '.server-port');
        if (fs.existsSync(portFile)) {
            const port = fs.readFileSync(portFile, 'utf8').trim();
            console.log(`[Playwright] Discovered port ${port} from .server-port file`);
            return `http://localhost:${port}/`;
        }
    } catch (e) { /* ignore */ }
    // Check if Docker is running on port 3003
    try {
        const { execSync } = require('child_process');
        execSync('docker ps | grep integration-hub', { stdio: 'ignore' });
        console.log('[Playwright] Docker container detected, using port 3003');
        return 'http://localhost:3003/';
    } catch (e) { /* Docker not running */ }
    return 'http://localhost:3000/'; // Fallback for local dev
};

const baseURL = resolveBaseUrl();
// Set process.env.BASE_URL so test files can access it
process.env.BASE_URL = baseURL;

module.exports = {
    timeout: 30000,
    use: {
        baseURL,
        headless: true,
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
    },
    testDir: 'tests/e2e',
    // Only run Playwright spec files, exclude Jest-style .e2e.test.ts files
    testMatch: '**/*.spec.ts',
    // Portals tests require SuiteCentral iframe hosting infrastructure not available in CI
    testIgnore: ['**/portals/**'],
};
