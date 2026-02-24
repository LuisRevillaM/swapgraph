export function valueOfAssets({ assets, assetValuesUsd }) {
  if (!Array.isArray(assets)) return 0;
  let total = 0;
  for (const a of assets) {
    const id = a?.asset_id;
    const v = id ? assetValuesUsd?.[id] : undefined;
    if (typeof v !== 'number') {
      throw new Error(`Missing asset value for asset_id=${id}`);
    }
    total += v;
  }
  return total;
}

export function round(n, decimals) {
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

export function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
