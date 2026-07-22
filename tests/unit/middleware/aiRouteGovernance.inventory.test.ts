import * as fs from 'fs';
import * as path from 'path';
import {
  AI_ROUTE_MANIFEST,
  GOVERNED_PATHS,
  type AIRouteEntry,
  type RouteGovernancePosture,
} from '../../../src/middleware/setup/aiRouteManifest';

const VALID_POSTURES: RouteGovernancePosture[] = ['governed', 'ungoverned', 'demo_only', 'deprecated'];
const VALID_FAMILIES: AIRouteEntry['family'][] = ['proxy', 'direct'];

// Counts locked at manifest-write time. Update here whenever RouteSetup.ts gains/loses an AI mount.
// PR 1B: 9 → 3 after consolidation (1 governed proxy, 1 deprecated redirect shim, 1 demo_only)
const EXPECTED_ROUTE_COUNTS = {
  total: 3,
  governed: 1,
  deprecated: 1,
  demo_only: 1,
  ungoverned: 0,
} as const;

describe('AI Route Governance Inventory', () => {
  describe('manifest structure', () => {
    it('manifest is non-empty', () => {
      expect(AI_ROUTE_MANIFEST.length).toBeGreaterThan(0);
    });

    it.each(AI_ROUTE_MANIFEST)('entry "$path" ($mountedBy) has a defined valid posture', (entry) => {
      expect(VALID_POSTURES).toContain(entry.posture);
    });

    it.each(AI_ROUTE_MANIFEST)('entry "$path" has a valid family', (entry) => {
      expect(VALID_FAMILIES).toContain(entry.family);
    });

    it.each(AI_ROUTE_MANIFEST)('entry "$path" has a non-empty path and mountedBy', (entry) => {
      expect(entry.path.trim()).not.toBe('');
      expect(entry.mountedBy.trim()).not.toBe('');
    });

    it.each(AI_ROUTE_MANIFEST)('entry "$path" path starts with /api/', (entry) => {
      expect(entry.path).toMatch(/^\/api\//);
    });
  });

  describe('governance posture distribution', () => {
    it(`has exactly ${EXPECTED_ROUTE_COUNTS.governed} governed entry`, () => {
      const governed = AI_ROUTE_MANIFEST.filter((e) => e.posture === 'governed');
      expect(governed).toHaveLength(EXPECTED_ROUTE_COUNTS.governed);
    });

    it(`has exactly ${EXPECTED_ROUTE_COUNTS.ungoverned} ungoverned entries (PR 1B closed the gap)`, () => {
      const ungoverned = AI_ROUTE_MANIFEST.filter((e) => e.posture === 'ungoverned');
      expect(ungoverned).toHaveLength(EXPECTED_ROUTE_COUNTS.ungoverned);
    });

    it(`has exactly ${EXPECTED_ROUTE_COUNTS.deprecated} deprecated entry (301 redirect shim)`, () => {
      const deprecated = AI_ROUTE_MANIFEST.filter((e) => e.posture === 'deprecated');
      expect(deprecated).toHaveLength(EXPECTED_ROUTE_COUNTS.deprecated);
    });

    it(`has exactly ${EXPECTED_ROUTE_COUNTS.demo_only} demo_only entry`, () => {
      const demoOnly = AI_ROUTE_MANIFEST.filter((e) => e.posture === 'demo_only');
      expect(demoOnly).toHaveLength(EXPECTED_ROUTE_COUNTS.demo_only);
    });

    it('all governed entries belong to the proxy family', () => {
      const governed = AI_ROUTE_MANIFEST.filter((e) => e.posture === 'governed');
      governed.forEach((e) => {
        expect(e.family).toBe('proxy');
      });
    });

    it('GOVERNED_PATHS export contains paths for all governed entries', () => {
      const governed = AI_ROUTE_MANIFEST.filter((e) => e.posture === 'governed');
      expect(GOVERNED_PATHS).toHaveLength(governed.length);
      governed.forEach((e) => {
        expect(GOVERNED_PATHS).toContain(e.path);
      });
    });
  });

  describe('governance enforcement verification', () => {
    it('proxy router (createAIProxyRouter) source references GovernanceService', () => {
      const aiProxyPath = path.resolve(__dirname, '../../../src/routes/aiProxy.ts');
      const source = fs.readFileSync(aiProxyPath, 'utf8');
      expect(source).toMatch(/GovernanceService/);
      expect(source).toMatch(/governanceService/);
    });

    it('proxy router references centralized governanceMiddleware (PR 1B)', () => {
      const aiProxyPath = path.resolve(__dirname, '../../../src/routes/aiProxy.ts');
      const source = fs.readFileSync(aiProxyPath, 'utf8');
      expect(source).toMatch(/createGovernanceMiddleware/);
    });

    it('no ungoverned routes remain in manifest', () => {
      const ungoverned = AI_ROUTE_MANIFEST.filter((e) => e.posture === 'ungoverned');
      expect(ungoverned).toHaveLength(0);
    });
  });

  describe('manifest exhaustiveness — RouteSetup.ts coverage', () => {
    const ROUTE_SETUP_PATH = path.resolve(__dirname, '../../../src/middleware/setup/RouteSetup.ts');

    it('RouteSetup.ts is readable', () => {
      expect(fs.existsSync(ROUTE_SETUP_PATH)).toBe(true);
    });

    it(`manifest total entry count matches expected (${EXPECTED_ROUTE_COUNTS.total})`, () => {
      expect(AI_ROUTE_MANIFEST).toHaveLength(EXPECTED_ROUTE_COUNTS.total);
    });

    it('RouteSetup.ts mounts /api/ai/proxy exactly once', () => {
      const source = fs.readFileSync(ROUTE_SETUP_PATH, 'utf8');
      const matches = source.match(/this\.app\.use\(['"`]\/api\/ai\/proxy['"`]/g) ?? [];
      expect(matches).toHaveLength(1);
    });

    it('manifest contains an entry for /api/ai/proxy', () => {
      const entry = AI_ROUTE_MANIFEST.find((e) => e.path === '/api/ai/proxy');
      expect(entry).toBeDefined();
      expect(entry?.posture).toBe('governed');
    });

    it('no manifest entry has posture undefined', () => {
      AI_ROUTE_MANIFEST.forEach((e) => {
        expect(e.posture).toBeDefined();
      });
    });

    it('manifest entry count matches actual /api/ai* mounts in RouteSetup.ts', () => {
      // Parse RouteSetup.ts for every this.app.use('/api/ai...') call so that adding a new AI
      // mount without a manifest entry causes this test to fail.
      const source = fs.readFileSync(ROUTE_SETUP_PATH, 'utf8');
      const mountPattern = /this\.app\.use\(['"`](\/api\/ai[^'"`]*)['"` ]/g;
      const actualMounts: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = mountPattern.exec(source)) !== null) {
        actualMounts.push(match[1]);
      }
      expect(actualMounts).toHaveLength(AI_ROUTE_MANIFEST.length);
      // Each manifest path must appear at least once in the extracted mount list.
      AI_ROUTE_MANIFEST.forEach((entry) => {
        expect(actualMounts).toContain(entry.path);
      });
    });
  });
});
