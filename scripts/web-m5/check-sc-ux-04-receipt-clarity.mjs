#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRouteHash, parseHashRoute } from '../../client/marketplace/src/routing/router.mjs';
import { renderTabScreen } from '../../client/marketplace/src/ui/screens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m5/sc-ux-04-receipt-clarity-report.json');

function baseState() {
  return {
    session: { actorId: 'user_1' },
    route: { tab: 'receipts', path: '/receipts', params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', targetIntentId: null, draft: null, errors: {}, submitting: false },
      intentMutations: {},
      proposalMutations: {},
      activeMutations: {}
    },
    caches: {
      health: { value: null, updatedAt: 0 },
      inventoryAwakening: { value: null, updatedAt: 0 },
      intents: { items: [], updatedAt: 0 },
      proposals: { items: [], updatedAt: 0 },
      matchingRuns: {},
      timeline: {
        cycle_completed: {
          value: {
            cycleId: 'cycle_completed',
            state: 'completed',
            updatedAt: '2026-02-24T11:00:00.000Z',
            legs: [
              {
                legId: 'leg_1',
                fromActor: { type: 'user', id: 'user_1' },
                toActor: { type: 'user', id: 'user_2' },
                assets: [{ assetId: 'asset_1', valueUsd: 120 }]
              },
              {
                legId: 'leg_2',
                fromActor: { type: 'user', id: 'user_2' },
                toActor: { type: 'user', id: 'user_1' },
                assets: [{ assetId: 'asset_2', valueUsd: 130 }]
              }
            ]
          },
          updatedAt: Date.now()
        },
        cycle_unwound: {
          value: {
            cycleId: 'cycle_unwound',
            state: 'failed',
            updatedAt: '2026-02-24T12:00:00.000Z',
            legs: [
              {
                legId: 'leg_3',
                fromActor: { type: 'user', id: 'user_1' },
                toActor: { type: 'user', id: 'user_3' },
                assets: [{ assetId: 'asset_3', valueUsd: 95 }]
              },
              {
                legId: 'leg_4',
                fromActor: { type: 'user', id: 'user_3' },
                toActor: { type: 'user', id: 'user_1' },
                assets: [{ assetId: 'asset_4', valueUsd: 95 }]
              }
            ]
          },
          updatedAt: Date.now()
        }
      },
      receipts: {
        cycle_completed: {
          value: {
            id: 'receipt_completed',
            cycleId: 'cycle_completed',
            finalState: 'completed',
            createdAt: '2026-02-24T11:00:00.000Z',
            intentIds: ['intent_1', 'intent_2'],
            assetIds: ['asset_1', 'asset_2'],
            fees: [{ actor: { type: 'user', id: 'user_1' }, feeUsd: 1 }],
            liquidityProviderSummary: [],
            signature: { keyId: 'dev-k1', algorithm: 'ed25519', signature: 'abc123' },
            transparency: {}
          },
          updatedAt: Date.now()
        },
        cycle_unwound: {
          value: {
            id: 'receipt_unwound',
            cycleId: 'cycle_unwound',
            finalState: 'failed',
            createdAt: '2026-02-24T12:00:00.000Z',
            intentIds: ['intent_3', 'intent_4'],
            assetIds: ['asset_3', 'asset_4'],
            fees: [],
            liquidityProviderSummary: [],
            signature: { keyId: 'dev-k1', algorithm: 'ed25519', signature: 'def456' },
            transparency: { reasonCode: 'deposit_timeout' }
          },
          updatedAt: Date.now()
        },
        cycle_failed: {
          value: {
            id: 'receipt_failed',
            cycleId: 'cycle_failed',
            finalState: 'failed',
            createdAt: '2026-02-24T10:00:00.000Z',
            intentIds: ['intent_5'],
            assetIds: ['asset_5'],
            fees: [],
            liquidityProviderSummary: [],
            signature: { keyId: '', algorithm: '', signature: '' },
            transparency: { reasonCode: 'execution_error' }
          },
          updatedAt: Date.now()
        }
      }
    }
  };
}

function runRenderChecklist() {
  const listState = baseState();
  const listHtml = renderTabScreen(listState);

  const detailState = baseState();
  detailState.route.params = { receiptId: 'cycle_unwound' };
  const detailHtml = renderTabScreen(detailState);

  const failedDetailState = baseState();
  failedDetailState.route.params = { receiptId: 'cycle_failed' };
  const failedDetailHtml = renderTabScreen(failedDetailState);

  const checklist = [
    {
      id: 'receipt_list_renders_cards',
      pass: /Verified Records/.test(listHtml) && /data-action="receipts.openReceipt"/.test(listHtml)
    },
    {
      id: 'receipt_status_variants_present',
      pass: /Completed/.test(listHtml) && /Unwound/.test(listHtml) && /Failed/.test(listHtml)
    },
    {
      id: 'metadata_completeness_present',
      pass: /Type/.test(listHtml) && /Verification/.test(listHtml) && /Value delta/.test(listHtml)
    },
    {
      id: 'detail_verification_section_present',
      pass: /Verification metadata/.test(detailHtml) && /Signature bytes/.test(detailHtml)
    },
    {
      id: 'detail_value_outcome_context_present',
      pass: /Value outcome context/.test(detailHtml) && /Counterparty timeout/.test(detailHtml)
    },
    {
      id: 'failure_reason_surface_present',
      pass: /execution_error/.test(failedDetailHtml)
    },
    {
      id: 'detail_back_navigation_present',
      pass: /data-action="receipt.backToList"/.test(detailHtml)
    }
  ];

  return {
    checklist,
    pass: checklist.every(row => row.pass)
  };
}

function runNavigationCheck() {
  const hash = buildRouteHash({ tab: 'receipts', params: { receiptId: 'cycle_unwound' } });
  const parsed = parseHashRoute(hash);
  return {
    hash,
    parsed,
    pass: hash === '#/receipts/cycle_unwound'
      && parsed.tab === 'receipts'
      && parsed.params?.receiptId === 'cycle_unwound'
      && parsed.deepLinkKind === 'receipt'
  };
}

function main() {
  const render = runRenderChecklist();
  const navigation = runNavigationCheck();

  const output = {
    check_id: 'SC-UX-04',
    generated_at: new Date().toISOString(),
    render,
    navigation,
    pass: render.pass && navigation.pass
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
