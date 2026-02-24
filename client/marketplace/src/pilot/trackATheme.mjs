const TRACK_A_ACTOR_ALIASES = Object.freeze({
  u1: 'Prompt Captain',
  u2: 'Agent Ops',
  u3: 'Bug Hunter',
  u4: 'Latency Slayer',
  u5: 'Deploy Commander',
  u6: 'Revenue Ranger'
});

const TRACK_A_ASSET_LABELS = Object.freeze({
  assetA: 'Prompt Forge License',
  assetB: 'Agent Autopilot Pass',
  assetC: 'Bug Bounty Badge',
  assetD: 'Deploy Rocket Skin',
  assetE: 'Revenue Rune',
  assetF: 'Vibe Coding Crown'
});

function normalizeAssetId(assetId) {
  const raw = String(assetId ?? '').trim();
  if (!raw) return '';
  return raw.replace(/^steam:/, '');
}

export function trackAActorIds() {
  return Object.keys(TRACK_A_ACTOR_ALIASES);
}

export function trackAActorAlias(actorId) {
  const normalized = String(actorId ?? '').trim();
  if (!normalized) return null;
  return TRACK_A_ACTOR_ALIASES[normalized] ?? null;
}

export function trackAAssetLabel(assetId) {
  const normalized = normalizeAssetId(assetId);
  if (!normalized) return null;
  return TRACK_A_ASSET_LABELS[normalized] ?? null;
}

export function actorDisplayLabel({ actorId, viewerActorId = null, includeAtFallback = true } = {}) {
  const normalized = String(actorId ?? '').trim();
  if (!normalized || normalized === 'unknown') return '@unknown';
  if (normalized === 'redacted') return '@counterparty';
  if (viewerActorId && normalized === viewerActorId) return 'You';

  const alias = trackAActorAlias(normalized);
  if (alias) return alias;
  if (includeAtFallback) return `@${normalized}`;
  return normalized;
}
