#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizePushPayload, routeForPushPayload } from '../../client/marketplace/src/features/notifications/pushRouting.mjs';
import { buildRouteHash, parseHashRoute } from '../../client/marketplace/src/routing/router.mjs';
import { loadOrCreateActorId } from '../../client/marketplace/src/session/actorIdentity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m6/sc-ux-06-route-recovery-report.json');

function createMemoryStorage(initial = {}) {
  const state = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return state.has(key) ? state.get(key) : null;
    },
    setItem(key, value) {
      state.set(key, String(value));
    }
  };
}

function main() {
  const routeInbox = parseHashRoute('#/inbox/proposal/proposal_123');
  const routeActive = parseHashRoute('#/active/cycle/cycle_77');
  const routeReceipt = parseHashRoute('#/receipts/receipt_88');

  const routeCases = [
    {
      id: 'deep_link_parse_inbox_proposal',
      pass: routeInbox.tab === 'inbox' && routeInbox.params.proposalId === 'proposal_123'
    },
    {
      id: 'deep_link_parse_active_cycle',
      pass: routeActive.tab === 'active' && routeActive.params.cycleId === 'cycle_77'
    },
    {
      id: 'deep_link_parse_receipt',
      pass: routeReceipt.tab === 'receipts' && routeReceipt.params.receiptId === 'receipt_88'
    },
    {
      id: 'hash_round_trip_preserves_routes',
      pass: buildRouteHash({ tab: 'inbox', params: { proposalId: routeInbox.params.proposalId } }) === '#/inbox/proposal/proposal_123'
        && buildRouteHash({ tab: 'active', params: { cycleId: routeActive.params.cycleId } }) === '#/active/cycle/cycle_77'
        && buildRouteHash({ tab: 'receipts', params: { receiptId: routeReceipt.params.receiptId } }) === '#/receipts/receipt_88'
    }
  ];

  const proposalPush = normalizePushPayload({ type: 'proposal.available', proposal_id: 'proposal_123' });
  const activePush = normalizePushPayload({ notification_type: 'active.swap.update', cycle_id: 'cycle_77' });
  const receiptPush = normalizePushPayload({ kind: 'receipt.ready', receipt_id: 'receipt_88' });

  const pushCases = [
    {
      id: 'push_payload_maps_to_routes',
      pass: routeForPushPayload(proposalPush)?.tab === 'inbox'
        && routeForPushPayload(activePush)?.tab === 'active'
        && routeForPushPayload(receiptPush)?.tab === 'receipts'
    }
  ];

  const storage = createMemoryStorage({ 'swapgraph.marketplace.actor_id': 'web_user_saved' });
  const actorFromQuery = loadOrCreateActorId({ storage, locationSearch: '?actor_id=u3' });
  const actorFromStorage = loadOrCreateActorId({ storage, locationSearch: '' });
  const invalidFallback = loadOrCreateActorId({ storage: createMemoryStorage(), locationSearch: '?actor_id=bad%20id' });

  const authCases = [
    {
      id: 'reauth_query_actor_preserved',
      pass: actorFromQuery === 'u3' && actorFromStorage === 'u3'
    },
    {
      id: 'invalid_actor_query_has_safe_fallback',
      pass: /^web_user_/.test(invalidFallback)
    }
  ];

  const checklist = [...routeCases, ...pushCases, ...authCases];
  const output = {
    check_id: 'SC-UX-06',
    generated_at: new Date().toISOString(),
    checklist,
    pass: checklist.every(row => row.pass)
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  if (!output.pass) {
    process.stderr.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
