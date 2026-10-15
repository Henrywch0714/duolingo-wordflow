(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WordflowNearforms = factory();
})(globalThis, function () {
  "use strict";

  const RULES = Object.freeze({ coverage: 0.7, multiCoverage: 0.6, minBlock: 2, minLongest: 3,
    shortDistance: 1, longDistance: 2, maxDistanceRatio: 0.25 });

  // Continuous, non-overlapping matches, preserving their order in both words.
  function matchingBlocks(a, b, a0 = 0, a1 = a.length, b0 = 0, b1 = b.length) {
    let longest = 0, ai = a0, bj = b0;
    let previous = new Uint16Array(b1 - b0 + 1);
    for (let i = a0; i < a1; i++) {
      const row = new Uint16Array(b1 - b0 + 1);
      for (let j = b0; j < b1; j++) {
        if (a[i] !== b[j]) continue;
        const length = previous[j - b0] + 1;
        row[j - b0 + 1] = length;
        if (length > longest) { longest = length; ai = i - length + 1; bj = j - length + 1; }
      }
      previous = row;
    }
    if (!longest) return [];
    return [...matchingBlocks(a, b, a0, ai, b0, bj), [ai, bj, longest],
      ...matchingBlocks(a, b, ai + longest, a1, bj + longest, b1)];
  }

  // Full Damerau-Levenshtein distance, including adjacent letter transpositions.
  function editDistance(a, b) {
    const m = a.length, n = b.length, limit = m + n;
    const d = Array.from({ length: m + 2 }, () => new Uint16Array(n + 2));
    d[0][0] = limit;
    for (let i = 0; i <= m; i++) { d[i + 1][0] = limit; d[i + 1][1] = i; }
    for (let j = 0; j <= n; j++) { d[0][j + 1] = limit; d[1][j + 1] = j; }
    const last = new Map();
    for (let i = 1; i <= m; i++) {
      let lastMatch = 0;
      for (let j = 1; j <= n; j++) {
        const i1 = last.get(b[j - 1]) || 0, j1 = lastMatch;
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        if (!cost) lastMatch = j;
        d[i + 1][j + 1] = Math.min(d[i][j] + cost, d[i + 1][j] + 1, d[i][j + 1] + 1,
          d[i1][j1] + i - i1 - 1 + 1 + j - j1 - 1);
      }
      last.set(a[i - 1], i);
    }
    return d[m + 1][n + 1];
  }

  function analyze(first, second) {
    const reversed = first > second;
    const a = reversed ? second : first, b = reversed ? first : second;
    const blocks = matchingBlocks(a, b).filter((block) => block[2] >= RULES.minBlock);
    const matched = blocks.reduce((sum, block) => sum + block[2], 0);
    const maximum = Math.max(a.length, b.length), minimum = Math.min(a.length, b.length);
    const coverage = maximum ? matched / maximum : 0;
    const longest = Math.max(0, ...blocks.map((block) => block[2]));
    const reasons = [];
    let distance = null;
    if (a !== b && minimum >= 3) {
      if (coverage >= RULES.coverage && longest >= RULES.minLongest) reasons.push("coverage");
      if (blocks.length >= 2 && coverage >= RULES.multiCoverage && longest >= RULES.minLongest) reasons.push("segments");
      const allowed = minimum <= 4 ? RULES.shortDistance : Math.min(RULES.longDistance, Math.floor(maximum * RULES.maxDistanceRatio));
      if (Math.abs(a.length - b.length) <= allowed) {
        distance = editDistance(a, b);
        if (distance > 0 && distance <= allowed) reasons.push("distance");
      }
    }
    return { reasons, coverage, distance,
      blocks: reversed ? blocks.map(([i, j, length]) => [j, i, length]) : blocks };
  }

  function reasonText(match) {
    return match.reasons.map((reason) => ({
      coverage: `高覆盖率 ${Math.round(match.coverage * 100)}%`,
      segments: `多段匹配 ${match.blocks.length} 段`,
      distance: `编辑距离 ${match.distance}`,
      morphology: "词族／词根词缀"
    })[reason]).filter(Boolean).join(" · ");
  }

  return { RULES, matchingBlocks, editDistance, analyze, reasonText };
});
