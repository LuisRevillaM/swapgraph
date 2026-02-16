export function assetKeyFor(assetRef) {
  const platform = assetRef?.platform;
  const assetId = assetRef?.asset_id;
  if (!platform || !assetId) return null;
  return `${platform}:${assetId}`;
}
