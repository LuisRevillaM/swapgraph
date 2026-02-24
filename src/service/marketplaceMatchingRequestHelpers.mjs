export function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

export function parsePositiveInt(value, fallback, max = 200) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, max);
}

export function normalizeAssetValuesMap(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const out = {};
  for (const [assetId, amount] of Object.entries(value)) {
    const key = normalizeOptionalString(assetId);
    const numeric = Number(amount);
    if (!key || !Number.isFinite(numeric) || numeric < 0) return null;
    out[key] = numeric;
  }
  return out;
}

function valueFromAsset(asset) {
  const candidates = [
    asset?.estimated_value_usd,
    asset?.value_usd,
    asset?.metadata?.estimated_value_usd,
    asset?.metadata?.value_usd
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  return null;
}

export function deriveAssetValuesFromIntents(intents) {
  const out = {};
  for (const intent of intents ?? []) {
    for (const asset of intent?.offer ?? []) {
      const assetId = normalizeOptionalString(asset?.asset_id);
      const value = valueFromAsset(asset);
      if (assetId && value !== null) out[assetId] = value;
    }
  }
  return out;
}
