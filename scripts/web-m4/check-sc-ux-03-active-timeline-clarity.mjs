#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildActiveTimelineModel } from '../../client/marketplace/src/features/active/timeline.mjs';
import { renderTabScreen } from '../../client/marketplace/src/ui/screens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m4/sc-ux-03-active-timeline-clarity-report.json');

const COVERED_STATES = ['accepted', 'escrow.pending', 'escrow.ready', 'executing', 'completed', 'failed'];

function timelineForState(state) {
  const base = {
    cycleId: `cycle_${state.replace('.', '_')}`,
    state,
    updatedAt: '2026-02-24T10:00:00.000Z',
    legs: [
      {
        legId: 'leg_user',
        intentId: 'intent_user',
        fromActor: { type: 'user', id: 'user_1' },
        toActor: { type: 'user', id: 'user_2' },
        assets: [{ assetId: 'asset_a', valueUsd: 110 }],
        status: 'pending',
        depositDeadlineAt: '2026-02-24T18:00:00.000Z',
        depositMode: 'deposit'
      },
      {
        legId: 'leg_other',
        intentId: 'intent_other',
        fromActor: { type: 'user', id: 'user_2' },
        toActor: { type: 'user', id: 'user_1' },
        assets: [{ assetId: 'asset_b', valueUsd: 109 }],
        status: 'pending',
        depositDeadlineAt: '2026-02-24T18:00:00.000Z',
        depositMode: 'deposit'
      }
    ]
  };

  if (state === 'escrow.ready' || state === 'executing') {
    base.legs[0].status = 'deposited';
    base.legs[1].status = 'deposited';
  }

  if (state === 'completed') {
    base.legs[0].status = 'released';
    base.legs[1].status = 'released';
  }

  if (state === 'failed') {
    base.legs[0].status = 'refunded';
    base.legs[1].status = 'deposited';
  }

  return base;
}

function renderStateBase() {
  return {
    session: { actorId: 'user_1' },
    route: { tab: 'active', path: '/active/cycle/cycle_escrow_pending', params: { cycleId: 'cycle_escrow_pending' } },
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
      intents: { items: [{ id: 'intent_user', actor: { type: 'user', id: 'user_1' } }], updatedAt: 0 },
      proposals: { items: [], updatedAt: 0 },
      matchingRuns: {},
      timeline: {
        cycle_escrow_pending: {
          value: timelineForState('escrow.pending'),
          updatedAt: Date.now()
        }
      },
      receipts: {}
    }
  };
}

function runStateChecklist() {
  return COVERED_STATES.map(state => {
    const model = buildActiveTimelineModel({
      timeline: timelineForState(state),
      viewerActorIdHint: 'user_1',
      intents: [{ actor: { id: 'user_1' } }],
      nowMs: Date.parse('2026-02-24T11:00:00.000Z')
    });

    const hasWaitReason = Boolean(model?.statusHeadline) && Boolean(model?.statusDetail);
    const hasActionOrWaitReason = Boolean(model?.actions?.some(action => action.enabled)) || hasWaitReason;
    const allDisabledActionsExplainWhy = (model?.actions ?? []).every(action => action.enabled || Boolean(action.reason));

    return {
      state,
      wait_reason_code: model?.waitReasonCode ?? null,
      has_wait_reason: hasWaitReason,
      has_action_or_wait_reason: hasActionOrWaitReason,
      disabled_actions_explained: allDisabledActionsExplainWhy,
      pass: Boolean(model) && hasWaitReason && hasActionOrWaitReason && allDisabledActionsExplainWhy
    };
  });
}

function runRenderChecklist() {
  const html = renderTabScreen(renderStateBase());
  const checklist = [
    {
      id: 'active_header_present',
      pass: /Settlement Timeline/.test(html) && /cycle_escrow_pending/.test(html)
    },
    {
      id: 'progress_indicator_present',
      pass: /active-progress-bar/.test(html)
    },
    {
      id: 'wait_reason_visible',
      pass: /Your deposit is required/.test(html)
    },
    {
      id: 'actions_state_aware',
      pass: /data-action="active\.confirmDeposit"/.test(html) && /data-action="active\.beginExecution"/.test(html)
    },
    {
      id: 'timeline_events_ordered',
      pass: /Timeline events/.test(html) && /active-event/.test(html)
    }
  ];

  return {
    checklist,
    pass: checklist.every(row => row.pass)
  };
}

function main() {
  const states = runStateChecklist();
  const render = runRenderChecklist();

  const output = {
    check_id: 'SC-UX-03',
    generated_at: new Date().toISOString(),
    states_covered: states.length,
    state_rows: states,
    render,
    pass: states.every(row => row.pass) && render.pass
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
