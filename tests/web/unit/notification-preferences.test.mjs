import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNotificationChannelEnabled,
  isWithinQuietHours,
  normalizeNotificationPrefs,
  quietHoursLabel
} from '../../../client/marketplace/src/features/notifications/preferences.mjs';

test('normalizeNotificationPrefs applies defaults and hour bounds', () => {
  const prefs = normalizeNotificationPrefs({
    channels: { proposal: false, active: true, receipt: 'invalid' },
    quietHours: { enabled: true, startHour: 25, endHour: -2 }
  });

  assert.equal(prefs.channels.proposal, false);
  assert.equal(prefs.channels.active, true);
  assert.equal(prefs.channels.receipt, true);
  assert.equal(prefs.quietHours.enabled, true);
  assert.equal(prefs.quietHours.startHour, 22);
  assert.equal(prefs.quietHours.endHour, 7);
});

test('isNotificationChannelEnabled respects channel toggles', () => {
  const prefs = normalizeNotificationPrefs({
    channels: { proposal: false, active: true, receipt: false }
  });

  assert.equal(isNotificationChannelEnabled(prefs, 'proposal'), false);
  assert.equal(isNotificationChannelEnabled(prefs, 'active'), true);
  assert.equal(isNotificationChannelEnabled(prefs, 'receipt'), false);
});

test('isWithinQuietHours handles overnight ranges and labels', () => {
  const prefs = normalizeNotificationPrefs({
    quietHours: { enabled: true, startHour: 22, endHour: 7 }
  });

  const lateNight = new Date();
  lateNight.setHours(23, 0, 0, 0);
  const midday = new Date();
  midday.setHours(12, 0, 0, 0);

  assert.equal(isWithinQuietHours(prefs, lateNight.getTime()), true);
  assert.equal(isWithinQuietHours(prefs, midday.getTime()), false);
  assert.match(quietHoursLabel(prefs), /22:00-07:00/);
});
