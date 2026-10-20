const { test } = require("node:test");
const assert = require("node:assert/strict");
const lists = require("../review-lists.js");
const intervals = lists.INTERVALS;

function fixture(size = 25) {
  const deckOrder = Array.from({ length: size }, (_, i) => `word${i}`);
  const state = { deckOrder, progress: Object.fromEntries(deckOrder.map((word) => [word,
    { wrongCount: 3, knownCount: 2, reviewCount: 2, systemReviewCount: 0, stage: -1, dueDate: "2026-10-20" }])),
    listReviews: {}, errorReviews: {}, history: {} };
  lists.ensureRecords(state, size, "2026-10-21");
  return state;
}

function tracked(state, word, stage = 0, dueDate = "2026-10-20") {
  state.errorReviews[word] = { cycleId: `cycle:${word}`, stage, dueDate, createdDate: "2026-10-01", lastDate: null,
    reviewCount: 0, revision: 0 };
}

function taskFor(state, groups, id = "test-task") {
  const task = { id, type: "system", reviewPolicy: lists.POLICY, listKeys: groups.map((group) => group.key),
    listWords: Object.fromEntries(groups.map((group) => [group.key, group.words])), selectedWords: groups.flatMap((group) => group.words),
    completedWords: [], committedLists: [] };
  lists.prepareTask(state, task);
  return task;
}

function complete(task, key) { return new Map(task.listWords[key].map((word) => [word, 2])); }

test("normal List progression is identical for all-correct and all-wrong answers", () => {
  const correct = fixture(10), incorrect = fixture(10);
  const group = lists.dueLists(correct, 10, "2026-10-20");
  const a = taskFor(correct, group), b = taskFor(incorrect, group);
  lists.commitList(correct, a, complete(a, "unit:1:1"), new Map(), "unit:1:1", "2026-10-20", intervals);
  lists.commitList(incorrect, b, complete(b, "unit:1:1"), new Map(b.selectedWords.map((word) => [word, 2])), "unit:1:1", "2026-10-20", intervals);
  assert.deepEqual(correct.listReviews, incorrect.listReviews);
  assert.equal(correct.listReviews["unit:1:1"].dueDate, "2026-10-22");
  assert.equal(Object.keys(correct.errorReviews).length, 0);
  assert.equal(Object.keys(incorrect.errorReviews).length, 10);
  assert.ok(Object.values(incorrect.errorReviews).every((entry) => entry.stage === 0 && entry.dueDate === "2026-10-21"));
});

test("migration restores regular List stage from its count and leaves mistake-book statistics intact", () => {
  const state = fixture(10);
  for (const entry of Object.values(state.progress)) entry.systemReviewCount = 3;
  Object.assign(state.listReviews["unit:1:1"], { policy: 1, stage: -1, count: 3, lastDate: "2026-10-19", dueDate: "2026-10-20" });
  const statistics = () => JSON.stringify(Object.fromEntries(Object.entries(state.progress).map(([word, { stage, dueDate, ...entry }]) => [word, entry])));
  const before = statistics();
  lists.ensureRecords(state, 10, "2026-10-21");
  assert.equal(state.listReviews["unit:1:1"].stage, 3);
  assert.equal(state.listReviews["unit:1:1"].dueDate, "2026-10-26");
  assert.equal(statistics(), before);
  assert.ok(Object.values(state.progress).every((entry) => entry.stage === 3 && entry.dueDate === "2026-10-26"));
  assert.equal(Object.keys(state.errorReviews).length, 0);
  assert.equal(lists.ensureRecords(state, 10, "2026-10-21"), false);
});

test("due error Lists contain 10, 10 and 3 words; future errors remain outside today's task", () => {
  const state = fixture();
  for (const word of state.deckOrder.slice(0, 23)) tracked(state, word);
  tracked(state, "word23", 0, "2026-10-21");
  const groups = lists.dueErrorLists(state, "2026-10-20");
  assert.deepEqual(groups.map((group) => group.words.length), [10, 10, 3]);
  assert.deepEqual(groups.map((group) => group.key), ["error:1", "error:2", "error:3"]);
  assert.ok(groups.every((group) => !group.words.includes("word23")));
  assert.deepEqual(lists.dueErrorLists(state, "2026-10-21").map((group) => group.words.length), [10, 10, 4]);
});

test("an incomplete error List does not change statistics, its cycle, or history", () => {
  const state = fixture(10);
  for (const word of state.deckOrder) tracked(state, word, 3);
  const task = taskFor(state, lists.dueErrorLists(state, "2026-10-20"));
  const answers = complete(task, "error:1"); answers.set(task.listWords["error:1"][9], 1);
  const before = JSON.stringify({ state, task });
  assert.equal(lists.commitErrorList(state, task, answers, new Map([["word0", 2]]), "error:1", "2026-10-20", intervals), null);
  assert.equal(JSON.stringify({ state, task }), before);
});

