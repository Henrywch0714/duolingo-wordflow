const { createHash, timingSafeEqual } = require("node:crypto");
const { MongoClient } = require("mongodb");

const ORIGIN = "https://henrywch0714.github.io";
let clientPromise;

function send(res, status, data) {
  res.status(status).json(data);
}

function authorized(value) {
  const expected = process.env.SYNC_KEY_SHA256;
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const key = /^Bearer (.+)$/.exec(value || "")?.[1];
  if (!key) return false;
  const actual = createHash("sha256").update(key).digest();
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

async function collection() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000
    }).connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  const client = await clientPromise;
  return client.db("wordflow").collection("progress");
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
  if (req.headers.origin === ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "PUT"].includes(req.method)) return send(res, 405, { error: "method_not_allowed" });
  if (!authorized(req.headers.authorization)) return send(res, 401, { error: "invalid_sync_key" });

  try {
    const docs = await collection();
    if (req.method === "GET") {
      const record = await docs.findOne({ _id: "primary" }, { projection: { state: 1, revision: 1, _id: 0 } });
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
        await docs.insertOne({ _id: "primary", revision: 1, state, updatedAt: new Date() });
        return send(res, 200, { revision: 1 });
      } catch (error) {
        if (error.code === 11000) return send(res, 409, { error: "revision_conflict" });
        throw error;
      }
    }
    const result = await docs.updateOne(
      { _id: "primary", revision },
      { $set: { state, revision: revision + 1, updatedAt: new Date() } }
    );
    if (!result.matchedCount) return send(res, 409, { error: "revision_conflict" });
    return send(res, 200, { revision: revision + 1 });
  } catch (error) {
    console.error("Sync API error:", error);
    return send(res, 503, { error: "sync_unavailable" });
  }
};
