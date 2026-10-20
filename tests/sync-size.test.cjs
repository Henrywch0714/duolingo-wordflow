const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function handler(overrides = {}) {
  const saved = [];
  const records = { insertOne: async (record) => saved.push(record), ...overrides };
  const context = vm.createContext({ module: {exports: {}}, Buffer, Date, console, require: () => ({
    getSession: async () => ({id: "size-test"}), records: async () => records, sameOrigin: () => true
  }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../api/sync.js"), "utf8"), context);
  return { run: context.module.exports, saved };
}

test("sync accepts a large independent-review state and still rejects data beyond its limit", async () => {
  const { run, saved } = handler();
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const state = { dailyGoal: 20, deckOrder: Array(3590).fill("word"), progress: {}, history: {}, errorReviews: {},
    activeTask: { quiz: { serializedDraft: "x".repeat(2400000) } } };
  await run({method: "PUT", body: {revision: 0, state}}, res);
  assert.equal(res.code, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]._id, "progress:size-test");
  state.activeTask.quiz.serializedDraft = "x".repeat(4000000);
  await run({method: "PUT", body: {revision: 0, state}}, res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, "invalid_state");
  assert.equal(saved.length, 1);
});

test("an older client cannot overwrite the new independent-review schema", async () => {
  let writes = 0;
  const { run } = handler({
    updateOne: async (filter, update) => {
      const incoming = update.$set.state.version;
      assert.deepEqual(JSON.parse(JSON.stringify(filter.$or)), [{"state.version": {$exists: false}}, {"state.version": {$lte: incoming}}]);
      if (incoming < 5) return {matchedCount: 0};
      writes++; return {matchedCount: 1};
    },
    findOne: async () => ({state: {version: 5}})
  });
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const state = { version: 4, dailyGoal: 20, deckOrder: Array(3590).fill("word"), progress: {}, history: {} };
  await run({method: "PUT", body: {revision: 7, state}}, res);
  assert.equal(res.code, 409);
  assert.equal(res.body.error, "client_update_required");
  assert.equal(writes, 0);
  state.version = 5; state.errorReviews = {};
  await run({method: "PUT", body: {revision: 7, state}}, res);
  assert.equal(res.code, 200);
  assert.equal(writes, 1);
});
