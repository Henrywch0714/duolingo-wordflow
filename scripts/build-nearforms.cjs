const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { RULES, analyze } = require("../nearforms.js");

function wordnetRelations(dictDirectory, vocabulary) {
  const synsets = new Map();
  const pending = [];
  const normalize = (word) => word.toLowerCase().replace(/\((?:a|p|ip)\)$/, "");
  for (const [part, pos] of [["noun", "n"], ["verb", "v"], ["adj", "a"], ["adv", "r"]]) {
    for (const line of fs.readFileSync(path.join(dictDirectory, `data.${part}`), "utf8").split(/\r?\n/)) {
      if (!/^\d{8} /.test(line)) continue;
      const tokens = line.split(" | ")[0].trim().split(/\s+/);
      const count = Number.parseInt(tokens[3], 16);
      const lemmas = Array.from({ length: count }, (_, i) => normalize(tokens[4 + i * 2]));
      const id = `${pos}:${tokens[0]}`;
      synsets.set(id, lemmas);
      let cursor = 4 + count * 2;
      const pointers = Number(tokens[cursor++]);
      for (let i = 0; i < pointers; i++, cursor += 4) {
        const [symbol, offset, targetPos, indices] = tokens.slice(cursor, cursor + 4);
        // '+' is lexical derivation; adverb '\\' is explicitly derived from an adjective.
        if (symbol !== "+" && !(symbol === "\\" && pos === "r") && symbol !== "<") continue;
        const source = Number.parseInt(indices.slice(0, 2), 16) - 1;
        const target = Number.parseInt(indices.slice(2), 16) - 1;
        if (source < 0 || target < 0) continue;
        pending.push({ from: `${id}:${source}`, to: `${targetPos === "s" ? "a" : targetPos}:${offset}:${target}` });
      }
    }
  }
  const lemmaAt = (id) => { const [pos, offset, index] = id.split(":"); return synsets.get(`${pos}:${offset}`)?.[Number(index)]; };
  const neighbors = new Map();
  const edges = new Set();
  const add = (a, b) => {
    if (!a || !b || a === b || !vocabulary.has(a) || !vocabulary.has(b)) return;
    edges.add([a, b].sort().join("\u0000"));
  };
  for (const { from, to } of pending) {
    const a = lemmaAt(from), b = lemmaAt(to);
    if (!a || !b) throw new Error(`Invalid WordNet lexical pointer: ${from} -> ${to}`);
    add(a, b);
    // Related forms may share an exact lexical sense even if that base is outside our vocabulary.
    for (const [hub, related] of [[from, b], [to, a]]) {
      if (!vocabulary.has(related)) continue;
      if (!neighbors.has(hub)) neighbors.set(hub, new Set());
      neighbors.get(hub).add(related);
    }
  }
  for (const siblings of neighbors.values()) {
    const entries = [...siblings];
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) add(entries[i], entries[j]);
  }
  return edges;
}

function build(words, morphology) {
  const vocabulary = [...words.map((item) => item.word)].sort();
  const matches = Object.fromEntries(vocabulary.map((word) => [word, []]));
  const counts = { pairs: 0, coverage: 0, segments: 0, distance: 0, morphology: 0, words: 0 };
  for (let i = 0; i < vocabulary.length; i++) {
    const a = vocabulary[i];
    for (let j = i + 1; j < vocabulary.length; j++) {
      const b = vocabulary[j];
      const family = morphology.has(`${a}\u0000${b}`);
      // A pair below 60% possible length coverage cannot pass any spelling criterion.
      if (!family && Math.min(a.length, b.length) / Math.max(a.length, b.length) < RULES.multiCoverage) continue;
      const result = analyze(a, b);
      if (family) result.reasons.push("morphology");
      if (!result.reasons.length) continue;
      counts.pairs++;
      for (const reason of result.reasons) counts[reason]++;
      const entry = { reasons: result.reasons, coverage: Math.round(result.coverage * 10000) / 10000,
        distance: result.distance, blocks: result.blocks };
      matches[a].push({ word: b, ...entry });
      matches[b].push({ word: a, ...entry, blocks: entry.blocks.map(([x, y, length]) => [y, x, length]) });
    }
    if ((i + 1) % 500 === 0) console.log(`Compared ${i + 1}/${vocabulary.length} words`);
  }
  for (const entries of Object.values(matches)) entries.sort((a, b) => a.word.localeCompare(b.word, "en"));
  counts.words = Object.values(matches).filter((entries) => entries.length).length;
  return { version: 1, wordCount: words.length,
    vocabularyHash: crypto.createHash("sha256").update(vocabulary.join("\n")).digest("hex"),
    rules: RULES, source: "Princeton WordNet 3.1 lexical derivations, shared lexical bases, derived adverbs and participles",
    sourceUrl: "https://wordnet.princeton.edu/documentation/wninput5wn", counts, matches };
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const dictDirectory = process.argv[2];
  if (!dictDirectory) throw new Error("Usage: node scripts/build-nearforms.cjs <WordNet dict directory>");
  const words = JSON.parse(fs.readFileSync(path.join(root, "words.json"), "utf8"));
  const morphology = wordnetRelations(dictDirectory, new Set(words.map((entry) => entry.word)));
  console.log(`WordNet-supported pairs: ${morphology.size}`);
  const output = build(words, morphology);
  fs.writeFileSync(path.join(root, "nearforms.json"), JSON.stringify(output));
  console.log(output.counts);
}

module.exports = { wordnetRelations, build };
