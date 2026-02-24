const DEFAULT_CHANNELS = Object.freeze({
  proposal: true,
  active: true,
  receipt: true
});

const DEFAULT_QUIET_HOURS = Object.freeze({
  enabled: false,
  startHour: 22,
  endHour: 7
});

export const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
  channels: DEFAULT_CHANNELS,
  quietHours: DEFAULT_QUIET_HOURS
});

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
  }
  return fallback;
}

function asHour(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized < 0 || normalized > 23) return fallback;
  return normalized;
}

export function normalizeNotificationPrefs(input = {}) {
  const channelsIn = input?.channels ?? {};
  const quietIn = input?.quietHours ?? {};

  return {
    channels: {
      proposal: asBoolean(channelsIn?.proposal, DEFAULT_CHANNELS.proposal),
      active: asBoolean(channelsIn?.active, DEFAULT_CHANNELS.active),
      receipt: asBoolean(channelsIn?.receipt, DEFAULT_CHANNELS.receipt)
    },
    quietHours: {
      enabled: asBoolean(quietIn?.enabled, DEFAULT_QUIET_HOURS.enabled),
      startHour: asHour(quietIn?.startHour, DEFAULT_QUIET_HOURS.startHour),
      endHour: asHour(quietIn?.endHour, DEFAULT_QUIET_HOURS.endHour)
    }
  };
}

export function isNotificationChannelEnabled(prefs, channel) {
  const normalized = normalizeNotificationPrefs(prefs);
  if (channel === 'proposal') return normalized.channels.proposal;
  if (channel === 'active') return normalized.channels.active;
  if (channel === 'receipt') return normalized.channels.receipt;
  return false;
}

export function isWithinQuietHours(prefs, nowMs = Date.now()) {
  const normalized = normalizeNotificationPrefs(prefs);
  if (!normalized.quietHours.enabled) return false;

  const start = normalized.quietHours.startHour;
  const end = normalized.quietHours.endHour;
  const hour = new Date(nowMs).getHours();

  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function quietHoursLabel(prefs) {
  const normalized = normalizeNotificationPrefs(prefs);
  if (!normalized.quietHours.enabled) return 'quiet hours off';
  const start = String(normalized.quietHours.startHour).padStart(2, '0');
  const end = String(normalized.quietHours.endHour).padStart(2, '0');
  return `${start}:00-${end}:00`;
}

