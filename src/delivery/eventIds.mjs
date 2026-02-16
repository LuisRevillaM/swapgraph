import crypto from 'node:crypto';

export function stableEventId({ type, correlationId, key }) {
  const h = crypto.createHash('sha256').update(`${type}|${correlationId}|${key}`).digest('hex').slice(0, 12);
  return `evt_${h}`;
}
