import { assetKeyFor } from './assetKeys.mjs';

export function offerSatisfiesWantSpec({ wantSpec, offerAssets }) {
  if (!wantSpec || wantSpec.type !== 'set' || !Array.isArray(wantSpec.any_of)) return false;
  if (!Array.isArray(offerAssets) || offerAssets.length === 0) return false;

  const keys = offerAssets.map(assetKeyFor).filter(Boolean);

  for (const clause of wantSpec.any_of) {
    if (!clause || typeof clause !== 'object') continue;

    if (clause.type === 'specific_asset') {
      if (clause.platform && clause.platform !== 'steam') continue; // v1: steam-only fixtures
      if (typeof clause.asset_key !== 'string') continue;
      if (keys.includes(clause.asset_key)) return true;
    }

    if (clause.type === 'category') {
      // v1: minimal support. If the offer metadata contains a matching category, accept.
      const cat = clause.category;
      if (!cat) continue;
      const ok = offerAssets.some(a => a?.metadata?.category === cat);
      if (ok) return true;
    }
  }

  return false;
}
