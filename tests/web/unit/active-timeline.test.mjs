import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActiveTimelineModel, inferViewerActorId } from '../../../client/marketplace/src/features/active/timeline.mjs';

function sampleLeg({ legId, fromId, toId, status, deadline }) {
  return {
    legId,
    intentId: `${legId}_intent`,
    fromActor: { type: 'user', id: fromId },
    toActor: { type: 'user', id: toId },
    assets: [{ assetId: `${legId}_asset`, valueUsd: 100 }],
    status,
    depositDeadlineAt: deadline,
    depositMode: 'deposit'
  };
}

function sampleTimeline({
  state = 'escrow.pending',
  viewerLegStatus = 'pending',
  counterpartyLegStatus = 'pending'
} = {}) {
  return {
    cycleId: 'cycle_1',
    state,
    updatedAt: '2026-02-24T10:00:00.000Z',
    legs: [
      sampleLeg({
        legId: 'leg_user',
        fromId: 'user_1',
        toId: 'user_2',
        status: viewerLegStatus,
        deadline: '2026-02-24T18:00:00.000Z'
      }),
      sampleLeg({
        legId: 'leg_other',
        fromId: 'user_2',
        toId: 'user_1',
        status: counterpartyLegStatus,
        deadline: '2026-02-24T20:00:00.000Z'
      })
    ]
  };
}

test('active timeline model shows deposit required when viewer leg is pending', () => {
  const model = buildActiveTimelineModel({
    timeline: sampleTimeline({ state: 'escrow.pending', viewerLegStatus: 'pending', counterpartyLegStatus: 'pending' }),
    viewerActorIdHint: 'user_1',
    nowMs: Date.parse('2026-02-24T11:00:00.000Z')
  });

  assert.equal(model.waitReasonCode, 'your_deposit_required');
  assert.equal(model.statusHeadline, 'Your deposit is required');
  assert.equal(model.actions.find(row => row.key === 'confirm_deposit')?.enabled, true);
  assert.equal(model.entries.some(row => row.key === 'leg_leg_user' && row.kind === 'pending'), true);
});

test('active timeline model shows explicit counterparty wait reason after viewer deposited', () => {
  const model = buildActiveTimelineModel({
    timeline: sampleTimeline({ state: 'escrow.pending', viewerLegStatus: 'deposited', counterpartyLegStatus: 'pending' }),
    viewerActorIdHint: 'user_1',
    nowMs: Date.parse('2026-02-24T11:00:00.000Z')
  });

  assert.equal(model.waitReasonCode, 'awaiting_counterparty_deposit');
  assert.match(model.statusHeadline, /Awaiting/);

  const confirmAction = model.actions.find(row => row.key === 'confirm_deposit');
  assert.equal(confirmAction?.enabled, false);
  assert.equal(confirmAction?.reason, 'Your deposit is already confirmed.');
});

test('active timeline model enables receipt action for terminal states', () => {
  const model = buildActiveTimelineModel({
    timeline: sampleTimeline({ state: 'completed', viewerLegStatus: 'released', counterpartyLegStatus: 'released' }),
    viewerActorIdHint: 'user_1'
  });

  assert.equal(model.waitReasonCode, 'receipt_available');
  assert.equal(model.progressPercent, 100);
  assert.equal(model.actions.find(row => row.key === 'open_receipt')?.enabled, true);
  assert.equal(model.entries.some(row => row.key === 'receipt_issued'), true);
});

test('active timeline model marks failed + refunded paths clearly', () => {
  const model = buildActiveTimelineModel({
    timeline: sampleTimeline({ state: 'failed', viewerLegStatus: 'refunded', counterpartyLegStatus: 'deposited' }),
    viewerActorIdHint: 'user_1'
  });

  assert.equal(model.waitReasonCode, 'counterparty_timeout_refund');
  assert.equal(model.actions.find(row => row.key === 'open_receipt')?.enabled, true);
  assert.equal(model.entries.some(row => row.key === 'failed' && row.kind === 'danger'), true);
});

test('inferViewerActorId resolves hint, intents, and timeline fallbacks', () => {
  const timeline = sampleTimeline();

  assert.equal(inferViewerActorId({ timeline, viewerActorIdHint: 'hint_user' }), 'hint_user');
  assert.equal(inferViewerActorId({ timeline, intents: [{ actor: { id: 'intent_user' } }] }), 'intent_user');
  assert.equal(inferViewerActorId({ timeline, intents: [] }), 'user_1');
});
