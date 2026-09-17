// Keep the existing load-watchdog default for profiles created before this setting.
export const DEFAULT_STALL_WAIT_SEC = 18;
export const STALL_WAIT_OPTIONS = [18, 20, 30, 60] as const;

export function stallWaitSec(value: unknown): number {
  return typeof value === "number" && STALL_WAIT_OPTIONS.some((seconds) => seconds === value)
    ? value
    : DEFAULT_STALL_WAIT_SEC;
}
