import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProposalDetailModel,
  rankInboxCards
} from '../../../client/marketplace/src/features/inbox/proposals.mjs';

const NOW_MS = Date.parse('2026-02-24T12:00:00.000Z');

function proposal({
  id,
  expiresAt,
  confidenceScore,
  explainability = ['value_delta', 'confidence', 'constraint_fit'],
  participantCount = 2
}) {
  const participants = [
    {
      intentId: 'intent_user',
      actor: { type: 'user', id: 'user_1' },
      give: [{ assetId: `give_${id}`, label: `Give ${id}`, wear: 'MW', valueUsd: 100 }],
      get: [{ assetId: `get_${id}`, label: `Get ${id}`, wear: 'FT', valueUsd: 118 }]
    }
  ];

  for (let idx = 1; idx < participantCount; idx += 1) {
    participants.push({
      intentId: `intent_other_${idx}`,
      actor: { type: 'user', id: `user_${idx + 1}` },
      give: [{ assetId: `give_other_${idx}`, label: `Other Give ${idx}`, wear: 'MW', valueUsd: 99 }],
      get: [{ assetId: `get_other_${idx}`, label: `Other Get ${idx}`, wear: 'FT', valueUsd: 99 }]
    });
  }

  return {
    id,
    expiresAt,
    participants,
    confidenceScore,
    valueSpread: 0,
    explainability
  };
}

function intents() {
  return [
    {
      id: 'intent_user',
      actor: { type: 'user', id: 'user_1' }
    }
  ];
}

test('rankInboxCards sorts by urgency + score and computes sections', () => {
  const cards = rankInboxCards({
    intents: intents(),
    nowMs: NOW_MS,
    proposals: [
      proposal({
        id: 'proposal_normal',
        expiresAt: '2026-02-24T20:00:00.000Z',
        confidenceScore: 0.91
      }),
      proposal({
        id: 'proposal_critical',
        expiresAt: '2026-02-24T12:30:00.000Z',
        confidenceScore: 0.52
      }),
      proposal({
        id: 'proposal_soon',
        expiresAt: '2026-02-24T15:00:00.000Z',
        confidenceScore: 0.62
      })
    ]
  });

  assert.equal(cards.stats.totalCount, 3);
  assert.equal(cards.stats.urgentCount, 2);
  assert.equal(cards.cards[0].proposalId, 'proposal_critical');
  assert.equal(cards.cards[1].proposalId, 'proposal_soon');
  assert.equal(cards.cards[2].proposalId, 'proposal_normal');
  assert.equal(cards.sections.priority.length, 2);
  assert.equal(cards.sections.ranked.length, 1);
});

test('buildProposalDetailModel always emits explainability primitives and cycle context', () => {
  const ranked = rankInboxCards({
    intents: intents(),
    nowMs: NOW_MS,
    proposals: [
      proposal({
        id: 'proposal_detail',
        expiresAt: '2026-02-24T14:00:00.000Z',
        confidenceScore: 0.88,
        participantCount: 3
      })
    ]
  });

  const detail = buildProposalDetailModel({
    proposal: {
      id: 'proposal_detail',
      expiresAt: '2026-02-24T14:00:00.000Z',
      confidenceScore: 0.88,
      participants: ranked.cards.length > 0
        ? [
          {
            intentId: 'intent_user',
            actor: { type: 'user', id: 'user_1' },
            give: [{ assetId: 'give', label: 'AK-47 Redline', wear: 'MW', valueUsd: 100 }],
            get: [{ assetId: 'get', label: 'M9 Bayonet', wear: 'FT', valueUsd: 140 }]
          },
          {
            intentId: 'intent_other_1',
            actor: { type: 'user', id: 'user_2' },
            give: [{ assetId: 'other_give', label: 'Other Give', wear: 'MW', valueUsd: 120 }],
            get: [{ assetId: 'other_get', label: 'Other Get', wear: 'FT', valueUsd: 120 }]
          },
          {
            intentId: 'intent_other_2',
            actor: { type: 'user', id: 'user_3' },
            give: [{ assetId: 'other_give_2', label: 'Other Give 2', wear: 'MW', valueUsd: 120 }],
            get: [{ assetId: 'other_get_2', label: 'Other Get 2', wear: 'FT', valueUsd: 120 }]
          }
        ]
        : [],
      explainability: ['value_delta', 'confidence', 'constraint_fit']
    },
    intents: intents(),
    nowMs: NOW_MS
  });

  assert.equal(detail.explanationCards.length, 3);
  assert.deepEqual(
    detail.explanationCards.map(card => card.key),
    ['value_delta', 'confidence', 'constraint_fit']
  );
  assert.equal(detail.cycleNodes.length, 3);
  assert.equal(detail.cycleNodes[0].actorLabel, 'You');
});

test('buildProposalDetailModel uses track-a aliases for fixture actors and themed item labels', () => {
  const detail = buildProposalDetailModel({
    proposal: {
      id: 'proposal_track_a',
      expiresAt: '2026-02-24T14:00:00.000Z',
      confidenceScore: 0.9,
      participants: [
        {
          intentId: 'intent_u1',
          actor: { type: 'user', id: 'u1' },
          give: [{ assetId: 'assetA', wear: 'MW', valueUsd: 100 }],
          get: [{ assetId: 'assetB', wear: 'FT', valueUsd: 110 }]
        },
        {
          intentId: 'intent_u2',
          actor: { type: 'user', id: 'u2' },
          give: [{ assetId: 'assetB', wear: 'MW', valueUsd: 110 }],
          get: [{ assetId: 'assetA', wear: 'FT', valueUsd: 100 }]
        }
      ],
      explainability: ['value_delta']
    },
    intents: [{ id: 'intent_u1', actor: { type: 'user', id: 'u1' } }],
    nowMs: NOW_MS
  });

  assert.equal(detail.cycleNodes[0].actorLabel, 'You');
  assert.equal(detail.cycleNodes[1].actorLabel, 'Agent Ops');
  assert.equal(detail.hero.giveName, 'Prompt Forge License');
  assert.equal(detail.hero.getName, 'Agent Autopilot Pass');
});
