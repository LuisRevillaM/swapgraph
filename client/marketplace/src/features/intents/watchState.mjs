function pluralize(value, singular, plural) {
  return value === 1 ? singular : plural;
}

export function proposalCountsByIntent(proposals = []) {
  const counts = new Map();
  for (const proposal of proposals) {
    const seen = new Set();
    for (const participant of proposal?.participants ?? []) {
      const intentId = String(participant?.intentId ?? '').trim();
      if (!intentId || seen.has(intentId)) continue;
      seen.add(intentId);
      counts.set(intentId, (counts.get(intentId) ?? 0) + 1);
    }
  }
  return counts;
}

export function watchStateForIntent(intent, proposalCount = 0) {
  const status = String(intent?.status ?? 'active');
  if (status === 'cancelled') {
    return {
      kind: 'cancelled',
      tone: 'neutral',
      headline: 'Cancelled',
      detail: 'intent inactive'
    };
  }

  if (proposalCount > 0) {
    return {
      kind: 'matched',
      tone: 'signal',
      headline: 'Matched',
      detail: `${proposalCount} ${pluralize(proposalCount, 'proposal', 'proposals')} waiting`
    };
  }

  return {
    kind: 'watching',
    tone: 'neutral',
    headline: 'Watching',
    detail: 'no matches yet'
  };
}
