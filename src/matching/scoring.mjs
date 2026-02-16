import { clamp01, round } from './values.mjs';

export function computeValueSpread({ getValues }) {
  const max = Math.max(...getValues);
  const min = Math.min(...getValues);
  if (max <= 0) return 0;
  return (max - min) / max;
}

export function scoreCycle({ length, valueSpread }) {
  // v1 deterministic heuristic.
  const base = length === 2 ? 0.9 : 0.85;
  const score = base - valueSpread;
  return clamp01(round(score, 4));
}
