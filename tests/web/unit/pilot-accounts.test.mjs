import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PILOT_ACCOUNTS,
  isPilotActorId,
  pilotAccountByActorId,
  resolvePilotAccountByName
} from '../../../client/marketplace/src/pilot/pilotAccounts.mjs';

test('pilot accounts expose fixed 5 personas with 3 inventory items each', () => {
  assert.equal(PILOT_ACCOUNTS.length, 5);
  for (const account of PILOT_ACCOUNTS) {
    assert.equal(account.inventory.length, 3);
    for (const item of account.inventory) {
      assert.match(item.imageUrl, /^data:image\/svg\+xml/);
    }
  }
});

test('pilot account lookup resolves by actor id and by typed name', () => {
  assert.equal(pilotAccountByActorId('u1')?.name, 'Javier');
  assert.equal(pilotAccountByActorId('u9'), null);
  assert.equal(resolvePilotAccountByName('luis')?.actorId, 'u5');
  assert.equal(resolvePilotAccountByName('  JeSuS  ')?.actorId, 'u2');
  assert.equal(resolvePilotAccountByName('unknown person'), null);
  assert.equal(isPilotActorId('u4'), true);
  assert.equal(isPilotActorId('web_user_123'), false);
});

