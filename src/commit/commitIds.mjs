import crypto from 'node:crypto';

export function commitIdForProposalId(proposalId) {
  const h = crypto.createHash('sha256').update(`commit|${proposalId}`).digest('hex').slice(0, 12);
  return `commit_${h}`;
}
