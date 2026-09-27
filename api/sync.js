const { getSession, records, sameOrigin } = require("./_server");

function send(res, status, data) {
  res.status(status).json(data);
}

function validState(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Number.isInteger(value.dailyGoal) && value.dailyGoal >= 10 && value.dailyGoal <= 3590 &&
    Array.isArray(value.deckOrder) && value.deckOrder.length === 3590 &&
    value.progress && typeof value.progress === "object" && !Array.isArray(value.progress) &&
    value.history && typeof value.history === "object" && !Array.isArray(value.history);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "PUT"].includes(req.method)) return send(res, 405, { error: "method_not_allowed" });
  if (req.method === "PUT" && !sameOrigin(req)) return send(res, 403, { error: "invalid_origin" });

  try {
    const docs = await records();
    const user = await getSession(req, docs);
    if (!user) return send(res, 401, { error: "login_required" });
    const id = `progress:${user.id}`;
    if (req.method === "GET") {
      const record = await docs.findOne({ _id: id }, { projection: { state: 1, revision: 1, _id: 0 } });
      return send(res, 200, record || { revision: 0, state: null });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const revision = body?.revision;
    const state = body?.state;
    if (!Number.isSafeInteger(revision) || revision < 0 || !validState(state) ||
        Buffer.byteLength(JSON.stringify(state), "utf8") > 1500000) {
      return send(res, 400, { error: "invalid_state" });
    }
    if (revision === 0) {
      try {
        await docs.insertOne({ _id: id, revision: 1, state, updatedAt: new Date() });
        return send(res, 200, { revision: 1 });
      } catch (error) {
        if (error.code === 11000) return send(res, 409, { error: "revision_conflict" });
        throw error;
      }
    }
    const result = await docs.updateOne(
      { _id: id, revision },
      { $set: { state, revision: revision + 1, updatedAt: new Date() } }
    );
    if (!result.matchedCount) return send(res, 409, { error: "revision_conflict" });
    return send(res, 200, { revision: revision + 1 });
  } catch (error) {
    console.error("Sync API error:", error);
    return send(res, 503, { error: "sync_unavailable" });
  }
};