test("error review resets only incorrect words and never changes regular List dates or counts", () => {
  const state = fixture(10);
  for (const word of state.deckOrder) tracked(state, word, 3);
  const normalBefore = JSON.stringify(state.listReviews);
  const task = taskFor(state, lists.dueErrorLists(state, "2026-10-20"));
  lists.commitErrorList(state, task, complete(task, "error:1"), new Map([["word0", 1]]), "error:1", "2026-10-20", intervals);
  assert.equal(state.errorReviews.word0.stage, 0);
  assert.equal(state.errorReviews.word0.dueDate, "2026-10-21");
  assert.equal(state.errorReviews.word1.stage, 4);
  assert.equal(state.errorReviews.word1.dueDate, "2026-11-04");
  assert.equal(state.progress.word0.wrongCount, 4);
  assert.equal(state.progress.word0.systemReviewCount, 0);
  assert.equal(state.progress.word0.dueDate, "2026-10-20");
  assert.equal(JSON.stringify(state.listReviews), normalBefore);
  assert.equal(lists.commitErrorList(state, task, complete(task, "error:1"), new Map(), "error:1", "2026-10-20", intervals), null);
});

test("an error leaves the pool only after passing all six scheduled intervals, including the 30-day review", () => {
  const state = fixture(1); tracked(state, "word0", 0, "2026-10-21");
  const dates = ["2026-10-21", "2026-10-23", "2026-10-27", "2026-11-03", "2026-11-18", "2026-12-18"];
  for (let i = 0; i < dates.length; i++) {
    const task = taskFor(state, lists.dueErrorLists(state, dates[i]), `step-${i}`);
    const result = lists.commitErrorList(state, task, complete(task, "error:1"), new Map(), "error:1", dates[i], intervals);
    assert.equal(result.removed, i === 5 ? 1 : 0);
    if (i < 5) assert.equal(state.errorReviews.word0.dueDate, dates[i + 1]);
  }
  assert.equal(state.errorReviews.word0, undefined);
  assert.equal(state.progress.word0.wrongCount, 3);
  assert.equal(state.progress.word0.systemReviewCount, 0);
});

test("failure on the 30-day review starts a new 1-day interval instead of retiring the word", () => {
  const state = fixture(1); tracked(state, "word0", 5);
  const task = taskFor(state, lists.dueErrorLists(state, "2026-10-20"));
  const result = lists.commitErrorList(state, task, complete(task, "error:1"), new Map([["word0", 2]]), "error:1", "2026-10-20", intervals);
  assert.equal(result.removed, 0);
  assert.equal(state.errorReviews.word0.stage, 0);
  assert.equal(state.errorReviews.word0.dueDate, "2026-10-21");
  assert.equal(state.progress.word0.wrongCount, 5);
});

test("normal/error duplicates remain independent regardless of which List commits first", () => {
  for (const retirement of [false, true]) {
    const outcomes = [];
    for (const order of [["normal", "error"], ["error", "normal"]]) {
      const state = fixture(1); tracked(state, "word0", retirement ? 5 : 2);
      const task = taskFor(state, [...lists.dueLists(state, 1, "2026-10-20"), ...lists.dueErrorLists(state, "2026-10-20")]);
      for (const kind of order) {
        const key = kind === "normal" ? "unit:1:1" : "error:1";
        const commit = kind === "normal" ? lists.commitList : lists.commitErrorList;
        commit(state, task, complete(task, key), kind === "normal" ? new Map([["word0", 2]]) : new Map(), key, "2026-10-20", intervals);
      }
      assert.equal(task.completedWords.length, 2);
      assert.equal(task.completedEntries.length, 2);
      assert.equal(state.listReviews["unit:1:1"].dueDate, "2026-10-22");
      assert.equal(state.progress.word0.wrongCount, 5);
      assert.equal(state.errorReviews.word0?.stage, retirement ? undefined : 3);
      assert.equal(state.progress.word0.lastAnswer, order.at(-1) === "normal" ? "unknown" : "known");
      const statistics = Object.fromEntries(Object.entries(state.progress).map(([word, { lastAnswer, ...entry }]) => [word, entry]));
      outcomes.push({ statistics, listReviews: state.listReviews, errorReviews: state.errorReviews });
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
  }
});

test("captured error Lists survive regrouping as previous Lists advance", () => {
  const state = fixture(23); for (const word of state.deckOrder) tracked(state, word);
  const task = taskFor(state, lists.dueErrorLists(state, "2026-10-20"));
  for (const key of ["error:1", "error:2", "error:3"]) {
    assert.ok(lists.commitErrorList(state, task, complete(task, key), new Map(), key, "2026-10-20", intervals));
  }
  assert.equal(task.completedEntries.length, 23);
  assert.equal(lists.dueErrorLists(state, "2026-10-20").length, 0);
  assert.ok(Object.values(state.errorReviews).every((entry) => entry.dueDate === "2026-10-22"));
});
