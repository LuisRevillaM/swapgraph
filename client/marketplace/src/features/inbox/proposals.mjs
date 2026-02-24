import { formatIsoShort, formatUsd } from '../../utils/format.mjs';
import { actorDisplayLabel, trackAAssetLabel } from '../../pilot/trackATheme.mjs';

function toMs(iso) {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

function sumAssetValues(assets = []) {
  return assets.reduce((sum, asset) => sum + Number(asset?.valueUsd ?? 0), 0);
}

function titleCaseToken(token) {
  return String(token ?? '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')
    .trim();
}

function humanizeAssetId(assetId) {
  const themed = trackAAssetLabel(assetId);
  if (themed) return themed;
  const raw = String(assetId ?? '').trim();
  if (!raw) return 'Unknown item';
  const normalized = raw.replace(/^steam:/, '').replace(/[:/]/g, ' ');
  return titleCaseToken(normalized);
}

function assetLabel(asset) {
  return String(asset?.label ?? '').trim() || humanizeAssetId(asset?.assetId);
}

function wearLabel(asset) {
  const wear = String(asset?.wear ?? '').trim();
  return wear || 'n/a';
}

function actorIdFromIntents(intents = []) {
  for (const intent of intents) {
    const actorId = String(intent?.actor?.id ?? '').trim();
    if (actorId) return actorId;
  }
  return null;
}

function participantForUser({ proposal, intents = [] }) {
  const desiredActorId = actorIdFromIntents(intents);
  const intentById = new Map(
    intents
      .filter(intent => intent?.id)
      .map(intent => [intent.id, intent])
  );

  if (desiredActorId) {
    const byIntent = proposal?.participants?.find(participant => {
      const sourceIntent = intentById.get(participant?.intentId);
      return sourceIntent?.actor?.id === desiredActorId;
    });
    if (byIntent) return byIntent;

    const byActor = proposal?.participants?.find(participant => participant?.actor?.id === desiredActorId);
    if (byActor) return byActor;
  }

  return proposal?.participants?.[0] ?? null;
}

export function urgencyModel(expiresAt, { nowMs = Date.now() } = {}) {
  const expiresMs = toMs(expiresAt);
  if (expiresMs === null) {
    return {
      kind: 'normal',
      order: 1,
      label: 'No deadline',
      expiresInMs: Number.POSITIVE_INFINITY
    };
  }

  const delta = expiresMs - nowMs;
  if (delta <= 0) {
    return {
      kind: 'expired',
      order: 0,
      label: 'Expired',
      expiresInMs: delta
    };
  }

  if (delta <= 60 * 60 * 1000) {
    return {
      kind: 'critical',
      order: 3,
      label: 'Expires <1h',
      expiresInMs: delta
    };
  }

  if (delta <= 6 * 60 * 60 * 1000) {
    return {
      kind: 'soon',
      order: 2,
      label: 'Expiring today',
      expiresInMs: delta
    };
  }

  return {
    kind: 'normal',
    order: 1,
    label: 'Open',
    expiresInMs: delta
  };
}

function rankingScore({ proposal, urgency, valueDeltaUsd }) {
  const confidence = Number(proposal?.confidenceScore ?? 0);
  const urgencyBonus = urgency.order * 2_000;
  return Math.round(confidence * 10_000) + urgencyBonus + Math.round(valueDeltaUsd * 10);
}

export function buildProposalCardModel({ proposal, intents = [], nowMs = Date.now(), rank = 1 }) {
  const participant = participantForUser({ proposal, intents });
  const giveAsset = participant?.give?.[0] ?? null;
  const getAsset = participant?.get?.[0] ?? null;

  const giveTotal = sumAssetValues(participant?.give ?? []);
  const getTotal = sumAssetValues(participant?.get ?? []);
  const valueDeltaUsd = Number((getTotal - giveTotal).toFixed(2));
  const confidencePercent = Math.round(Number(proposal?.confidenceScore ?? 0) * 100);
  const urgency = urgencyModel(proposal?.expiresAt, { nowMs });
  const participantCount = Array.isArray(proposal?.participants) ? proposal.participants.length : 0;
  const cycleType = participantCount <= 2 ? 'direct swap' : `${participantCount}-way cycle`;
  const explainability = Array.isArray(proposal?.explainability) ? proposal.explainability : [];

  return {
    proposalId: proposal?.id ?? '',
    rank,
    giveName: assetLabel(giveAsset),
    giveMeta: `${wearLabel(giveAsset)} · ${formatUsd(giveTotal)}`,
    getName: assetLabel(getAsset),
    getMeta: `${wearLabel(getAsset)} · ${formatUsd(getTotal)}`,
    confidencePercent,
    valueDeltaUsd,
    valueDeltaLabel: `${valueDeltaUsd >= 0 ? '+' : ''}${formatUsd(valueDeltaUsd)}`,
    cycleType,
    expiresAt: proposal?.expiresAt ?? null,
    expiresAtLabel: formatIsoShort(proposal?.expiresAt),
    urgencyKind: urgency.kind,
    urgencyLabel: urgency.label,
    urgencyOrder: urgency.order,
    expiresInMs: urgency.expiresInMs,
    explainabilitySummary: explainability.slice(0, 2),
    score: rankingScore({ proposal, urgency, valueDeltaUsd })
  };
}

export function rankInboxCards({ proposals = [], intents = [], nowMs = Date.now() }) {
  const cards = proposals
    .map(proposal => buildProposalCardModel({ proposal, intents, nowMs }))
    .sort((left, right) => {
      if (left.urgencyOrder !== right.urgencyOrder) return right.urgencyOrder - left.urgencyOrder;
      if (left.score !== right.score) return right.score - left.score;
      if (left.expiresInMs !== right.expiresInMs) return left.expiresInMs - right.expiresInMs;
      return String(left.proposalId).localeCompare(String(right.proposalId));
    })
    .map((card, index) => ({
      ...card,
      rank: index + 1
    }));

  const priority = cards.filter(card => card.urgencyKind === 'critical' || card.urgencyKind === 'soon');
  const ranked = cards.filter(card => card.urgencyKind === 'normal' || card.urgencyKind === 'expired');

  return {
    cards,
    sections: {
      priority,
      ranked
    },
    stats: {
      totalCount: cards.length,
      urgentCount: priority.length
    }
  };
}

function actorLabel(actorId, userActorId) {
  return actorDisplayLabel({
    actorId,
    viewerActorId: userActorId,
    includeAtFallback: true
  });
}

export function buildProposalDetailModel({ proposal, intents = [], nowMs = Date.now() }) {
  const card = buildProposalCardModel({ proposal, intents, nowMs });
  const participant = participantForUser({ proposal, intents });
  const userActorId = actorIdFromIntents(intents);

  const cycleNodes = (proposal?.participants ?? []).map((entry, index) => {
    const actorId = String(entry?.actor?.id ?? '').trim();
    const giveAsset = entry?.give?.[0] ?? null;
    return {
      id: `${actorId || 'unknown'}_${index}`,
      actorLabel: actorLabel(actorId, userActorId),
      giveLabel: assetLabel(giveAsset),
      isUser: actorId && userActorId ? actorId === userActorId : index === 0
    };
  });

  const valueDeltaText = card.valueDeltaUsd >= 0
    ? `You gain ${card.valueDeltaLabel} in estimated value.`
    : `You trade ${card.valueDeltaLabel} in estimated value for match speed.`;

  const confidenceText = `${card.confidencePercent}% confidence based on current cycle compatibility and reliability signals.`;

  const constraintFitText = Array.isArray(proposal?.explainability) && proposal.explainability.length > 0
    ? `Matched constraints: ${proposal.explainability.join(', ')}.`
    : 'Matched constraints fit your standing intent preferences.';

  return {
    proposalId: card.proposalId,
    card,
    hero: {
      giveName: card.giveName,
      giveMeta: card.giveMeta,
      getName: card.getName,
      getMeta: card.getMeta
    },
    cycleNodes,
    explanationCards: [
      {
        key: 'value_delta',
        title: 'Value delta',
        body: valueDeltaText
      },
      {
        key: 'confidence',
        title: `Confidence · ${card.confidencePercent}%`,
        body: confidenceText
      },
      {
        key: 'constraint_fit',
        title: 'Constraint fit',
        body: constraintFitText
      }
    ],
    participant,
    cycleType: card.cycleType,
    urgencyLabel: card.urgencyLabel
  };
}
