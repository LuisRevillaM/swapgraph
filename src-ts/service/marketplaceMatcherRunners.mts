import { runMatching as runMatchingJs } from '../matching/engine.mts';
import { runMatching as runMatchingTsShadow } from '../../src/matching-ts-shadow/engine.mjs';

function runMatcherEngine({ engine, intents, assetValuesUsd, edgeIntents, nowIso, config }) {
  const startedAtNs = process.hrtime.bigint();
  const matching = engine({
    intents,
    assetValuesUsd,
    edgeIntents,
    nowIso,
    minCycleLength: config.min_cycle_length,
    maxCycleLength: config.max_cycle_length,
    maxEnumeratedCycles: config.max_cycles_explored,
    timeoutMs: config.timeout_ms,
    includeCycleDiagnostics: config.include_cycle_diagnostics === true
  });
  const runtimeMs = Number((process.hrtime.bigint() - startedAtNs) / 1000000n);

  return {
    matching,
    runtime_ms: runtimeMs
  };
}

export function runMatcherWithConfig({ intents, assetValuesUsd, edgeIntents, nowIso, config }) {
  return runMatcherEngine({
    engine: runMatchingJs,
    intents,
    assetValuesUsd,
    edgeIntents,
    nowIso,
    config
  });
}

export function runMatcherTsShadowWithConfig({ intents, assetValuesUsd, edgeIntents, nowIso, config }) {
  return runMatcherEngine({
    engine: runMatchingTsShadow,
    intents,
    assetValuesUsd,
    edgeIntents,
    nowIso,
    config
  });
}
