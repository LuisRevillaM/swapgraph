#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { trackAActorAlias, trackAActorIds, trackAAssetLabel } from '../client/marketplace/src/pilot/trackATheme.mjs';

const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:3005';
const DEFAULT_PARTNER_ID = 'partner_demo';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function trimOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBaseUrl(value, fallback = null) {
  const raw = trimOrNull(value) ?? fallback;
  if (!raw) return null;
  const parsed = new URL(raw);
  parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
  return parsed.toString().replace(/\/+$/g, '');
}

function parseActorIds(raw) {
  const defaultIds = trackAActorIds();
  const configured = String(raw ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (configured.length === 0) return defaultIds;

  const unique = Array.from(new Set(configured));
  const allowed = new Set(defaultIds);
  const invalid = unique.filter(actorId => !allowed.has(actorId));
  if (invalid.length > 0) {
    throw new Error(`TRACK_A_ACTOR_IDS has unsupported ids (${invalid.join(',')}). Allowed: ${defaultIds.join(',')}`);
  }
  return unique;
}

function loadFixtureIntents() {
  const fixturePath = path.join(repoRoot, 'fixtures/matching/m5_input.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  return Array.isArray(fixture?.intents) ? fixture.intents : [];
}

function actorInventoryFromFixture(intents) {
  const byActor = new Map();
  for (const intent of intents) {
    const actorId = trimOrNull(intent?.actor?.id);
    if (!actorId) continue;

    const assets = Array.isArray(intent?.offer)
      ? intent.offer.map(row => trimOrNull(row?.asset_id)).filter(Boolean)
      : [];
    if (assets.length === 0) continue;

    const list = byActor.get(actorId) ?? [];
    for (const assetId of assets) {
      if (!list.includes(assetId)) list.push(assetId);
    }
    byActor.set(actorId, list);
  }
  return byActor;
}

function claimLinkForActor({ webUrl, actorId }) {
  if (!webUrl) return `/?actor_id=${encodeURIComponent(actorId)}`;
  return `${webUrl}/?actor_id=${encodeURIComponent(actorId)}`;
}

async function seedTrackA({ runtimeUrl, partnerId, reset }) {
  const response = await fetch(`${runtimeUrl}/dev/seed/m5`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reset,
      partner_id: partnerId
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`seed failed (${response.status}): ${body}`);
  }

  return response.json();
}

function printSeedSummary({
  runtimeUrl,
  webUrl,
  actorIds,
  seedResult,
  actorInventory
}) {
  // eslint-disable-next-line no-console
  console.log(`[track-a-seed] runtime=${runtimeUrl}`);
  // eslint-disable-next-line no-console
  console.log(`[track-a-seed] web=${webUrl ?? '(not provided)'}`);
  // eslint-disable-next-line no-console
  console.log(
    `[track-a-seed] seeded intents=${seedResult.seeded_intents ?? 0}, proposals=${seedResult.seeded_proposals ?? 0}, reset=${seedResult.reset_applied === true}`
  );
  // eslint-disable-next-line no-console
  console.log('[track-a-seed] friend claim links');

  actorIds.forEach((actorId, index) => {
    const alias = trackAActorAlias(actorId) ?? actorId;
    const link = claimLinkForActor({ webUrl, actorId });
    const itemIds = actorInventory.get(actorId) ?? [];
    const itemLabels = itemIds
      .map(assetId => trackAAssetLabel(assetId) ?? assetId)
      .join(', ') || 'no seeded item';
    // eslint-disable-next-line no-console
    console.log(`[track-a-seed]   P${String(index + 1).padStart(2, '0')} ${alias} (${actorId}) -> ${itemLabels}`);
    // eslint-disable-next-line no-console
    console.log(`[track-a-seed]      ${link}`);
  });

  const uniqueAssetIds = Array.from(
    new Set([...actorInventory.values()].flatMap(rows => rows))
  );
  // eslint-disable-next-line no-console
  console.log('[track-a-seed] themed item universe');
  uniqueAssetIds.forEach(assetId => {
    const label = trackAAssetLabel(assetId) ?? assetId;
    // eslint-disable-next-line no-console
    console.log(`[track-a-seed]   ${assetId}: ${label}`);
  });
}

async function main() {
  const runtimeUrl = normalizeBaseUrl(
    process.env.RUNTIME_SERVICE_URL ?? process.env.TRACK_A_RUNTIME_URL,
    DEFAULT_RUNTIME_URL
  );
  const webUrl = normalizeBaseUrl(process.env.TRACK_A_WEB_URL, null);
  const partnerId = trimOrNull(process.env.TRACK_A_PARTNER_ID) ?? DEFAULT_PARTNER_ID;
  const reset = process.env.TRACK_A_RESET !== '0';
  const actorIds = parseActorIds(process.env.TRACK_A_ACTOR_IDS ?? '');

  if (!runtimeUrl) {
    throw new Error('RUNTIME_SERVICE_URL (or TRACK_A_RUNTIME_URL) is required');
  }

  const intents = loadFixtureIntents();
  const actorInventory = actorInventoryFromFixture(intents);

  const seedResult = await seedTrackA({
    runtimeUrl,
    partnerId,
    reset
  });

  printSeedSummary({
    runtimeUrl,
    webUrl,
    actorIds,
    seedResult,
    actorInventory
  });
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(`[track-a-seed] failed: ${error.message}`);
  process.exit(1);
});
