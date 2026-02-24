export function persistSelectedMarketplaceProposals({
  store,
  selected,
  runId,
  cloneValue
}) {
  for (const proposal of selected) {
    store.state.proposals[proposal.id] = cloneValue(proposal);
    store.state.tenancy.proposals[proposal.id] ||= { partner_id: 'marketplace' };
    store.state.marketplace_matching_proposal_runs[proposal.id] = runId;
  }
}

export function buildMarketplaceRunRecord({
  actor,
  runId,
  requestedAt,
  replaceExisting,
  maxProposals,
  activeIntentsCount,
  selected,
  replacedProposalsCount,
  expiredProposalsCount,
  matching
}) {
  return {
    run_id: runId,
    requested_by: {
      type: actor.type,
      id: actor.id
    },
    recorded_at: requestedAt,
    replace_existing: replaceExisting,
    max_proposals: maxProposals,
    active_intents_count: activeIntentsCount,
    selected_proposals_count: selected.length,
    stored_proposals_count: selected.length,
    replaced_proposals_count: replacedProposalsCount,
    expired_proposals_count: expiredProposalsCount,
    proposal_ids: selected.map(proposal => proposal.id),
    stats: {
      intents_active: Number(matching?.stats?.intents_active ?? 0),
      edges: Number(matching?.stats?.edges ?? 0),
      candidate_cycles: Number(matching?.stats?.candidate_cycles ?? 0),
      candidate_proposals: Number(matching?.stats?.candidate_proposals ?? 0),
      selected_proposals: Number(matching?.stats?.selected_proposals ?? 0)
    }
  };
}
