const WEAR_OPTIONS = Object.freeze(['FN', 'MW', 'FT', 'WW', 'BS']);
const VALUE_TOLERANCE_OPTIONS = Object.freeze([20, 50, 100, 200]);
const MAX_CYCLE_LENGTH_OPTIONS = Object.freeze([2, 3, 4]);

function toPositiveNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function nearestTolerance(value) {
  const numeric = toPositiveNumber(value);
  if (!Number.isFinite(numeric)) return VALUE_TOLERANCE_OPTIONS[1];
  let best = VALUE_TOLERANCE_OPTIONS[0];
  let bestDelta = Math.abs(best - numeric);
  for (const option of VALUE_TOLERANCE_OPTIONS) {
    const delta = Math.abs(option - numeric);
    if (delta < bestDelta) {
      best = option;
      bestDelta = delta;
    }
  }
  return best;
}

function ensureWearArray(value) {
  if (Array.isArray(value)) return value.map(x => String(x).trim().toUpperCase()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,\s/]+/)
      .map(x => x.trim().toUpperCase())
      .filter(Boolean);
  }
  return [];
}

export function composerWearOptions() {
  return WEAR_OPTIONS.slice();
}

export function composerValueToleranceOptions() {
  return VALUE_TOLERANCE_OPTIONS.slice();
}

export function composerMaxCycleLengthOptions() {
  return MAX_CYCLE_LENGTH_OPTIONS.slice();
}

export function defaultComposerDraft(overrides = {}) {
  return {
    offeringAssetId: '',
    offerValueUsd: 120,
    wantCategory: '',
    acceptableWear: ['MW', 'FT'],
    valueToleranceUsd: 50,
    maxCycleLength: 3,
    requireEscrow: true,
    ...overrides
  };
}

export function normalizeComposerInput(input = {}) {
  return {
    offeringAssetId: String(input.offeringAssetId ?? input.offering_asset_id ?? '').trim(),
    offerValueUsd: toPositiveNumber(input.offerValueUsd ?? input.offer_value_usd),
    wantCategory: String(input.wantCategory ?? input.want_category ?? '').trim(),
    acceptableWear: ensureWearArray(input.acceptableWear ?? input.acceptable_wear),
    valueToleranceUsd: Number.parseInt(String(input.valueToleranceUsd ?? input.value_tolerance_usd ?? ''), 10),
    maxCycleLength: Number.parseInt(String(input.maxCycleLength ?? input.max_cycle_length ?? ''), 10),
    requireEscrow: input.requireEscrow === undefined
      ? true
      : (String(input.requireEscrow).toLowerCase() !== 'false')
  };
}

export function validateComposerDraft(input = {}) {
  const draft = normalizeComposerInput(input);
  const errors = {};

  if (!draft.offeringAssetId) {
    errors.offeringAssetId = 'Offering is required.';
  }

  if (!Number.isFinite(draft.offerValueUsd) || draft.offerValueUsd <= 0) {
    errors.offerValueUsd = 'Offer value must be a positive amount.';
  }

  if (!draft.wantCategory || draft.wantCategory.length < 2) {
    errors.wantCategory = 'Want target is required.';
  }

  if (draft.acceptableWear.length === 0) {
    errors.acceptableWear = 'Select at least one wear tier.';
  } else {
    const invalidWear = draft.acceptableWear.filter(value => !WEAR_OPTIONS.includes(value));
    if (invalidWear.length > 0) {
      errors.acceptableWear = `Unsupported wear tier: ${invalidWear.join(', ')}`;
    }
  }

  if (!VALUE_TOLERANCE_OPTIONS.includes(draft.valueToleranceUsd)) {
    errors.valueToleranceUsd = 'Choose a supported value tolerance.';
  }

  if (!MAX_CYCLE_LENGTH_OPTIONS.includes(draft.maxCycleLength)) {
    errors.maxCycleLength = 'Choose a supported max cycle length.';
  }

  return {
    ok: Object.keys(errors).length === 0,
    draft,
    errors
  };
}

