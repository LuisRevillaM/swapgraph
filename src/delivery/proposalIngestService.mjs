function requirePartner(actor) {
  if (actor?.type !== 'partner' || !actor.id) {
    throw new Error(`partner actor is required (got ${JSON.stringify(actor)})`);
  }
}

function ensureStoreShape(store) {
  store.state.proposals ||= {};
  store.state.tenancy ||= {};
  store.state.tenancy.proposals ||= {};
}

function ingestProposal({ store, proposal, partnerId }) {
  if (!proposal?.id) throw new Error('proposal.id is required');
  store.state.proposals[proposal.id] = proposal;
  store.state.tenancy.proposals[proposal.id] = { partner_id: partnerId };
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
 * @param {{ store: any, events: any[], seenEventIds?: Set<string> }} opts
 */
export function ingestWebhookEvents({ store, events, seenEventIds }) {
  ensureStoreShape(store);

  const seen = seenEventIds ?? new Set();

  const stats = {
    events_total: (events ?? []).length,
    events_new_unique: 0,
    events_duplicates: 0,
    events_applied: 0,
    events_ignored: 0
  };

  for (const evt of events ?? []) {
    if (!evt?.event_id) throw new Error('event_id is required');

    if (seen.has(evt.event_id)) {
      stats.events_duplicates++;
      continue;
    }
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

  return { ok: true, stats, seenEventIds: seen };
}
