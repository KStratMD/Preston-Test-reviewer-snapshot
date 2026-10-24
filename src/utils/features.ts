import { isDemoMode } from "../config/runtimeFlags";

export function isDemo(): boolean {
  return isDemoMode();
}

export function isRedisDisabled(): boolean {
  return process.env.DISABLE_REDIS === "1";
}

export function isBootDebug(): boolean {
  return process.env.BOOT_DEBUG === "1";
}

export function isOtelEnabled(): boolean {
  return process.env.DEMO_NO_OTEL !== "1";
}

export function applyEnvDerivations(): void {
  // If in demo mode or redis disabled, derive that OTEL should be disabled
  if (isDemo() || isRedisDisabled()) {
    process.env.DEMO_NO_OTEL = "1";
  }
}
