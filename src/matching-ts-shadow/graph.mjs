// Generated from src-ts/matching/graph.mts. Do not edit directly.
import { offerSatisfiesWantSpec } from './wantSpec.mjs';
import { valueOfAssets } from './values.mjs';

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function edgeKey(sourceIntentId, targetIntentId) {
  return `${sourceIntentId}>${targetIntentId}`;
}

function buildExplicitEdgeMap({ edgeIntents, nowIso }) {
  const out = new Map();
  const nowMs = parseIsoMs(nowIso) ?? Date.now();

  for (const row of edgeIntents ?? []) {
    const sourceIntentId = normalizeOptionalString(row?.source_intent_id);
    const targetIntentId = normalizeOptionalString(row?.target_intent_id);
    const intentType = normalizeOptionalString(row?.intent_type)?.toLowerCase() ?? null;
    const status = normalizeOptionalString(row?.status)?.toLowerCase() ?? 'active';
    const expiresMs = parseIsoMs(row?.expires_at);

    if (!sourceIntentId || !targetIntentId || sourceIntentId === targetIntentId) continue;
    if (status !== 'active') continue;
    if (expiresMs !== null && expiresMs <= nowMs) continue;
    if (!intentType || !['allow', 'prefer', 'block'].includes(intentType)) continue;

    const key = edgeKey(sourceIntentId, targetIntentId);
    const existing = out.get(key) ?? {
      allow: false,
      block: false,
      prefer_strength: 0
    };

    if (intentType === 'block') {
      existing.block = true;
    } else if (intentType === 'allow') {
      existing.allow = true;
    } else if (intentType === 'prefer') {
      const strengthRaw = Number(row?.strength);
      const strength = Number.isFinite(strengthRaw) ? Math.min(1, Math.max(0, strengthRaw)) : 1;
      existing.allow = true;
      existing.prefer_strength = Math.max(existing.prefer_strength, strength);
    }

    out.set(key, existing);
  }

  return out;
}

export function buildCompatibilityGraph({ intents, assetValuesUsd, edgeIntents = [], nowIso = null }) {
  const active = intents.filter(i => (i.status ?? 'active') === 'active');
  const byId = new Map(active.map(i => [i.id, i]));
  const edges = new Map(); // id -> neighbor ids (providers)
  const edgeMeta = new Map(); // source>target -> derivation metadata
  const explicit = buildExplicitEdgeMap({ edgeIntents, nowIso });

  for (const a of active) {
    const neighbors = [];
    for (const b of active) {
      if (a.id === b.id) continue;
      const key = edgeKey(a.id, b.id);
      const explicitEdge = explicit.get(key) ?? null;

      if (explicitEdge?.block) continue;

      let derived = false;
      try {
        if (offerSatisfiesWantSpec({ wantSpec: a.want_spec, offerAssets: b.offer })) {
          const getValue = valueOfAssets({ assets: b.offer, assetValuesUsd });
          const min = a.value_band?.min_usd;
          const max = a.value_band?.max_usd;
          const minOk = typeof min !== 'number' || getValue >= min;
          const maxOk = typeof max !== 'number' || getValue <= max;
          derived = minOk && maxOk;
        }
      } catch {
        derived = false;
      }

      const allowedByExplicit = explicitEdge?.allow === true;
      if (!derived && !allowedByExplicit) continue;

      neighbors.push(b.id);
      edgeMeta.set(key, {
        source_intent_id: a.id,
        target_intent_id: b.id,
        derived,
        explicit_allow: allowedByExplicit,
        explicit_prefer_strength: Number(explicitEdge?.prefer_strength ?? 0),
        origin: derived && allowedByExplicit ? 'hybrid' : derived ? 'derived' : 'explicit'
      });
    }
    edges.set(a.id, neighbors);
  }

  return { byId, edges, edgeMeta };
}
