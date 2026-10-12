const { test } = require("node:test");
const assert = require("node:assert/strict");
const lists = require("../review-lists.js");
const intervals = [1, 2, 4, 7, 15, 30];

function fixture(size = 20, activeCount = size) {
  const deckOrder = Array.from({ length: size }, (_, i) => `word${i}`);
  const state = { deckOrder, progress: Object.fromEntries(deckOrder.map((word) => [word,
    { reviewCount: 3, wrongCount: 1, knownCount: 6, stage: 1, dueDate: "2026-10-10" }])),
    history: {}, listReviews: {} };
  lists.ensureRecords(state, activeCount, "2026-10-13");
  const groups = lists.groups(deckOrder, activeCount);
  const task = { type: "system", reviewPolicy: lists.POLICY, listWords: Object.fromEntries(groups.map((group) => [group.key, group.words])),
    selectedWords: groups.flatMap((group) => group.words), completedWords: [], committedLists: [] };
  return { state, task, groups };
}

test("legacy List count uses the minimum, including an unlearned word", () => {
  const { state } = fixture(10);
  state.progress.word4.systemReviewCount = 2;
  lists.ensureRecords(state, 10, "2026-10-13");
  assert.equal(state.listReviews["unit:1:1"].count, 2);
  delete state.progress.word9;
  lists.ensureRecords(state, 10, "2026-10-13");
  assert.equal(lists.minimumCount(state.progress, state.deckOrder), 0);
  assert.equal(lists.dueLists(state, 10, "2026-10-12").length, 0);
});

test("last preferred List keeps its actual size and excludes Other words", () => {
  const { state } = fixture(30, 13);
  const due = lists.dueLists(state, 13, "2026-10-12");
  assert.deepEqual(due.map((group) => group.words.length), [10, 3]);
  assert.equal(due.flatMap((group) => group.words).includes("word13"), false);
  assert.equal(lists.groups(state.deckOrder, 13, true)[2].words.length, 10);
});

test("19 of 20 questions cannot change progress, mistakes, dates or history", () => {
  const { state, task, groups } = fixture(10);
  const complete = new Map(groups[0].words.map((word) => [word, 2]));
  complete.set("word9", 1);
  const before = JSON.stringify({ state, task });
  assert.equal(lists.commitList(state, task, complete, new Map([["word0", 2]]), "unit:1:1", "2026-10-12", intervals), null);
  assert.equal(JSON.stringify({ state, task }), before);
});

test("whole List commits once and shares the next date; wrong counts stay per word", () => {
  const { state, task, groups } = fixture(10);
  const complete = new Map(groups[0].words.map((word) => [word, 2]));
  const wrong = new Map([["word0", 2], ["word1", 1]]);
  const result = lists.commitList(state, task, complete, wrong, "unit:1:1", "2026-10-12", intervals);
  assert.equal(result.count, 4);
  assert.equal(result.dueDate, "2026-10-13");
  assert.equal(state.progress.word0.wrongCount, 3);
  assert.equal(state.progress.word1.wrongCount, 2);
  assert.equal(state.progress.word2.wrongCount, 1);
  assert.equal(task.completedWords.length, 10);
  assert.equal(new Set(Object.values(state.progress).map((entry) => entry.dueDate)).size, 1);
  const saved = JSON.parse(JSON.stringify({ state, task }));
  assert.equal(lists.commitList(saved.state, saved.task, complete, wrong, "unit:1:1", "2026-10-12", intervals), null);
  assert.equal(saved.state.listReviews["unit:1:1"].count, 4);
});

test("completed List survives while an unfinished second List changes nothing", () => {
  const { state, task, groups } = fixture();
  const complete = new Map(groups[0].words.map((word) => [word, 2]));
  complete.set("word10", 2);
  const secondBefore = JSON.stringify(groups[1].words.map((word) => state.progress[word]));
  lists.commitList(state, task, complete, new Map(), "unit:1:1", "2026-10-12", intervals);
  assert.equal(lists.commitList(state, task, complete, new Map([["word10", 2]]), "unit:1:2", "2026-10-12", intervals), null);
  assert.deepEqual(task.committedLists, ["unit:1:1"]);
  assert.equal(task.completedWords.length, 10);
  assert.equal(JSON.stringify(groups[1].words.map((word) => state.progress[word])), secondBefore);
  assert.equal(state.listReviews["unit:1:1"].dueDate, "2026-10-16");
  assert.deepEqual(lists.dueLists(state, 20, "2026-10-12").map((group) => group.key), ["unit:1:2"]);
});

test("mistake reviews do not increase the List system count", () => {
  const { state } = fixture(10);
  for (const entry of Object.values(state.progress)) entry.reviewCount += 5;
  lists.ensureRecords(state, 10, "2026-10-13");
  assert.equal(state.listReviews["unit:1:1"].count, 3);
});

test("newly completed List starts after the last word was learned", () => {
  const { state } = fixture(10);
  state.listReviews = {};
  state.progress.word9.dueDate = "2026-10-13";
  lists.ensureRecords(state, 10, "2026-10-13", "unit:1:1");
  assert.equal(state.listReviews["unit:1:1"].dueDate, "2026-10-13");
  assert.equal(lists.dueLists(state, 10, "2026-10-12").length, 0);
});

test("a partial selected range cannot be submitted as a complete List", () => {
  const { state, task } = fixture(10);
  task.listWords["unit:1:1"] = ["word0"];
  const before = JSON.stringify(state);
  assert.equal(lists.commitList(state, task, new Map([["word0", 2]]), new Map(), "unit:1:1", "2026-10-12", intervals), null);
  assert.equal(JSON.stringify(state), before);
});
