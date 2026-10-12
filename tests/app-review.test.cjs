const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const reviewLists = require("../review-lists.js");

function appHarness(size = 20) {
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
      getState: () => state,
      getQuestion: () => quiz?.questions[quiz.index],
      restore() { state = normalizeState(JSON.parse(JSON.stringify(state))); quiz = null; restoreQuiz(); },
      today: todayKey
    };
  })();`;
  const instrumented = source.replace(/  init\(\);\s*\}\)\(\);\s*$/, exportHook);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context);
  const dictionary = Array.from({ length: size }, (_, i) => ({ word: `word${i}`, gloss: `释义${i}`, difficulty: "易" }));
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
