import { trackAAssetLabel } from '../../pilot/trackATheme.mjs';

function titleCaseToken(token) {
  return token
    .split(/\s+/)
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : '')
    .join(' ')
    .trim();
}

export function humanizeAssetId(assetId) {
  const themed = trackAAssetLabel(assetId);
  if (themed) return themed;
  const raw = String(assetId ?? '').trim();
  if (!raw) return 'Unknown item';
  const cleaned = raw
    .replace(/^steam:/, '')
    .replace(/^asset[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return raw;
  return titleCaseToken(cleaned);
}

function demandByAssetFromProjection(projection) {
  const out = new Map();
  const recommendations = projection?.recommendedFirstIntents ?? [];

  for (const recommendation of recommendations) {
    const assetId = recommendation?.suggestedGiveAssetId ?? null;
    if (!assetId) continue;
    out.set(assetId, (out.get(assetId) ?? 0) + 1);
  }

  return out;
}

function upsertCard(cards, asset, intent, demandByAsset) {
  const assetId = String(asset?.assetId ?? '').trim();
  if (!assetId) return;

  const existing = cards.get(assetId) ?? {
    assetId,
    name: humanizeAssetId(asset?.label || assetId),
    wear: String(asset?.wear ?? '').trim() || 'n/a',
    priceUsd: Number(asset?.valueUsd ?? 0),
    demandCount: 0,
    intentCount: 0,
    statuses: new Set()
  };

  existing.priceUsd = Math.max(existing.priceUsd, Number(asset?.valueUsd ?? 0));
  existing.wear = existing.wear === 'n/a' && asset?.wear ? String(asset.wear) : existing.wear;
  existing.demandCount = Math.max(existing.demandCount, demandByAsset.get(assetId) ?? 0);
  existing.intentCount += 1;
  existing.statuses.add(intent?.status ?? 'active');

  cards.set(assetId, existing);
}

function sortCards(cards, sort) {
  const items = cards.slice();

  if (sort === 'also_tradable') {
    items.sort((a, b) => {
      if (a.demandCount !== b.demandCount) return a.demandCount - b.demandCount;
      if (a.priceUsd !== b.priceUsd) return b.priceUsd - a.priceUsd;
      return a.name.localeCompare(b.name);
    });
    return items;
  }

  items.sort((a, b) => {
    if (a.demandCount !== b.demandCount) return b.demandCount - a.demandCount;
    if (a.priceUsd !== b.priceUsd) return b.priceUsd - a.priceUsd;
    return a.name.localeCompare(b.name);
  });
  return items;
}

export function buildItemCards({ intents = [], projection = null, sort = 'highest_demand' }) {
  const demandByAsset = demandByAssetFromProjection(projection);
  const cardMap = new Map();

  for (const intent of intents) {
    for (const asset of intent?.offer ?? []) {
      upsertCard(cardMap, asset, intent, demandByAsset);
    }
  }

  for (const recommendation of projection?.recommendedFirstIntents ?? []) {
    const assetId = recommendation?.suggestedGiveAssetId ?? null;
    if (!assetId || cardMap.has(assetId)) continue;
    cardMap.set(assetId, {
      assetId,
      name: humanizeAssetId(assetId),
      wear: 'n/a',
      priceUsd: 0,
      demandCount: demandByAsset.get(assetId) ?? 0,
      intentCount: 0,
      statuses: new Set()
    });
  }

  const sorted = sortCards(Array.from(cardMap.values()), sort).map(card => ({
    ...card,
    statuses: Array.from(card.statuses).sort(),
    kind: card.demandCount > 0 ? 'highest_demand' : 'also_tradable'
  }));

  return {
    cards: sorted,
    highestDemandCount: sorted.filter(card => card.kind === 'highest_demand').length,
    alsoTradableCount: sorted.filter(card => card.kind === 'also_tradable').length
  };
}

export function demandBannerModel(projection) {
  const opportunities = Number(projection?.swappabilitySummary?.cycleOpportunities ?? 0);
  return {
    visible: opportunities > 0,
    opportunityCount: opportunities,
    copy: opportunities === 1
      ? '1 proposal matched your intents'
      : `${opportunities} proposals matched your intents`
  };
}
