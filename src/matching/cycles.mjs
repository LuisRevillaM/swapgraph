function rotateToSmallest(ids) {
  // Canonical form for directed cycles: rotate so the smallest intent id leads.
  const min = [...ids].sort()[0];
  const idx = ids.indexOf(min);
  return [...ids.slice(idx), ...ids.slice(0, idx)];
}

function parseBound(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function normalizeBounds({ minCycleLength = 2, maxCycleLength = 3 }) {
  let minLen = parseBound(minCycleLength, 2);
  let maxLen = parseBound(maxCycleLength, 3);

  minLen = Math.max(2, minLen);
  maxLen = Math.max(minLen, maxLen);

  return { minLen, maxLen };
}

function normalizeGraph(edges) {
  const nodes = [...(edges?.keys?.() ?? [])].map(String).sort();
  const known = new Set(nodes);
  const adjacency = new Map();

  for (const node of nodes) {
    const neighbors = [...new Set((edges.get(node) ?? []).map(String))]
      .filter(neighbor => known.has(neighbor) && neighbor !== node)
      .sort();
    adjacency.set(node, neighbors);
  }

  return { nodes, adjacency };
}

function tarjanScc({ nodes, adjacency, allowed }) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexByNode = new Map();
  const lowByNode = new Map();
  const components = [];

  function strongConnect(v) {
    indexByNode.set(v, index);
    lowByNode.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!allowed.has(w)) continue;
      if (!indexByNode.has(w)) {
        strongConnect(w);
        lowByNode.set(v, Math.min(lowByNode.get(v), lowByNode.get(w)));
      } else if (onStack.has(w)) {
        lowByNode.set(v, Math.min(lowByNode.get(v), indexByNode.get(w)));
      }
    }

    if (lowByNode.get(v) === indexByNode.get(v)) {
      const component = [];
      while (stack.length > 0) {
        const w = stack.pop();
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      component.sort();
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!allowed.has(node)) continue;
    if (!indexByNode.has(node)) strongConnect(node);
  }

  return components;
}

function componentHasDirectedCycle({ component, adjacency }) {
  if (component.length > 1) return true;
  const only = component[0];
  return (adjacency.get(only) ?? []).includes(only);
}

/**
 * Bounded exhaustive simple-cycle enumeration using SCC decomposition and a
 * canonical start-node DFS, deterministic over sorted node ids.
 */
export function findBoundedSimpleCycles({ edges, minCycleLength = 2, maxCycleLength = 3 }) {
  const { minLen, maxLen } = normalizeBounds({ minCycleLength, maxCycleLength });
  const { nodes, adjacency } = normalizeGraph(edges);
  const order = new Map(nodes.map((node, idx) => [node, idx]));
  const seen = new Set();
  const cycles = [];

  function addCycle(path) {
    const canonical = rotateToSmallest(path);
    const key = canonical.join('>');
    if (seen.has(key)) return;
    seen.add(key);
    cycles.push(canonical);
  }

  const allNodes = new Set(nodes);
  const sccs = tarjanScc({ nodes, adjacency, allowed: allNodes })
    .filter(component => componentHasDirectedCycle({ component, adjacency }))
    .sort((a, b) => {
      const aMin = Math.min(...a.map(node => order.get(node)));
      const bMin = Math.min(...b.map(node => order.get(node)));
      return aMin - bMin;
    });

  for (const component of sccs) {
    const sccNodes = [...component].sort((a, b) => order.get(a) - order.get(b));
    const scc = new Set(sccNodes);

    for (const start of sccNodes) {
      const startOrder = order.get(start);
      const stack = [start];
      const onPath = new Set([start]);

      function dfs(v) {
        for (const w of adjacency.get(v) ?? []) {
          if (!scc.has(w)) continue;
          if (order.get(w) < startOrder) continue;

          if (w === start) {
            if (stack.length >= minLen && stack.length <= maxLen) {
              addCycle([...stack]);
            }
            continue;
          }

          if (stack.length >= maxLen) continue;
          if (onPath.has(w)) continue;

          stack.push(w);
          onPath.add(w);
          dfs(w);
          onPath.delete(w);
          stack.pop();
        }
      }

      dfs(start);
    }
  }

  cycles.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a.join('>').localeCompare(b.join('>'));
  });

  return cycles;
}

export function findCyclesLen2({ edges }) {
  return findBoundedSimpleCycles({ edges, minCycleLength: 2, maxCycleLength: 2 });
}

export function findCyclesLen3({ edges }) {
  return findBoundedSimpleCycles({ edges, minCycleLength: 3, maxCycleLength: 3 });
}
