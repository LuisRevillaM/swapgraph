import { offerSatisfiesWantSpec } from './wantSpec.mjs';
import { valueOfAssets } from './values.mjs';

export function buildCompatibilityGraph({ intents, assetValuesUsd }) {
  const active = intents.filter(i => (i.status ?? 'active') === 'active');
  const byId = new Map(active.map(i => [i.id, i]));
  const edges = new Map(); // id -> neighbor ids (providers)

  for (const a of active) {
    const neighbors = [];
    for (const b of active) {
      if (a.id === b.id) continue;
      // can b satisfy a's want?
      if (!offerSatisfiesWantSpec({ wantSpec: a.want_spec, offerAssets: b.offer })) continue;

      // value band check (a receives b.offer)
      const getValue = valueOfAssets({ assets: b.offer, assetValuesUsd });
      const min = a.value_band?.min_usd;
      const max = a.value_band?.max_usd;
      if (typeof min === 'number' && getValue < min) continue;
      if (typeof max === 'number' && getValue > max) continue;

      neighbors.push(b.id);
    }
    edges.set(a.id, neighbors);
  }

  return { byId, edges };
}
