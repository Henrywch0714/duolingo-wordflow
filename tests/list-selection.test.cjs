const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  class Element {
    constructor(tag = "div") {
      this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {};
      this.value = ""; this.checked = false; this.disabled = false; this.textContent = "";
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.textContent = ""; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]).filter((child) => child.tagName === "input" && child.type === "checkbox"); }
  }
  const elements = new Map(), storage = new Map();
  const document = { createElement: (tag) => new Element(tag), getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  } };
  const context = vm.createContext({ window: { WordflowReviewLists: require("../review-lists.js") }, document,
    localStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) },
    setTimeout: () => 0, clearTimeout() {}, console });
  const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const instrumented = source.replace(/  init\(\);\s*\}\)\(\);\s*$/, `
    globalThis.app = {
      setup(dictionary) {
        words = dictionary; wordMap = new Map(words.map(item => [item.word, item]));
        state = defaultState(); state.preferredDifficulties = ["易"];
        state.orderSignature = "v3:易"; state.deckOrder = words.map(item => item.word);
        state.progress = Object.fromEntries([...words.slice(0, 15), words[30]].map(item => [item.word,
          {wrongCount: 2, knownCount: 1, reviewCount: 2, systemReviewCount: 1, stage: 0, dueDate: "2020-01-01"}]));
        state.history[todayKey()] = {answers: {}, newWords: ["word10", "word11", "word30", "word29", "missing"]};
        authUser = {id: "selection-test"};
        renderQuiz = switchTab = renderOverview = renderMistakes = renderCalendar = renderToday = playAnswerTone = () => {};
        ensureDeckOrder();
      },
      renderTaskPicker, renderFreeLists, setFreeListScope, freeListGroups, startSelectedFreeLists,
      renderReviewPicker, startSelectedSystemLists, calendarInfo,
      seedErrors(entries) { state.errorReviews = entries; reviewLists.ensureRecords(state, activeCount, addDays(todayKey(), 1)); },
      today: todayKey,
      getState: () => state,
      selections: kind => [...(kind === "study" ? selectedStudyLists : kind === "review" ? selectedReviewLists : selectedFreeLists)],
      progressSnapshot: () => JSON.stringify({progress: state.progress, listReviews: state.listReviews}),
      question: () => quiz?.questions[quiz.index],
      answerQuiz, nextQuizQuestion, finishQuiz
    };
  })();`);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context);
  const dictionary = Array.from({ length: 35 }, (_, i) => ({ word: `word${i}`, gloss: `释义${i}`,
    difficulty: i >= 30 ? "难" : "易", polarity: i % 2 ? "负面" : "正向" }));
  context.app.setup(dictionary);
  document.getElementById("free-difficulty").value = "全部";
  document.getElementById("free-polarity").value = "全部";
  return { app: context.app, dictionary, get: (id) => document.getElementById(id) };
}

test("study and system review support select-all, partial selection and clearing", () => {
  for (const kind of ["study", "review"]) {
    const { app, dictionary, get } = harness();
    const groups = new Map([["unit:1:1", dictionary.slice(0, 10)], ["unit:1:2", dictionary.slice(10, 20)]]);
    const buttonId = kind === "study" ? "start-study-task" : "start-review-task";
    app.renderTaskPicker(`${kind}-list-picker`, groups, new Set(["stale-list"]), buttonId, kind);
    const all = get(`${kind}-select-all`), inputs = get(`${kind}-list-picker`).querySelectorAll();
    assert.equal(get(buttonId).disabled, true);
    all.checked = true; all.onchange();
    assert.equal(app.selections(kind).length, 2);
    assert.ok(inputs.every((input) => input.checked));
    inputs[0].checked = false; inputs[0].listeners.change();
    assert.equal(all.checked, false);
    assert.equal(all.indeterminate, true);
    assert.equal(get(buttonId).disabled, false);
    all.checked = false; all.onchange();
    assert.equal(app.selections(kind).length, 0);
    assert.ok(inputs.every((input) => !input.checked));
    assert.equal(all.indeterminate, false);
    assert.equal(get(buttonId).disabled, true);
  }
});

