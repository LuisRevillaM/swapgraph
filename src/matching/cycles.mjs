function rotateToSmallest(ids) {
  // For a directed cycle, rotate so lexicographically smallest id is first.
  const min = [...ids].sort()[0];
  const idx = ids.indexOf(min);
  return [...ids.slice(idx), ...ids.slice(0, idx)];
}

export function findCyclesLen2({ edges }) {
  const ids = [...edges.keys()].sort();
  const cycles = [];
  const seen = new Set();

  for (const a of ids) {
    for (const b of edges.get(a) ?? []) {
      if (!(edges.get(b) ?? []).includes(a)) continue;
      const pair = [a, b].sort();
      const key = pair.join('>');
      if (seen.has(key)) continue;
      seen.add(key);
      cycles.push(pair);
    }
  }
  return cycles;
}

export function findCyclesLen3({ edges }) {
  const ids = [...edges.keys()].sort();
  const seen = new Set();
  const cycles = [];

  for (const a of ids) {
    for (const b of edges.get(a) ?? []) {
      if (b === a) continue;
      for (const c of edges.get(b) ?? []) {
        if (c === a || c === b) continue;
        if (!(edges.get(c) ?? []).includes(a)) continue;

        const cyc = rotateToSmallest([a, b, c]);
        const key = cyc.join('>');
        if (seen.has(key)) continue;
        seen.add(key);
        cycles.push(cyc);
      }
    }
  }

  return cycles;
}
