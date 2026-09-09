export interface ProcessResourceSnapshot {
  monotonicNs: bigint;
  cpu: NodeJS.CpuUsage;
  memory: NodeJS.MemoryUsage;
  uptimeSeconds: number;
}

export interface ProcessResourceSampler {
  sample(): ProcessResourceSnapshot;
}

export class NodeProcessResourceSampler implements ProcessResourceSampler {
  sample(): ProcessResourceSnapshot {
    return {
      monotonicNs: process.hrtime.bigint(),
      cpu: process.cpuUsage(),
      memory: process.memoryUsage(),
      uptimeSeconds: process.uptime(),
    };
  }
}

export class CpuUsageDeltaCalculator {
  private previousSnapshot?: ProcessResourceSnapshot;

  calculate(snapshot: ProcessResourceSnapshot): number | undefined {
    const previousSnapshot = this.previousSnapshot;
    this.previousSnapshot = snapshot;

    if (!previousSnapshot) {
      return undefined;
    }

    const elapsedNs = snapshot.monotonicNs - previousSnapshot.monotonicNs;
    const deltaUser = snapshot.cpu.user - previousSnapshot.cpu.user;
    const deltaSystem = snapshot.cpu.system - previousSnapshot.cpu.system;

    if (elapsedNs <= 0n || deltaUser < 0 || deltaSystem < 0) {
      return undefined;
    }

    const elapsedMicroseconds = Number(elapsedNs) / 1_000;
    if (!Number.isFinite(elapsedMicroseconds) || elapsedMicroseconds <= 0) {
      return undefined;
    }

    const percentage = ((deltaUser + deltaSystem) / elapsedMicroseconds) * 100;
    return Math.min(100, Math.max(0, percentage));
  }

  reset(): void {
    this.previousSnapshot = undefined;
  }
}
