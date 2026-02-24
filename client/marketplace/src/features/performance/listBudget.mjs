export const LONG_LIST_RENDER_LIMIT = 120;

export function clampListForRender(rows, { limit = LONG_LIST_RENDER_LIMIT } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : LONG_LIST_RENDER_LIMIT;
  const clipped = input.slice(0, safeLimit);
  return {
    rows: clipped,
    truncatedCount: Math.max(0, input.length - clipped.length),
    totalCount: input.length
  };
}
