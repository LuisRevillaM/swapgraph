import { verifyEventSignatureWithPublicKeyPem } from '../crypto/eventSigning.mjs';

function requirePartner(actor) {
  if (actor?.type !== 'partner' || !actor.id) {
    throw new Error(`partner actor is required (got ${JSON.stringify(actor)})`);
  }
}

function ensureStoreShape(store) {
  store.state.proposals ||= {};
  store.state.tenancy ||= {};
  store.state.tenancy.proposals ||= {};

  // Webhook ingestion book-keeping (persisted dedupe).
  store.state.delivery ||= {};
  store.state.delivery.webhook_seen_event_ids ||= {};
}

function ingestProposal({ store, proposal, partnerId }) {
  if (!proposal?.id) throw new Error('proposal.id is required');
  store.state.proposals[proposal.id] = proposal;
  store.state.tenancy.proposals[proposal.id] = { partner_id: partnerId };
}

function loadSeenEventIdsFromStore(store) {
  const ids = Object.keys(store?.state?.delivery?.webhook_seen_event_ids ?? {});
  return new Set(ids);
}

function persistSeenEventIdsToStore(store, seen) {
  const out = {};
  for (const id of seen) out[id] = true;
  store.state.delivery.webhook_seen_event_ids = out;
}

function findKeyForEvent({ keySet, evt }) {
  const keyId = evt?.signature?.key_id;
  const keys = keySet?.keys ?? [];
  if (!Array.isArray(keys)) return null;
  return keys.find(k => k?.key_id === keyId) ?? null;
}

function verifyEventSignature({ evt, keySet }) {
  if (!evt?.signature) return { ok: false, error: 'missing_signature' };

  const k = findKeyForEvent({ keySet, evt });
  if (!k) return { ok: false, error: 'unknown_key_id', details: { key_id: evt?.signature?.key_id ?? null } };

  return verifyEventSignatureWithPublicKeyPem({
    envelope: evt,
    publicKeyPem: k.public_key_pem,
    keyId: k.key_id,
    alg: k.alg
  });
}

/**
 * Ingest polling `GET /cycle-proposals` responses.
 * @param {{ store: any, actor: {type:string,id:string}, pollingResponse: {proposals:any[]} }} opts
 */
export function ingestPollingResponse({ store, actor, pollingResponse }) {
  requirePartner(actor);
  ensureStoreShape(store);

  const proposals = pollingResponse?.proposals ?? [];
  let stored = 0;
  for (const p of proposals) {
    ingestProposal({ store, proposal: p, partnerId: actor.id });
    stored++;
  }

  return {
    ok: true,
    stats: {
      proposals_total: proposals.length,
      proposals_stored: stored
    }
  };
}

/**
 * Ingest webhook events (dedupe by event_id).
 * Only `proposal.created` is applied in v1.
 *
 * Hardening (v1 fixtures-first):
 * - verify `EventEnvelope.signature` before applying
 * - persist dedupe state in `store.state.delivery.webhook_seen_event_ids`
 *
 * @param {{ store: any, events: any[], keySet: any, seenEventIds?: Set<string> }} opts
 */
export function ingestWebhookEvents({ store, events, keySet, seenEventIds }) {
  ensureStoreShape(store);

  if (!keySet) {
    throw new Error('keySet is required for webhook signature verification');
  }

  // Merge caller-provided state with persisted store state.
  const seen = loadSeenEventIdsFromStore(store);
  for (const id of (seenEventIds ?? [])) seen.add(id);

  const invalid_signatures = [];

  const stats = {
    events_total: (events ?? []).length,
    events_new_unique: 0,
    events_duplicates: 0,
    events_invalid_signature: 0,
    events_applied: 0,
    events_ignored: 0
  };

  for (const evt of events ?? []) {
    if (!evt?.event_id) throw new Error('event_id is required');

    if (seen.has(evt.event_id)) {
      stats.events_duplicates++;
      continue;
    }

    const sig = verifyEventSignature({ evt, keySet });
    if (!sig.ok) {
      stats.events_invalid_signature++;
      invalid_signatures.push({ event_id: evt.event_id, type: evt.type, error: sig.error ?? 'bad_signature', details: sig.details ?? null });
      continue;
    }

    // Only mark as seen after signature verification succeeds.
    seen.add(evt.event_id);
    stats.events_new_unique++;

    if (evt.type === 'proposal.created') {
      requirePartner(evt.actor);
      const proposal = evt.payload?.proposal;
      ingestProposal({ store, proposal, partnerId: evt.actor.id });
      stats.events_applied++;
      continue;
    }

    stats.events_ignored++;
  }

  persistSeenEventIdsToStore(store, seen);

  return { ok: invalid_signatures.length === 0, stats, invalid_signatures, seenEventIds: seen };
}
