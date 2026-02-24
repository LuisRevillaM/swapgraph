import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createActorId,
  redactAnalyticsEvent,
  sanitizeActorId,
  sanitizeNotificationPrefsForStorage,
  sanitizeOfflineSnapshotForStorage
} from '../../../client/marketplace/src/features/security/storagePolicy.mjs';

test('actor id policy accepts expected shape and rejects malformed identifiers', () => {
  assert.equal(sanitizeActorId('web_user_abc123'), 'web_user_abc123');
  assert.equal(sanitizeActorId('u1'), 'u1');
  assert.equal(sanitizeActorId('bad id with spaces'), null);
  assert.match(createActorId(1_706_000_000_000), /^web_user_/);
});

test('notification preference storage payload is normalized', () => {
  const prefs = sanitizeNotificationPrefsForStorage({
    channels: { proposal: false, active: true },
    quietHours: { enabled: true, startHour: 30, endHour: 6 }
  });
  assert.equal(prefs.channels.proposal, false);
  assert.equal(prefs.channels.receipt, true);
  assert.equal(prefs.quietHours.startHour, 22);
  assert.equal(prefs.quietHours.endHour, 6);
});

test('offline snapshot policy redacts signature bytes and keeps continuity surfaces', () => {
  const snapshot = sanitizeOfflineSnapshotForStorage({
    version: 1,
    savedAt: 123,
    caches: {
      health: { value: { ok: true }, updatedAt: 1 },
      inventoryAwakening: { value: { swappabilitySummary: { activeIntents: 2 } }, updatedAt: 2 },
      intents: { items: [{ id: 'intent_1' }], updatedAt: 3 },
      proposals: { items: [{ id: 'proposal_1' }], updatedAt: 4 },
      timeline: {
        cycle_1: {
          value: { cycleId: 'cycle_1', state: 'executing' },
          updatedAt: 5
        }
      },
      receipts: {
        cycle_1: {
          value: {
            id: 'receipt_1',
            cycleId: 'cycle_1',
            signature: { keyId: 'k1', algorithm: 'ed25519', signature: 'very_secret_signature' }
          },
          updatedAt: 6
        }
      }
    }
  });

  assert.equal(snapshot.caches.intents.items.length, 1);
  assert.equal(snapshot.caches.receipts.cycle_1.value.signature.signature, '[redacted]');
  assert.equal(snapshot.caches.receipts.cycle_1.value.signature.signatureLength, 'very_secret_signature'.length);
});

test('analytics redaction strips id-like payload fields before logging', () => {
  const event = redactAnalyticsEvent({
    event_name: 'marketplace.receipt_opened',
    payload: {
      receipt_id: 'receipt_1',
      cycle_id: 'cycle_1',
      source: 'notification'
    },
    occurred_at: '2026-02-24T00:00:00.000Z'
  });

  assert.equal(event.payload.receipt_id, '[redacted]');
  assert.equal(event.payload.cycle_id, '[redacted]');
  assert.equal(event.payload.source, 'notification');
});
