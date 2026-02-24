function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export function normalizePushPayload(rawPayload = {}) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null;

  const rawType = stringOrNull(rawPayload.type)
    ?? stringOrNull(rawPayload.kind)
    ?? stringOrNull(rawPayload.notification_type)
    ?? '';
  const type = rawType.toLowerCase();

  const proposalId = stringOrNull(rawPayload.proposal_id) ?? stringOrNull(rawPayload.proposalId);
  const cycleId = stringOrNull(rawPayload.cycle_id) ?? stringOrNull(rawPayload.cycleId);
  const receiptId = stringOrNull(rawPayload.receipt_id) ?? stringOrNull(rawPayload.receiptId);

  if (type.includes('proposal')) {
    if (!proposalId) return null;
    return {
      kind: 'proposal',
      channel: 'proposal',
      proposalId,
      cycleId: cycleId ?? null,
      receiptId: null
    };
  }

  if (type.includes('active') || type.includes('settlement') || type.includes('timeline')) {
    if (!cycleId) return null;
    return {
      kind: 'active',
      channel: 'active',
      proposalId: null,
      cycleId,
      receiptId: null
    };
  }

  if (type.includes('receipt')) {
    const resolvedCycleId = cycleId ?? receiptId;
    if (!resolvedCycleId) return null;
    return {
      kind: 'receipt',
      channel: 'receipt',
      proposalId: null,
      cycleId: resolvedCycleId,
      receiptId: receiptId ?? resolvedCycleId
    };
  }

  return null;
}

export function routeForPushPayload(payload) {
  const normalized = normalizePushPayload(payload);
  if (!normalized) return null;

  if (normalized.kind === 'proposal') {
    return { tab: 'inbox', params: { proposalId: normalized.proposalId } };
  }
  if (normalized.kind === 'active') {
    return { tab: 'active', params: { cycleId: normalized.cycleId } };
  }
  if (normalized.kind === 'receipt') {
    return { tab: 'receipts', params: { receiptId: normalized.cycleId } };
  }
  return null;
}

