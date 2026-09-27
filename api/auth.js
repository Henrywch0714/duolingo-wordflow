const { randomBytes, randomUUID } = require("node:crypto");
const {
  clearSessionCookie, cookieToken, createSession, getSession,
  hashPassword, rateLimit, records, sameOrigin, sha256, verifyPassword
} = require("./_server");

function send(res, status, data) {
  res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  if (req.method === "POST" && !sameOrigin(req)) return send(res, 403, { error: "invalid_origin" });

  try {
    const docs = await records();
    if (req.method === "GET") {
      const user = await getSession(req, docs);
      return user ? send(res, 200, { user }) : send(res, 401, { error: "login_required" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object" || Buffer.byteLength(JSON.stringify(body), "utf8") > 2048) {
      return send(res, 400, { error: "invalid_request" });
    }
    if (body.action === "logout") {
      const token = cookieToken(req);
      if (token) await docs.deleteOne({ _id: `session:${sha256(token)}` });
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }
    if (!["register", "login"].includes(body.action)) return send(res, 400, { error: "invalid_request" });

    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = body.password;
    if (!/^[a-z0-9_]{3,32}$/.test(username) || typeof password !== "string" || password.length > 128) {
      return send(res, 400, { error: "invalid_credentials" });
    }
    const isRegister = body.action === "register";
    if (isRegister && password.length < 12) return send(res, 400, { error: "weak_password" });
    if (!(await rateLimit(req, docs, body.action, isRegister ? 5 : 15, isRegister ? 3600000 : 900000))) {
      return send(res, 429, { error: "too_many_attempts" });
    }

    if (isRegister) {
      const salt = randomBytes(16).toString("hex");
      const account = {
        _id: `account:${username}`,
        userId: randomUUID(),
        username,
        salt,
        passwordHash: await hashPassword(password, salt),
        createdAt: new Date()
      };
      try { await docs.insertOne(account); }
      catch (error) {
        if (error.code === 11000) return send(res, 409, { error: "username_taken" });
        throw error;
      }
      const user = await createSession(res, docs, account);
      return send(res, 201, { user });
    }

    const account = await docs.findOne({ _id: `account:${username}` });
    if (!(await verifyPassword(password, account))) return send(res, 401, { error: "invalid_credentials" });
    const user = await createSession(res, docs, account);
    await docs.deleteMany({ _id: /^session:/, expiresAt: { $lte: new Date() } });
    return send(res, 200, { user });
  } catch (error) {
    console.error("Auth API error:", error);
    return send(res, 503, { error: "auth_unavailable" });
  }
};
