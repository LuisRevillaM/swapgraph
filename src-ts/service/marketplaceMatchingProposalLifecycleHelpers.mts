import { commitIdForProposalId } from '../../src/commit/commitIds.mjs';
import { parseIsoMs } from './marketplaceMatchingRequestHelpers.mts';

export function proposalInUse({ store, proposalId }) {
  const commitId = commitIdForProposalId(proposalId);
  if (store.state?.commits?.[commitId]) return true;
  if (store.state?.timelines?.[proposalId]) return true;
  if (Object.values(store.state?.receipts ?? {}).some(receipt => receipt?.cycle_id === proposalId)) return true;
  if (Object.values(store.state?.reservations ?? {}).some(reservation => reservation?.cycle_id === proposalId)) return true;
  return false;
}

export function expireMarketplaceProposals({ store, nowIso }) {
  const nowMs = parseIsoMs(nowIso) ?? Date.now();
  let expired = 0;

  for (const proposalId of Object.keys(store.state.marketplace_matching_proposal_runs ?? {})) {
    const proposal = store.state.proposals?.[proposalId] ?? null;
    if (!proposal) {
      delete store.state.marketplace_matching_proposal_runs[proposalId];
      continue;
    }

    const expiresMs = parseIsoMs(proposal?.expires_at);
    if (expiresMs === null || expiresMs > nowMs) continue;
    if (proposalInUse({ store, proposalId })) continue;

    delete store.state.proposals[proposalId];
    if (store.state.tenancy?.proposals) delete store.state.tenancy.proposals[proposalId];
    delete store.state.marketplace_matching_proposal_runs[proposalId];
    expired += 1;
  }

  return expired;
}

export function replaceMarketplaceProposals({ store }) {
  let replaced = 0;

  for (const proposalId of Object.keys(store.state.marketplace_matching_proposal_runs ?? {})) {
    if (proposalInUse({ store, proposalId })) continue;
    delete store.state.proposals[proposalId];
    if (store.state.tenancy?.proposals) delete store.state.tenancy.proposals[proposalId];
    delete store.state.marketplace_matching_proposal_runs[proposalId];
    replaced += 1;
  }

  return replaced;
}
