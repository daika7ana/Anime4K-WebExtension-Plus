/**
 * Shared numeric helpers for the DEV/TEST-ONLY CPU reference ports.
 *
 * These modules are loaded directly by the headless-WebGPU correctness gate
 * (see `e2e/gpu/*.spec.ts`), so this helper must stay dependency-free and
 * import nothing.
 */

/**
 * Clamp `value` to the [0, 1] range. `NaN` is returned unchanged (neither
 * comparison holds), matching the previous per-module implementations.
 */
export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
