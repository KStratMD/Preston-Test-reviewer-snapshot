import { EvidenceReportBuilder } from '../../../../src/database/transfer/evidence';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEvidenceReportAtomic } from '../../../../src/database/transfer/evidence';

describe('database transfer evidence', () => {
  it('does not emit a success report before all checks pass', () => {
    const builder = new EvidenceReportBuilder(['schema', 'integrity']);
    builder.addCheck({ name: 'schema', status: 'passed' });

    expect(builder.build().status).toBe('not_run');
    expect(builder.build().checks).toEqual([{ name: 'schema', status: 'passed' }]);
  });

  it('emits passed only when every declared check passed', () => {
    const builder = new EvidenceReportBuilder(['schema', 'integrity']);
    builder.addCheck({ name: 'schema', status: 'passed' });
    builder.addCheck({ name: 'integrity', status: 'passed' });

    expect(builder.build().status).toBe('passed');
  });

  it('emits failed and preserves no unsafe details', () => {
    const builder = new EvidenceReportBuilder(['bundle']);
    builder.addCheck({ name: 'bundle', status: 'failed', code: 'AUTHENTICATION_FAILED' });

    const report = builder.build();
    expect(report.status).toBe('failed');
    expect(JSON.stringify(report)).not.toContain('password');
  });
});

it('atomically writes only complete evidence reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-transfer-evidence-')); const reportPath = path.join(dir, 'evidence.json');
  expect(() => writeEvidenceReportAtomic(reportPath, { format: 'db-transfer-evidence/v1', status: 'not_run', checks: [] })).toThrow(/incomplete/);
  writeEvidenceReportAtomic(reportPath, { format: 'db-transfer-evidence/v1', status: 'passed', checks: [{ name: 'all', status: 'passed' }] });
  expect(JSON.parse(fs.readFileSync(reportPath, 'utf8')).status).toBe('passed');
  fs.rmSync(dir, { recursive: true, force: true });
});
