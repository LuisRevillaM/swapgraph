#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import {
  actorHeaders,
  requestJson,
  startRuntimeApi,
  stopRuntimeApi
} from './runtimeApiHarness.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, next]) => [key, stable(next)])
    );
  }
  return value;
}

async function main() {
  const port = 3400 + Math.floor(Math.random() * 200);
  const stateFile = path.join(os.tmpdir(), `ios-m1-sc-api-03-${Date.now()}.json`);

  let runtime;
  try {
    runtime = await startRuntimeApi({ port, stateFile });

    const seed = await requestJson(runtime.baseURL, '/dev/seed/m5', {
      method: 'POST',
      body: {
        reset: true,
        partner_id: 'partner_demo'
      }
    });

    if (seed.status !== 200) {
      throw new Error(`seed failed: ${JSON.stringify(seed.body)}`);
    }

    const proposals = await requestJson(runtime.baseURL, '/cycle-proposals', {
      headers: actorHeaders('user', 'u5')
    });
    if (proposals.status !== 200) {
      throw new Error(`proposal list failed: ${JSON.stringify(proposals.body)}`);
    }

    const proposal = proposals.body?.proposals?.[0];
    if (!proposal) {
      throw new Error('no proposal found for replay test');
    }

    const cycleId = proposal.id;
    const actorId = proposal.participants?.[0]?.actor?.id;
    if (!actorId) {
      throw new Error('proposal missing first participant actor id');
    }

    const idempotencyKey = `sc-api-03-replay-${cycleId}`;
    const endpoint = `/cycle-proposals/${cycleId}/accept`;

    const payloadA = {
      proposal_id: cycleId,
      occurred_at: '2026-02-24T09:00:00Z'
    };

    const payloadB = {
      proposal_id: cycleId,
      occurred_at: '2026-02-24T09:05:00Z'
    };

    const first = await requestJson(runtime.baseURL, endpoint, {
      method: 'POST',
      headers: {
        ...actorHeaders('user', actorId),
        'Idempotency-Key': idempotencyKey
      },
      body: payloadA
    });

    const replay = await requestJson(runtime.baseURL, endpoint, {
      method: 'POST',
      headers: {
        ...actorHeaders('user', actorId),
        'Idempotency-Key': idempotencyKey
      },
      body: payloadA
    });

    const mismatch = await requestJson(runtime.baseURL, endpoint, {
      method: 'POST',
      headers: {
        ...actorHeaders('user', actorId),
        'Idempotency-Key': idempotencyKey
      },
      body: payloadB
    });

    const firstStable = stable(first.body);
    const replayStable = stable(replay.body);

    const replayMatches = first.status === 200 && replay.status === 200
      && JSON.stringify(firstStable) === JSON.stringify(replayStable);

    const mismatchHandled = mismatch.status === 409
      && mismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH';

    const reseed = await requestJson(runtime.baseURL, '/dev/seed/m5', {
      method: 'POST',
      body: {
        reset: true,
        partner_id: 'partner_demo'
      }
    });
    if (reseed.status !== 200) {
      throw new Error(`reseed failed: ${JSON.stringify(reseed.body)}`);
    }

    const declineProposals = await requestJson(runtime.baseURL, '/cycle-proposals', {
      headers: actorHeaders('user', 'u5')
    });
    if (declineProposals.status !== 200) {
      throw new Error(`proposal list for decline replay failed: ${JSON.stringify(declineProposals.body)}`);
    }

    const declineProposal = declineProposals.body?.proposals?.[0];
    if (!declineProposal) {
      throw new Error('no proposal found for decline replay test');
    }

    const declineCycleId = declineProposal.id;
    const declineActorId = declineProposal.participants?.[0]?.actor?.id;
    if (!declineActorId) {
      throw new Error('decline proposal missing first participant actor id');
    }

    const declineIdempotencyKey = `sc-api-03-replay-decline-${declineCycleId}`;
    const declineEndpoint = `/cycle-proposals/${declineCycleId}/decline`;

    const declinePayloadA = {
      proposal_id: declineCycleId,
      occurred_at: '2026-02-24T09:10:00Z'
    };

    const declinePayloadB = {
      proposal_id: declineCycleId,
      occurred_at: '2026-02-24T09:15:00Z'
    };

    const declineFirst = await requestJson(runtime.baseURL, declineEndpoint, {
      method: 'POST',
      headers: {
        ...actorHeaders('user', declineActorId),
        'Idempotency-Key': declineIdempotencyKey
      },
      body: declinePayloadA
    });

    const declineReplay = await requestJson(runtime.baseURL, declineEndpoint, {
      method: 'POST',
      headers: {
        ...actorHeaders('user', declineActorId),
        'Idempotency-Key': declineIdempotencyKey
      },
      body: declinePayloadA
    });

    const declineMismatch = await requestJson(runtime.baseURL, declineEndpoint, {
      method: 'POST',
      headers: {
        ...actorHeaders('user', declineActorId),
        'Idempotency-Key': declineIdempotencyKey
      },
      body: declinePayloadB
    });

    const declineFirstStable = stable(declineFirst.body);
    const declineReplayStable = stable(declineReplay.body);

    const declineReplayMatches = declineFirst.status === 200 && declineReplay.status === 200
      && JSON.stringify(declineFirstStable) === JSON.stringify(declineReplayStable);

    const declineMismatchHandled = declineMismatch.status === 409
      && declineMismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH';

    const intentId = `intent_sc_api_03_${Date.now()}`;
    const intentIdempotencyKey = `sc-api-03-intent-${intentId}`;

    const intentPayloadA = {
      intent: {
        id: intentId,
        actor: { type: 'user', id: actorId },
        offer: [{ platform: 'steam', app_id: 730, context_id: 2, asset_id: 'asset_sc_api_03' }],
        want_spec: {
          type: 'set',
          any_of: [
            {
              type: 'category',
              platform: 'steam',
              app_id: 730,
              category: 'knife',
              constraints: {
                acceptable_wear: ['MW', 'FT']
              }
            }
          ]
        },
        value_band: {
          min_usd: 0,
          max_usd: 50,
          pricing_source: 'market_median'
        },
        trust_constraints: {
          max_cycle_length: 3,
          min_counterparty_reliability: 0
        },
        time_constraints: {
          expires_at: '2026-03-15T00:00:00Z',
          urgency: 'normal'
        },
        settlement_preferences: {
          require_escrow: true
        }
      }
    };

    const intentPayloadB = {
      intent: {
        ...intentPayloadA.intent,
        want_spec: {
          type: 'set',
          any_of: [
            {
              type: 'category',
              platform: 'steam',
              app_id: 730,
              category: 'gloves'
            }
          ]
        }
      }
    };

    const intentFirst = await requestJson(runtime.baseURL, '/swap-intents', {
      method: 'POST',
      headers: {
        ...actorHeaders('user', actorId),
        'Idempotency-Key': intentIdempotencyKey
      },
      body: intentPayloadA
    });

    const intentReplay = await requestJson(runtime.baseURL, '/swap-intents', {
      method: 'POST',
      headers: {
        ...actorHeaders('user', actorId),
        'Idempotency-Key': intentIdempotencyKey
      },
      body: intentPayloadA
    });

    const intentMismatch = await requestJson(runtime.baseURL, '/swap-intents', {
      method: 'POST',
      headers: {
        ...actorHeaders('user', actorId),
        'Idempotency-Key': intentIdempotencyKey
      },
      body: intentPayloadB
    });

    const intentFirstStable = stable(intentFirst.body);
    const intentReplayStable = stable(intentReplay.body);

    const intentReplayMatches = intentFirst.status === 200 && intentReplay.status === 200
      && JSON.stringify(intentFirstStable) === JSON.stringify(intentReplayStable);

    const intentMismatchHandled = intentMismatch.status === 409
      && intentMismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH';

    const overall = replayMatches
      && mismatchHandled
      && declineReplayMatches
      && declineMismatchHandled
      && intentReplayMatches
      && intentMismatchHandled;

    const report = {
      check_id: 'SC-API-03',
      overall,
      actor_id: actorId,
      cycle_proposal_accept_replay: {
        cycle_id: cycleId,
        idempotency_key: idempotencyKey,
        replay_matches_first_response: replayMatches,
        mismatch_rejected: mismatchHandled,
        statuses: {
          first: first.status,
          replay: replay.status,
          mismatch: mismatch.status
        },
        mismatch_code: mismatch.body?.error?.code ?? null
      },
      cycle_proposal_decline_replay: {
        cycle_id: declineCycleId,
        idempotency_key: declineIdempotencyKey,
        replay_matches_first_response: declineReplayMatches,
        mismatch_rejected: declineMismatchHandled,
        statuses: {
          first: declineFirst.status,
          replay: declineReplay.status,
          mismatch: declineMismatch.status
        },
        mismatch_code: declineMismatch.body?.error?.code ?? null
      },
      swap_intent_create_replay: {
        intent_id: intentId,
        idempotency_key: intentIdempotencyKey,
        replay_matches_first_response: intentReplayMatches,
        mismatch_rejected: intentMismatchHandled,
        statuses: {
          first: intentFirst.status,
          replay: intentReplay.status,
          mismatch: intentMismatch.status
        },
        mismatch_code: intentMismatch.body?.error?.code ?? null
      }
    };

    if (!overall) {
      console.error(JSON.stringify(report, null, 2));
      process.exit(2);
    }

    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      check_id: 'SC-API-03',
      overall: false,
      error: String(error),
      logs: runtime?.getLogs?.() ?? null
    };
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  } finally {
    if (runtime?.child) {
      await stopRuntimeApi(runtime.child);
    }
  }
}

await main();