function generateIntentId() {
  return `intent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildIntentFromComposerDraft({
  input,
  actorId,
  existingIntentId = null,
  now = () => Date.now()
}) {
  const validation = validateComposerDraft(input);
  if (!validation.ok) return { ok: false, errors: validation.errors, intent: null };

  const draft = validation.draft;
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + (30 * 24 * 60 * 60 * 1000)).toISOString();
  const tolerance = draft.valueToleranceUsd;
  const valueUsd = Number(draft.offerValueUsd.toFixed(2));
  const intentId = existingIntentId || generateIntentId();
  const wearLabel = draft.acceptableWear.join('/');

  return {
    ok: true,
    errors: {},
    intent: {
      id: intentId,
      actor: {
        type: 'user',
        id: actorId
      },
      offer: [
        {
          platform: 'steam',
          app_id: 730,
          context_id: 2,
          asset_id: draft.offeringAssetId,
          class_id: `cls_${draft.offeringAssetId}`,
          instance_id: '0',
          metadata: {
            value_usd: valueUsd,
            wear: wearLabel,
            label: draft.offeringAssetId
          },
          proof: {
            inventory_snapshot_id: `snap_${draft.offeringAssetId}`,
            verified_at: nowIso
          }
        }
      ],
      want_spec: {
        type: 'set',
        any_of: [
          {
            type: 'category',
            platform: 'steam',
            app_id: 730,
            category: draft.wantCategory,
            constraints: {
              acceptable_wear: draft.acceptableWear
            }
          }
        ]
      },
      value_band: {
        min_usd: Math.max(0, Number((valueUsd - tolerance).toFixed(2))),
        max_usd: Number((valueUsd + tolerance).toFixed(2)),
        pricing_source: 'market_median'
      },
      trust_constraints: {
        max_cycle_length: draft.maxCycleLength,
        min_counterparty_reliability: 0
      },
      time_constraints: {
        expires_at: expiresAt,
        urgency: 'normal'
      },
      settlement_preferences: {
        require_escrow: draft.requireEscrow
      }
    }
  };
}

function readWantLabel(wantSpec) {
  const clause = Array.isArray(wantSpec?.anyOf) ? wantSpec.anyOf[0] : null;
  if (!clause) return '';
  if (clause.type === 'category') return String(clause.category ?? '').trim();
  if (clause.type === 'specific_asset') return String(clause.assetKey ?? '').trim();
  return '';
}

function readWearFromIntent(intent) {
  const categoryConstraint = intent?.wantSpec?.anyOf?.find(clause => clause?.type === 'category');
  const constrainedWear = ensureWearArray(categoryConstraint?.constraints?.acceptable_wear);
  if (constrainedWear.length > 0) return constrainedWear;

  const offerWear = String(intent?.offer?.[0]?.wear ?? '').trim();
  if (offerWear) return ensureWearArray(offerWear);

  return ['MW'];
}

export function composerDraftFromIntent(intent) {
  const tolerance = Math.max(
    0,
    Number(intent?.valueBand?.maxUsd ?? 0) - Number(intent?.valueBand?.minUsd ?? 0)
  ) / 2;

  return defaultComposerDraft({
    offeringAssetId: intent?.offer?.[0]?.assetId ?? '',
    offerValueUsd: Number(intent?.offer?.[0]?.valueUsd ?? 0) || 120,
    wantCategory: readWantLabel(intent?.wantSpec),
    acceptableWear: readWearFromIntent(intent),
    valueToleranceUsd: nearestTolerance(tolerance),
    maxCycleLength: MAX_CYCLE_LENGTH_OPTIONS.includes(intent?.trustConstraints?.maxCycleLength)
      ? intent.trustConstraints.maxCycleLength
      : 3,
    requireEscrow: intent?.settlementPreferences?.requireEscrow !== false
  });
}
