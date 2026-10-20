const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const reviewLists = require("../review-lists.js");

function appHarness(size = 20, dictionaryOverride = null) {
  const elements = new Map();
  const storage = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: "", hidden: false, disabled: false,
      classList: { add() {}, remove() {} }, querySelectorAll: () => [] });
    return elements.get(id);
  } };
  const context = vm.createContext({ window: { WordflowReviewLists: reviewLists }, document,
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: () => 0, clearTimeout() {}, console });
  const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const exportHook = `
    globalThis.app = {
      setup(input, dictionary) {
        state = normalizeState(input); words = dictionary;
        wordMap = new Map(words.map(item => [item.word, item]));
        authUser = {id: "integration-test"};
        renderOverview = renderMistakes = renderFreeLists = renderCalendar = renderQuiz = switchTab = playAnswerTone = () => {};
        ensureDeckOrder();
      },
      startQuiz, answerQuiz, nextQuizQuestion, finishQuiz,
      systemReviewGroups, sameLearningData,
      getState: () => state,
      getQuestion: () => quiz?.questions[quiz.index],
      getQuestions: () => quiz?.questions,
      seedErrors(entries) { state.errorReviews = entries; reviewLists.ensureRecords(state, activeCount, addDays(todayKey(), 1)); },
      restore() { state = normalizeState(JSON.parse(JSON.stringify(state))); quiz = null; restoreQuiz(); },
      today: todayKey
    };
  })();`;
  const instrumented = source.replace(/  init\(\);\s*\}\)\(\);\s*$/, exportHook);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context);
  const dictionary = dictionaryOverride || Array.from({ length: size }, (_, i) => ({ word: `word${i}`, gloss: `释义${i}`, difficulty: "易" }));
  const input = { dailyGoal: 20, deckOrder: dictionary.map((item) => item.word), preferredDifficulties: ["易", "中", "难"],
    orderSignature: `v3:${["易", "中", "难"].sort().join("|")}`, progress: Object.fromEntries(dictionary.map((item, i) => [item.word,
      { reviewCount: i % 10 === 0 ? 1 : 3, wrongCount: 0, knownCount: 2, stage: 0, dueDate: "2020-01-01" }])), history: {} };
  context.app.setup(input, dictionary);
  return { app: context.app, dictionary, storage };
}

async function answerAndAdvance(app, wrong = false) {
  const question = app.getQuestion();
  await app.answerQuiz(wrong ? null : question.phase === 0 ? question.item.gloss : question.item.word);
  app.nextQuizQuestion();
}

test("actual app buffers 19 answers and discards them when the task ends", async () => {
  const { app, dictionary, storage } = appHarness(10);
  const before = JSON.stringify(app.getState().progress);
  app.startQuiz("system", dictionary, "review");
  for (let i = 0; i < 19; i++) await answerAndAdvance(app, true);
  assert.equal(JSON.stringify(app.getState().progress), before);
  app.finishQuiz();
  const saved = JSON.parse(storage.get("wordflow-state-v2:integration-test"));
  assert.equal(JSON.stringify(saved.progress), before);
  assert.equal(saved.activeTask, null);
  assert.equal(saved.taskSessions[0].completedWords.length, 0);
  assert.equal(saved.taskSessions[0].committedLists.length, 0);
  assert.equal(Object.keys(saved.history[app.today()]?.answers || {}).length, 0);
});

test("actual app restores a draft and commits the full List once", async () => {
  const { app, dictionary, storage } = appHarness(10);
  app.startQuiz("system", dictionary, "review");
  for (let i = 0; i < 9; i++) await answerAndAdvance(app, true);
  app.restore();
  for (let i = 0; i < 11; i++) await answerAndAdvance(app, true);
  assert.equal(app.getState().listReviews["unit:1:1"].count, 2);
  app.restore();
  app.finishQuiz();
  const saved = JSON.parse(storage.get("wordflow-state-v2:integration-test"));
  assert.equal(saved.listReviews["unit:1:1"].count, 2);
  assert.equal(saved.taskSessions[0].completedWords.length, 10);
  assert.ok(Object.values(saved.progress).every((entry) => entry.systemReviewCount === 2 && entry.wrongCount === 2));
});

test("actual app saves exactly one List after 39 of 40 questions", async () => {
  const { app, dictionary, storage } = appHarness();
  const before = JSON.parse(JSON.stringify(app.getState().progress));
  app.startQuiz("system", dictionary, "review");
  for (let i = 0; i < 39; i++) await answerAndAdvance(app, true);
  assert.equal(app.getState().activeTask.committedLists.length, 1);
  app.finishQuiz();
  const saved = JSON.parse(storage.get("wordflow-state-v2:integration-test"));
  const committed = saved.taskSessions[0].committedLists[0];
  const changed = new Set(saved.listReviews[committed].words);
  for (const word of dictionary.map((item) => item.word)) {
    if (changed.has(word)) assert.equal(saved.progress[word].wrongCount, 2);
    else assert.deepEqual(saved.progress[word], before[word]);
  }
  assert.equal(saved.taskSessions[0].completedWords.length, 10);
});

