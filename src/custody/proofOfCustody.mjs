import crypto from 'node:crypto';
import { canonicalStringify } from '../util/canonicalJson.mjs';

function sha256HexCanonical(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeActor(actor) {
  return {
    type: normalizeString(actor?.type),
    id: normalizeString(actor?.id)
  };
}

function normalizeAsset(asset) {
  return {
    platform: normalizeString(asset?.platform),
    asset_id: normalizeString(asset?.asset_id)
  };
}

export function normalizeCustodyHolding(holding) {
  return {
    holding_id: normalizeString(holding?.holding_id),
    asset: normalizeAsset(holding?.asset),
    owner_actor: normalizeActor(holding?.owner_actor),
    vault_id: normalizeString(holding?.vault_id) || null,
    deposit_id: normalizeString(holding?.deposit_id) || null,
    deposited_at: normalizeString(holding?.deposited_at) || null
  };
}

export function custodyHoldingKey(holding) {
  const h = normalizeCustodyHolding(holding);
  return `${h.asset.platform}:${h.asset.asset_id}|${h.owner_actor.type}:${h.owner_actor.id}|${h.vault_id ?? ''}|${h.deposit_id ?? ''}|${h.holding_id}`;
}

function custodyLeafHash({ snapshotId, holding }) {
  return sha256HexCanonical({
    snapshot_id: normalizeString(snapshotId),
    holding: normalizeCustodyHolding(holding)
  });
}

function hashPair(leftHash, rightHash) {
  return sha256HexCanonical({ left: String(leftHash ?? ''), right: String(rightHash ?? '') });
}

function buildMerkleLevels(leafHashes) {
  if (!Array.isArray(leafHashes) || leafHashes.length < 1) return [];

  const levels = [leafHashes.slice()];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = i + 1 < prev.length ? prev[i + 1] : prev[i];
      next.push(hashPair(left, right));
    }
    levels.push(next);
  }
  return levels;
}

export function buildCustodySnapshot({ snapshotId, recordedAt, holdings }) {
  const normalizedSnapshotId = normalizeString(snapshotId);
  const normalizedRecordedAt = normalizeString(recordedAt);
  const normalizedHoldings = (holdings ?? []).map(normalizeCustodyHolding);

  const sortedHoldings = normalizedHoldings
    .map(h => ({ holding: h, holding_key: custodyHoldingKey(h) }))
    .sort((a, b) => a.holding_key.localeCompare(b.holding_key));

  const entries = sortedHoldings.map(entry => ({
    ...entry,
    leaf_hash: custodyLeafHash({ snapshotId: normalizedSnapshotId, holding: entry.holding })
  }));

  const leafHashes = entries.map(e => e.leaf_hash);
  const levels = buildMerkleLevels(leafHashes);
  const rootHash = levels.length > 0
    ? levels[levels.length - 1][0]
    : sha256HexCanonical({ snapshot_id: normalizedSnapshotId, holdings: [] });

  return {
    snapshot_id: normalizedSnapshotId,
    recorded_at: normalizedRecordedAt,
    leaf_count: entries.length,
    root_hash: rootHash,
    holdings: entries
  };
}

export function buildCustodyInclusionProof({ snapshot, holding }) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, error: 'snapshot_required' };
  }

  const normalizedHolding = normalizeCustodyHolding(holding);
  const holdingKey = custodyHoldingKey(normalizedHolding);
  const entries = Array.isArray(snapshot.holdings) ? snapshot.holdings : [];
  const index = entries.findIndex(e => e?.holding_key === holdingKey);

  if (index < 0) {
    return {
      ok: false,
      error: 'holding_not_found',
      details: { holding_key: holdingKey }
    };
  }

  const leafHashes = entries.map(e => e.leaf_hash);
  const levels = buildMerkleLevels(leafHashes);

  let cursor = index;
  const siblings = [];

  for (let depth = 0; depth < levels.length - 1; depth += 1) {
    const level = levels[depth];
    const isRightNode = cursor % 2 === 1;
    const siblingIndex = isRightNode
      ? cursor - 1
      : (cursor + 1 < level.length ? cursor + 1 : cursor);

    siblings.push({
      position: isRightNode ? 'left' : 'right',
      hash: level[siblingIndex]
    });

    cursor = Math.floor(cursor / 2);
  }

  return {
    ok: true,
    proof: {
      snapshot_id: snapshot.snapshot_id,
      root_hash: snapshot.root_hash,
      holding_key: holdingKey,
      leaf_index: index,
      leaf_hash: entries[index].leaf_hash,
      siblings
    }
  };
}

export function verifyCustodyInclusionProof({ snapshot, holding, proof }) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, error: 'snapshot_required' };
  }

  if (!proof || typeof proof !== 'object') {
    return { ok: false, error: 'proof_required' };
  }

  const normalizedHolding = normalizeCustodyHolding(holding);
  const expectedLeafHash = custodyLeafHash({ snapshotId: snapshot.snapshot_id, holding: normalizedHolding });

  if (proof.leaf_hash !== expectedLeafHash) {
    return {
      ok: false,
      error: 'leaf_hash_mismatch',
      details: {
        expected_leaf_hash: expectedLeafHash,
        provided_leaf_hash: proof.leaf_hash ?? null
      }
    };
  }

  let current = proof.leaf_hash;
  for (const sibling of proof.siblings ?? []) {
    if (sibling?.position === 'left') {
      current = hashPair(sibling.hash, current);
    } else if (sibling?.position === 'right') {
      current = hashPair(current, sibling.hash);
    } else {
      return {
        ok: false,
        error: 'invalid_sibling_position',
        details: { position: sibling?.position ?? null }
      };
    }
  }

  const expectedRootHash = snapshot.root_hash;
  if (current !== expectedRootHash) {
    return {
      ok: false,
      error: 'root_mismatch',
      details: {
        expected_root_hash: expectedRootHash,
        provided_root_hash: current
      }
    };
  }

  return {
    ok: true,
    details: {
      derived_root_hash: current,
      expected_root_hash: expectedRootHash
    }
  };
}
