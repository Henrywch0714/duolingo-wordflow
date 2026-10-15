const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { analyze, editDistance } = require("../nearforms.js");
const { wordnetRelations } = require("../scripts/build-nearforms.cjs");
const data = require("../nearforms.json");
const words = require("../words.json");

test("distance detects swaps and handles overlapping edit operations", () => {
  assert.equal(editDistance("form", "from"), 1);
  assert.equal(editDistance("CA", "ABC"), 2);
  assert.equal(editDistance("", "apple"), 5);
  assert.equal(editDistance("price", "prize"), 1);
  assert.deepEqual(analyze("form", "from").reasons, ["distance"]);
});

test("one long matching block and several substantial blocks can independently qualify", () => {
  const long = analyze("construction", "instruction");
  assert.ok(long.reasons.includes("coverage"));
  assert.ok(!long.reasons.includes("segments"));
  const several = analyze("price", "practice");
  assert.deepEqual(several.reasons, ["segments"]);
  assert.equal(several.coverage, 0.625);
});

test("a shared ending or two tiny blocks cannot create a match alone", () => {
  assert.deepEqual(analyze("conservative", "innovative").reasons, []);
  assert.deepEqual(analyze("abxxcd", "abyycd").reasons, []);
  assert.deepEqual(analyze("same", "same").reasons, []);
  assert.ok(!data.matches.conservative.some((entry) => entry.word === "innovative"));
});

test("results are symmetric and blocks preserve order without counting letters twice", () => {
  for (const [a, b] of [["communication", "complication"], ["later", "latter"], ["form", "from"]]) {
    const forward = analyze(a, b), reverse = analyze(b, a);
    assert.deepEqual(forward.reasons, reverse.reasons);
    assert.equal(forward.coverage, reverse.coverage);
    assert.equal(forward.distance, reverse.distance);
    assert.deepEqual(forward.blocks.map(([x, y, size]) => [y, x, size]), reverse.blocks);
    let endA = 0, endB = 0;
    for (const [x, y, size] of forward.blocks) {
      assert.ok(x >= endA && y >= endB && size >= 2);
      assert.equal(a.slice(x, x + size), b.slice(y, y + size));
      endA = x + size; endB = y + size;
    }
  }
});

test("WordNet pointers address individual words and shared lexical bases", () => {
  const fixture = fs.mkdtempSync(path.join(__dirname, "wordnet-fixture-"));
  const files = {
    noun: "00000001 00 n 02 decoy 0 construction 0 001 + 00000002 v 0202 | test\n",
    verb: "00000002 00 v 02 decoy_verb 0 construct 0 000 | test\n",
    adj: "00000003 00 a 01 constructive 0 001 + 00000002 v 0102 | test\n",
    adv: ""
  };
  try {
    for (const [part, body] of Object.entries(files)) fs.writeFileSync(path.join(fixture, `data.${part}`), body);
    const relations = wordnetRelations(fixture, new Set(["decoy", "construction", "constructive", "construct"]));
    assert.ok(relations.has("construct\u0000construction"));
    assert.ok(relations.has("construct\u0000constructive"));
    assert.ok(relations.has("construction\u0000constructive"));
    assert.ok([...relations].every((key) => !key.includes("decoy")));
  } finally {
    for (const part of Object.keys(files)) fs.unlinkSync(path.join(fixture, `data.${part}`));
    fs.rmdirSync(fixture);
  }
});

test("the generated graph is complete for this vocabulary, reciprocal and deduplicated", () => {
  const vocabulary = words.map((word) => word.word).sort();
  const hash = crypto.createHash("sha256").update(vocabulary.join("\n")).digest("hex");
  assert.equal(data.vocabularyHash, hash);
  assert.equal(data.wordCount, words.length);
  assert.deepEqual(Object.keys(data.matches).sort(), vocabulary);
  let pairs = 0;
  const counts = { coverage: 0, segments: 0, distance: 0, morphology: 0 };
  for (const [word, entries] of Object.entries(data.matches)) {
    assert.equal(new Set(entries.map((entry) => entry.word)).size, entries.length);
    for (const entry of entries) {
      assert.notEqual(entry.word, word);
      const reverse = data.matches[entry.word]?.find((other) => other.word === word);
      assert.ok(reverse);
      assert.deepEqual(entry.reasons, reverse.reasons);
      assert.deepEqual(entry.blocks.map(([x, y, size]) => [y, x, size]), reverse.blocks);
      assert.equal(new Set(entry.reasons).size, entry.reasons.length);
      if (word < entry.word) { pairs++; for (const reason of entry.reasons) counts[reason]++; }
    }
  }
  assert.equal(pairs, data.counts.pairs);
  for (const [reason, count] of Object.entries(counts)) assert.equal(count, data.counts[reason]);
  assert.ok(data.matches.happy.some((entry) => entry.word === "happiness" && entry.reasons.includes("morphology")));
});
