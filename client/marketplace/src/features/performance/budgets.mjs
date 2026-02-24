export const PERFORMANCE_BUDGETS = Object.freeze({
  startup_script_bytes: 180_000,
  startup_style_bytes: 48_000,
  startup_total_bytes: 280_000,
  interaction_p95_ms: 80,
  long_list_render_ms: 100
});

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values
    .filter(value => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

export function startupBudgetResult({ scriptBytes = 0, styleBytes = 0, totalBytes = 0 } = {}) {
  return {
    scriptBytes,
    styleBytes,
    totalBytes,
    pass: scriptBytes <= PERFORMANCE_BUDGETS.startup_script_bytes
      && styleBytes <= PERFORMANCE_BUDGETS.startup_style_bytes
      && totalBytes <= PERFORMANCE_BUDGETS.startup_total_bytes
  };
}

export function interactionBudgetResult(samples) {
  const p95 = percentile(samples, 95);
  return {
    sampleCount: Array.isArray(samples) ? samples.length : 0,
    p95Ms: p95,
    pass: p95 <= PERFORMANCE_BUDGETS.interaction_p95_ms
  };
}

export function longListBudgetResult(durationMs) {
  const safeDuration = Number.isFinite(durationMs) ? durationMs : Number.POSITIVE_INFINITY;
  return {
    durationMs: safeDuration,
    pass: safeDuration <= PERFORMANCE_BUDGETS.long_list_render_ms
  };
}
