import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actorDisplayLabel,
  trackAActorAlias,
  trackAActorIds,
  trackAAssetLabel
} from '../../../client/marketplace/src/pilot/trackATheme.mjs';

test('track-a actor and asset themes resolve fixture ids', () => {
  assert.deepEqual(trackAActorIds(), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  assert.equal(trackAActorAlias('u1'), 'Javier');
  assert.equal(trackAAssetLabel('assetF'), 'Vibe Coding Crown');
  assert.equal(trackAAssetLabel('steam:assetA'), 'Prompt Forge License');
});

test('actorDisplayLabel handles viewer, aliases, and fallback handles', () => {
  assert.equal(actorDisplayLabel({ actorId: 'u1', viewerActorId: 'u1' }), 'You');
  assert.equal(actorDisplayLabel({ actorId: 'u2', viewerActorId: 'u1' }), 'Jesus');
  assert.equal(actorDisplayLabel({ actorId: 'user_99', viewerActorId: 'u1' }), '@user_99');
});
