export function clampElapsedMs(elapsedMs: number): number {
  // Wall-clock deltas can go negative under clock sync or VM skew.
  return Math.max(0, elapsedMs);
}

export function getElapsedMs(startTime: number, endTime: number = Date.now()): number {
  return clampElapsedMs(endTime - startTime);
}

export function getElapsedMsFromDates(startTime: Date, endTime: Date): number {
  return clampElapsedMs(endTime.getTime() - startTime.getTime());
}