test("today view shows only Lists with learned new words today and keeps their learned members", () => {
  const { app, get } = harness();
  app.setFreeListScope("today");
  const groups = app.freeListGroups();
  assert.deepEqual([...groups.keys()], ["unit:1:2", "other:1"]);
  assert.equal(groups.get("unit:1:2").length, 5);
  assert.equal(groups.get("other:1").length, 1);
  assert.equal(get("free-scope-today").attributes["aria-pressed"], "true");
  assert.equal(get("review-today-new").disabled, false);
  const detail = get("free-list-picker").children[0].children[1].children[1].textContent;
  assert.match(detail, /可复习 5 词 · 今日新学 2 词/);
});

test("select-all stays within the current view and filters, and removes hidden selections", () => {
  const { app, get } = harness();
  app.renderFreeLists();
  const all = get("free-select-all");
  all.checked = true; all.onchange();
  assert.equal(app.selections("free").length, 3);
  app.setFreeListScope("today");
  assert.equal(app.selections("free").length, 0);
  all.checked = true; all.onchange();
  assert.equal(app.selections("free").length, 2);
  get("free-difficulty").value = "难";
  app.renderFreeLists();
  assert.deepEqual([...app.selections("free")], ["other:1"]);
  assert.equal(all.checked, true);
  get("free-polarity").value = "负面";
  app.renderFreeLists();
  assert.equal(app.selections("free").length, 0);
  assert.equal(all.disabled, true);
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, false);
  assert.equal(get("review-selected-lists").disabled, true);
});

test("a selected today List starts free review with learned members only and preserves progress", async () => {
  const { app, get } = harness();
  app.setFreeListScope("today");
  const input = get("free-list-picker").querySelectorAll()[0];
  input.checked = true; input.listeners.change();
  const before = app.progressSnapshot();
  app.startSelectedFreeLists();
  const task = app.getState().activeTask;
  assert.equal(task.type, "free");
  assert.deepEqual([...task.selectedWords].sort(), ["word10", "word11", "word12", "word13", "word14"]);
  for (let i = 0; i < 10; i++) { await app.answerQuiz(null); app.nextQuizQuestion(); }
  app.finishQuiz();
  assert.equal(app.progressSnapshot(), before);
  assert.equal(app.getState().taskSessions[0].completedWords.length, 5);
});

test("empty study and system pickers disable select-all and start buttons", () => {
  const { app, get } = harness();
  for (const kind of ["study", "review"]) {
    const buttonId = kind === "study" ? "start-study-task" : "start-review-task";
    app.renderTaskPicker(`${kind}-list-picker`, new Map(), new Set(), buttonId, kind);
    assert.equal(get(`${kind}-select-all`).disabled, true);
    assert.equal(get(buttonId).disabled, true);
  }
});

test("normal and error Lists share selection controls and distinguish duplicate words", () => {
  const { app, get } = harness();
  app.seedErrors(Object.fromEntries(["word0", "word30"].map((word) => [word, {
    cycleId: `cycle:${word}`, stage: 0, dueDate: "2020-01-01", createdDate: "2019-01-01", lastDate: null, reviewCount: 0, revision: 0
  }])));
  app.renderReviewPicker();
  const picker = get("review-list-picker");
  assert.deepEqual(picker.children.filter((child) => child.tagName === "h3").map((child) => child.textContent), ["常规 List", "错词复习"]);
  assert.deepEqual(picker.querySelectorAll().map((input) => input.value), ["unit:1:1", "error:1"]);
  assert.equal(get("system-error-plan").hidden, false);
  get("system-error-plan").open = true;
  app.renderReviewPicker();
  assert.equal(get("system-error-plan-list").children.length, 2);
  assert.equal(app.calendarInfo(app.today()).backlog, 12);
  const all = get("review-select-all");
  all.checked = true; all.onchange();
  app.startSelectedSystemLists();
  const task = app.getState().activeTask;
  assert.equal(task.selectedEntries.length, 12);
  assert.equal(task.selectedWords.filter((word) => word === "word0").length, 2);
  assert.equal(task.quiz.questions.length, 24);
});
