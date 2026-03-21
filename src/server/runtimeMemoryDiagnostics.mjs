function toMb(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round((value / (1024 * 1024)) * 10) / 10;
}

function parsePositiveNumber(raw, fallback = 0) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function parseRuntimeMemoryOptions(env = process.env) {
  return {
    diagnosticsEnabled: env.MARKET_RUNTIME_MEMORY_DIAGNOSTICS === '1',
    rssGuardMb: parsePositiveNumber(env.MARKET_RUNTIME_MEMORY_GUARD_RSS_MB, 0),
    logThresholdMs: parsePositiveNumber(env.MARKET_RUNTIME_MEMORY_LOG_THRESHOLD_MS, 1000)
  };
}

export function snapshotRuntimeMemory(memoryUsage = process.memoryUsage()) {
  return {
    rss_mb: toMb(memoryUsage?.rss),
    heap_total_mb: toMb(memoryUsage?.heapTotal),
    heap_used_mb: toMb(memoryUsage?.heapUsed),
    external_mb: toMb(memoryUsage?.external),
    array_buffers_mb: toMb(memoryUsage?.arrayBuffers)
  };
}

export function memoryDelta(before, after) {
  return {
    rss_mb: Math.round(((after?.rss_mb ?? 0) - (before?.rss_mb ?? 0)) * 10) / 10,
    heap_used_mb: Math.round(((after?.heap_used_mb ?? 0) - (before?.heap_used_mb ?? 0)) * 10) / 10,
    external_mb: Math.round(((after?.external_mb ?? 0) - (before?.external_mb ?? 0)) * 10) / 10
  };
}

export function hotPathLabel(method, pathname) {
  if (method === 'POST' && pathname === '/market/candidates/compute') return 'market_candidates_compute';
  if (method === 'POST' && /^\/market\/execution-plans\/from-candidate\/[^/]+$/.test(pathname)) return 'market_execution_plan_create';
  if (method === 'POST' && /^\/market\/deals\/from-edge\/[^/]+$/.test(pathname)) return 'market_deal_create';
  return null;
}

export function shouldRejectForMemoryGuard({ rssMb, rssGuardMb }) {
  return Number(rssGuardMb) > 0 && Number(rssMb) >= Number(rssGuardMb);
}

export function hotPathLogRecord({
  label,
  method,
  pathname,
  correlationId,
  durationMs,
  before,
  after,
  context = {},
  statusCode = 200
}) {
  return {
    kind: 'runtime_hot_path',
    label,
    method,
    path: pathname,
    correlation_id: correlationId,
    duration_ms: durationMs,
    status_code: statusCode,
    memory_before: before,
    memory_after: after,
    memory_delta: memoryDelta(before, after),
    context
  };
}
