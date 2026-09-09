import type { TransferPhase } from './types';

export interface TransferErrorLocation {
  readonly table?: string;
  readonly column?: string;
}

export class TransferError extends Error {
  readonly phase: TransferPhase;
  readonly code: string;
  readonly location?: TransferErrorLocation;

  constructor(
    phase: TransferPhase,
    code: string,
    location?: TransferErrorLocation,
    cause?: unknown,
  ) {
    super(`${phase}:${code}`);
    this.name = 'TransferError';
    this.phase = phase;
    this.code = code;
    this.location = location;
    if (cause instanceof Error) {
      this.cause = { name: cause.name };
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      phase: this.phase,
      code: this.code,
      ...(this.location ? { location: this.location } : {}),
    };
  }
}

export function safeErrorCode(error: unknown): string {
  if (error === undefined) return 'UNKNOWN';
  if (error instanceof Error) return 'ERROR';
  return 'NON_ERROR_THROWN';
}
