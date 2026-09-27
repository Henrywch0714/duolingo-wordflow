const { createHash, randomBytes, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { MongoClient } = require("mongodb");

const scrypt = promisify(scryptCallback);
const COOKIE = "__Host-wordflow_session";
const SESSION_DAYS = 90;
const ORIGIN = "https://duolingo-wordflow.vercel.app";
let clientPromise;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function records() {
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
  return (await clientPromise).db("wordflow").collection("progress");
}

function sameOrigin(req) {
  return req.headers.origin === ORIGIN;
}

function cookieToken(req) {
  const value = req.cookies?.[COOKIE] || (req.headers.cookie || "").split("; ")
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value || "") ? value : null;
}

async function getSession(req, docs) {
  const token = cookieToken(req);
  if (!token) return null;
  const doc = await docs.findOne({ _id: `session:${sha256(token)}` });
  if (!doc || !(doc.expiresAt instanceof Date) || doc.expiresAt <= new Date()) return null;
  return { id: doc.userId, username: doc.username };
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

async function hashPassword(password, salt) {
  return (await scrypt(password, Buffer.from(salt, "hex"), 64, {
    N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  })).toString("hex");
}

async function verifyPassword(password, account) {
  const actual = Buffer.from(await hashPassword(password, account?.salt || "00000000000000000000000000000000"), "hex");
  const expected = Buffer.from(account?.passwordHash || "00".repeat(64), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected) && Boolean(account);
}

async function createSession(res, docs, account) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await docs.insertOne({
    _id: `session:${sha256(token)}`,
    userId: account.userId,
    username: account.username,
    expiresAt,
    createdAt: new Date()
  });
  setSessionCookie(res, token);
  return { id: account.userId, username: account.username };
}

async function rateLimit(req, docs, action, max, windowMs) {
  const forwarded = req.headers["x-vercel-forwarded-for"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const ip = String(Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
  const id = `rate:${action}:${sha256(ip)}`;
  const now = new Date();
  const current = await docs.findOne({ _id: id });
  if (current?.resetAt instanceof Date && current.resetAt > now) {
    if (current.count >= max) return false;
    await docs.updateOne({ _id: id }, { $inc: { count: 1 } });
  } else {
    await docs.updateOne({ _id: id }, { $set: { count: 1, resetAt: new Date(Date.now() + windowMs) } }, { upsert: true });
  }
  return true;
}

module.exports = {
  clearSessionCookie, cookieToken, createSession, getSession,
  hashPassword, rateLimit, records, sameOrigin, sha256, verifyPassword
};
