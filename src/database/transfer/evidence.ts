import type {
  EvidenceCheck,
  EvidenceReport,
  EvidenceStatus,
} from './types';
import fs from 'node:fs';
import path from 'node:path';

export class EvidenceReportBuilder {
  private readonly checks: EvidenceCheck[] = [];

  constructor(private readonly requiredChecks: readonly string[] = []) {}

  addCheck(check: EvidenceCheck): void {
    this.checks.push({
      name: check.name,
      status: check.status,
      ...(check.code ? { code: check.code } : {}),
    });
  }

  build(): EvidenceReport {
    const hasAllRequiredChecks = this.requiredChecks.length > 0
      && this.requiredChecks.every((name) => this.checks.some((check) => check.name === name));
    const status: EvidenceStatus = this.checks.some((check) => check.status === 'failed')
      ? 'failed'
      : hasAllRequiredChecks
        && this.checks.length === this.requiredChecks.length
        && this.checks.every((check) => check.status === 'passed')
        ? 'passed'
        : 'not_run';

    return {
      format: 'db-transfer-evidence/v1',
      status,
      checks: this.checks.map((check) => ({ ...check })),
    };
  }
}

/** Write only a complete pass/fail report; an interrupted run cannot leave a success-shaped file. */
export function writeEvidenceReportAtomic(filePath: string, report: EvidenceReport): void {
  if (report.status === 'not_run') throw new Error('Evidence report is incomplete');
  const target = path.resolve(filePath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve original error */ }
    throw error;
  }
}