test("requesting one due word still starts its whole List", () => {
  const { app, dictionary } = appHarness();
  app.startQuiz("system", [dictionary[4]], "review");
  assert.equal(app.getState().activeTask.selectedWords.length, 10);
  assert.equal(app.getState().activeTask.listWords["unit:1:1"].length, 10);
});

function errorEntry(word, stage = 0) {
  return { cycleId: `cycle:${word}`, stage, dueDate: "2020-01-01", createdDate: "2019-01-01", lastDate: null, reviewCount: 0, revision: 0 };
}

test("mixed normal and error Lists generate four independent questions for a duplicate word", async () => {
  const { app } = appHarness(10);
  app.seedErrors({ word0: errorEntry("word0", 2) });
  const groups = app.systemReviewGroups();
  app.startQuiz("system", [...groups.values()].flat(), "review");
  const duplicates = app.getQuestions().filter((question) => question.item.word === "word0");
  assert.equal(duplicates.length, 4);
  assert.equal(new Set(duplicates.map((question) => question.item.entryId)).size, 2);
  assert.equal(duplicates.filter((question) => question.phase === 0).length, 2);
  const normalCount = app.getState().listReviews["unit:1:1"].count;
  for (let i = 0; i < 22; i++) {
    const question = app.getQuestion();
    await answerAndAdvance(app, question.item.reviewListKey === "error:1");
    if (i === 10) app.restore();
  }
  app.finishQuiz();
  const state = app.getState();
  assert.equal(state.listReviews["unit:1:1"].count, normalCount + 1);
  assert.equal(state.errorReviews.word0.stage, 0);
  assert.equal(state.progress.word0.wrongCount, 2);
  assert.equal(state.progress.word0.reviewCount, 3);
  const task = state.taskSessions[0];
  assert.equal(task.reason, "completed");
  assert.equal(task.selectedEntries.length, 11);
  assert.equal(task.completedEntries.length, 11);
  assert.equal(task.completedWords.filter((word) => word === "word0").length, 2);
});

test("finishing only the error copy cannot mark its unfinished normal copy as completed", async () => {
  const { app } = appHarness(10);
  app.seedErrors({ word0: errorEntry("word0") });
  app.startQuiz("system", [...app.systemReviewGroups().values()].flat(), "review");
  // Answer all but the last normal question; leave the two error questions complete.
  const questions = app.getQuestions();
  const lastNormal = questions.findIndex((question) => question.item.reviewListKey === "unit:1:1");
  [questions[lastNormal], questions[questions.length - 1]] = [questions[questions.length - 1], questions[lastNormal]];
  for (let i = 0; i < 21; i++) await answerAndAdvance(app, true);
  app.finishQuiz();
  const task = app.getState().taskSessions[0];
  assert.equal(task.reason, "ended");
  assert.equal(task.completedEntries.length, 1);
  assert.deepEqual([...task.committedLists], ["error:1"]);
  assert.equal(app.getState().listReviews["unit:1:1"].count, 1);
  assert.equal(app.getState().progress.word0.wrongCount, 2);
  assert.equal(app.getState().progress.word1.wrongCount, 0);
});

test("mistake-book practice updates cumulative wrong counts without touching either system schedule", async () => {
  const { app, dictionary } = appHarness(10);
  app.seedErrors({ word0: errorEntry("word0", 3) });
  const before = JSON.stringify({ listReviews: app.getState().listReviews, errorReviews: app.getState().errorReviews });
  app.startQuiz("mistake", [dictionary[0]], "mistakes");
  await answerAndAdvance(app, true); await answerAndAdvance(app, true);
  app.finishQuiz();
  assert.equal(app.getState().progress.word0.wrongCount, 2);
  assert.equal(JSON.stringify({ listReviews: app.getState().listReviews, errorReviews: app.getState().errorReviews }), before);
});

test("cloud comparison includes independent error schedules", () => {
  const { app } = appHarness(10);
  app.seedErrors({ word0: errorEntry("word0", 3) });
  const a = JSON.parse(JSON.stringify(app.getState())), b = JSON.parse(JSON.stringify(a));
  assert.equal(app.sameLearningData(a, b), true);
  b.errorReviews.word0.stage = 0;
  assert.equal(app.sameLearningData(a, b), false);
  delete b.errorReviews.word0;
  assert.equal(app.sameLearningData(a, b), false);
});

test("a full normal-plus-error task remains within a 4 MB sync request", () => {
  const { app, dictionary } = appHarness(3590, require("../words.json"));
  app.seedErrors(Object.fromEntries(dictionary.map((item) => [item.word, errorEntry(item.word)])));
  app.startQuiz("system", [...app.systemReviewGroups().values()].flat(), "review");
  assert.equal(app.getQuestions().length, 14360);
  const state = app.getState();
  state.activeTask.quiz.wrongByWord = state.activeTask.selectedEntries.map((id) => [id, 2]);
  state.activeTask.quiz.completedByWord = state.activeTask.selectedEntries.map((id) => [id, 2]);
  state.activeTask.completedEntries = [...state.activeTask.selectedEntries];
  state.activeTask.completedWords = [...state.activeTask.selectedWords];
  const bytes = Buffer.byteLength(JSON.stringify({ revision: 0, state }));
  assert.ok(bytes < 4000000);
});
