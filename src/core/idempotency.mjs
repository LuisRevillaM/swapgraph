import crypto from 'node:crypto';
import { canonicalStringify } from '../util/canonicalJson.mjs';

export function idempotencyScopeKey({ actor, operationId, idempotencyKey }) {
  if (!actor?.type || !actor?.id) throw new Error('actor.type and actor.id are required');
  if (!operationId) throw new Error('operationId is required');
  if (!idempotencyKey) throw new Error('idempotencyKey is required');
  return `${actor.type}:${actor.id}|${operationId}|${idempotencyKey}`;
}

export function payloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}
