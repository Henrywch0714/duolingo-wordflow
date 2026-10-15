const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nearforms = require("../nearforms.js");
const data = require("../nearforms.json");
const dictionary = require("../words.json");

function harness() {
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ""; this.hidden = true; this.textContent = ""; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.textContent = ""; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  }
  const elements = new Map();
  const document = { createElement: (tag) => new Element(tag), getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  } };
  const context = vm.createContext({ window: { WordflowReviewLists: require("../review-lists.js"), WordflowNearforms: nearforms }, document, console });
  const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const instrumented = source.replace(/  init\(\);\s*\}\)\(\);\s*$/, `
    globalThis.app = { setup(entries, data) {
      words = entries; wordMap = new Map(words.map(item => [item.word, item]));
      nearformData = data; state = defaultState(); state.progress.prize = {wrongCount: 3};
    }, renderNearformList, showInlineNearforms, resetNearforms, nearformRow,
    snapshot: () => JSON.stringify(state) };
  })();`);
  assert.notEqual(instrumented, source);
  vm.runInContext(instrumented, context);
  context.app.setup(dictionary, data);
  return { app: context.app, get: (id) => document.getElementById(id) };
}

test("looking up, opening and expanding nearforms never changes learning records", () => {
  const { app, get } = harness();
  const before = app.snapshot();
  get("nearform-search").value = "communication";
  app.renderNearformList();
  const article = get("nearform-list").children[0];
  assert.equal(article.children[0].textContent, "communication");
  assert.equal(article.children[2].open, true);
  app.showInlineNearforms("communication", "study");
  const inline = get("study-nearforms");
  assert.equal(inline.children.length, 6);
  inline.children[5].listeners.click();
  assert.equal(inline.children.length, data.matches.communication.length);
  assert.equal(get("study-nearforms-button").attributes["aria-expanded"], "true");
  app.resetNearforms("study", true);
  assert.equal(inline.hidden, true);
  assert.equal(get("study-nearforms-button").attributes["aria-expanded"], "false");
  assert.equal(app.snapshot(), before);
});

test("difference highlighting leaves matching single letters unchanged", () => {
  const { app } = harness();
  const row = app.nearformRow("price", data.matches.price.find((entry) => entry.word === "prize"));
  const spellings = row.children[0].children.map((cell) => cell.children[0]);
  assert.deepEqual(spellings.map((word) => word.children.filter((piece) => piece.tagName === "mark").map((piece) => piece.textContent).join("")), ["c", "z"]);
  assert.equal(row.children[3].textContent, "已学");
});

test("search handles Chinese, no matches and missing offline data", () => {
  const { app, get } = harness();
  get("nearform-search").value = "奖品";
  app.renderNearformList();
  assert.ok(get("nearform-list").children.some((article) => article.children[0].textContent === "prize"));
  get("nearform-search").value = "no-such-word-987";
  app.renderNearformList();
  assert.equal(get("nearform-empty").hidden, false);
  assert.equal(get("nearform-pagination").hidden, true);
  app.setup(dictionary, null);
  app.renderNearformList();
  assert.match(get("nearform-summary").textContent, /暂未加载/);
});
