/* ================================================================
   NEUROSYNC SERVER — servidor estático + contas + dados em arquivo
   Sem dependências externas (só módulos nativos do Node).
   Rode com: node server.js
   ================================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const USERS_DIR = path.join(DATA_DIR, "users");
fs.mkdirSync(USERS_DIR, { recursive: true });

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const sessions = new Map(); // token -> { userId, expires }

// Preço (R$) do tier "Padrinho" em app.html (TIERS) — só quem está nesse tier pode apadrinhar.
const PADRINHO_PRICE = 19.9;

/* ---------- utilidades de conta ---------- */
function userIdFor(email) {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
function userFile(userId) {
  return path.join(USERS_DIR, userId + ".json");
}
function readUser(userId) {
  try { return JSON.parse(fs.readFileSync(userFile(userId), "utf8")); }
  catch (e) { return null; }
}
function writeUser(userId, record) {
  fs.writeFileSync(userFile(userId), JSON.stringify(record));
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- ID público (código de amigo) ---------- */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I/L, difíceis de distinguir
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}
/** Procura uma conta pelo código público. Escala por diretório — ok para o tamanho de uma demo. */
function findByCode(code) {
  const target = String(code || "").trim().toUpperCase();
  if (!target) return null;
  for (const f of fs.readdirSync(USERS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const accountId = f.slice(0, -5);
    const user = readUser(accountId);
    if (user && user.code === target) return { accountId, user };
  }
  return null;
}
function uniqueCode() {
  let code;
  do { code = genCode(); } while (findByCode(code));
  return code;
}
function isPadrinho(user) {
  return !!(user.state && user.state.user && user.state.user.plan === "premium" && user.state.user.tier === PADRINHO_PRICE);
}
function isPremiumAlready(user) {
  return !!(user.state && user.state.user && user.state.user.plan === "premium");
}
function grantSponsoredPremium(user) {
  if (user.state && user.state.user) { user.state.user.plan = "premium"; user.state.user.tier = null; }
}
function revokeSponsoredPremium(user) {
  if (user.state && user.state.user) { user.state.user.plan = "basico"; user.state.user.tier = null; }
}
/** Forma pública de uma conta: o que os endpoints de auth/sponsor devolvem ao dono da conta. */
function publicAccount(user) {
  return {
    email: user.email, name: user.name, state: user.state,
    code: user.code,
    sponsoring: user.sponsoring || null,
    pendingInvite: user.pendingInvite || null,
    sponsoredBy: user.sponsoredBy || null
  };
}

/* ---------- sessões / cookies ---------- */
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function getSession(req) {
  const token = parseCookies(req).ns_session;
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess || sess.expires < Date.now()) { sessions.delete(token); return null; }
  return { token, ...sess };
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  const expires = new Date(Date.now() + SESSION_TTL_MS).toUTCString();
  res.setHeader("Set-Cookie", `ns_session=${token}; HttpOnly; Path=/; SameSite=Lax; Expires=${expires}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "ns_session=; HttpOnly; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
}
/** Sessão + registro do usuário autenticado, ou responde 401 e devolve null. */
function requireUser(req, res) {
  const sess = getSession(req);
  const user = sess && readUser(sess.userId);
  if (!user) { sendJSON(res, 401, { error: "not signed in" }); return null; }
  return { accountId: sess.userId, token: sess.token, user };
}

/* ---------- helpers HTTP ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 5_000_000) { reject(new Error("payload too large")); req.destroy(); return; }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
async function readJSONBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"
};
function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT) || full.startsWith(DATA_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(full, (err, content) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Não encontrado"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(content);
  });
}

/** Se `user` está apadrinhando alguém, desfaz o vínculo do lado do apadrinhado (usado ao remover/cancelar/apagar). */
function clearSponsoringSide(user) {
  if (!user.sponsoring || !user.sponsoring.code) return;
  const found = findByCode(user.sponsoring.code);
  if (found) {
    if (user.sponsoring.status === "pending" && found.user.pendingInvite && found.user.pendingInvite.fromCode === user.code) {
      found.user.pendingInvite = null;
    }
    if (user.sponsoring.status === "active" && found.user.sponsoredBy && found.user.sponsoredBy.code === user.code) {
      found.user.sponsoredBy = null;
      revokeSponsoredPremium(found.user);
    }
    writeUser(found.accountId, found.user);
  }
  user.sponsoring = null;
}
/** Se `user` é apadrinhado ou tem um convite pendente, libera a vaga de quem enviou (usado ao sair/recusar/apagar). */
function clearSponsoredSide(user) {
  const from = (user.sponsoredBy && user.sponsoredBy.code) || (user.pendingInvite && user.pendingInvite.fromCode);
  if (!from) return;
  const found = findByCode(from);
  if (found && found.user.sponsoring && found.user.sponsoring.code === user.code) {
    found.user.sponsoring = null;
    writeUser(found.accountId, found.user);
  }
}

/* ---------- API ---------- */
const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, `http://${req.headers.host}`).pathname; }
  catch (e) { res.writeHead(400); res.end("Bad request"); return; }

  try {
    if (pathname === "/api/signup" && req.method === "POST") {
      const body = await readJSONBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || "").trim().slice(0, 80);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return sendJSON(res, 400, { error: "E-mail inválido." });
      if (password.length < 6) return sendJSON(res, 400, { error: "A senha precisa ter ao menos 6 caracteres." });
      const userId = userIdFor(email);
      if (readUser(userId)) return sendJSON(res, 409, { error: "Já existe uma conta com este e-mail." });
      const salt = crypto.randomBytes(16).toString("hex");
      const record = {
        email, name, salt, hash: hashPassword(password, salt), createdAt: Date.now(),
        code: uniqueCode(), sponsoring: null, pendingInvite: null, sponsoredBy: null, state: null
      };
      writeUser(userId, record);
      startSession(res, userId);
      return sendJSON(res, 200, publicAccount(record));
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const body = await readJSONBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const userId = userIdFor(email);
      const user = readUser(userId);
      if (!user || !verifyPassword(password, user.salt, user.hash)) return sendJSON(res, 401, { error: "E-mail ou senha inválidos." });
      startSession(res, userId);
      return sendJSON(res, 200, publicAccount(user));
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      const cookies = parseCookies(req);
      if (cookies.ns_session) sessions.delete(cookies.ns_session);
      clearSessionCookie(res);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/me" && req.method === "GET") {
      const me = requireUser(req, res); if (!me) return;
      return sendJSON(res, 200, publicAccount(me.user));
    }

    if (pathname === "/api/state" && req.method === "POST") {
      const me = requireUser(req, res); if (!me) return;
      const body = await readJSONBody(req);
      me.user.state = body.state && typeof body.state === "object" ? body.state : null;
      // Apadrinhado não pode se "desapadrinhar" sozinho salvando um estado antigo por cima.
      if (me.user.sponsoredBy) grantSponsoredPremium(me.user);
      writeUser(me.accountId, me.user);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/account" && req.method === "DELETE") {
      const me = requireUser(req, res); if (!me) return;
      clearSponsoringSide(me.user);
      clearSponsoredSide(me.user);
      try { fs.unlinkSync(userFile(me.accountId)); } catch (e) {}
      sessions.delete(me.token);
      clearSessionCookie(res);
      return sendJSON(res, 200, { ok: true });
    }

    /* ---- Padrinhos: convidar, cancelar, remover, aceitar/recusar, sair ---- */

    if (pathname === "/api/sponsor/invite" && req.method === "POST") {
      const me = requireUser(req, res); if (!me) return;
      const u = me.user;
      if (!isPadrinho(u)) return sendJSON(res, 403, { error: "Só quem tem o plano Padrinho pode convidar alguém." });
      if (u.sponsoring) return sendJSON(res, 409, { error: "Você já está apadrinhando alguém. Remova antes de convidar outra pessoa." });
      const body = await readJSONBody(req);
      const code = String(body.code || "").trim().toUpperCase();
      if (!code) return sendJSON(res, 400, { error: "Informe o ID do seu amigo." });
      if (code === u.code) return sendJSON(res, 400, { error: "Você não pode convidar a si mesmo." });
      const found = findByCode(code);
      if (!found) return sendJSON(res, 404, { error: "Nenhuma conta encontrada com esse ID." });
      if (isPremiumAlready(found.user)) return sendJSON(res, 409, { error: "Essa pessoa já é Premium." });
      if (found.user.pendingInvite) return sendJSON(res, 409, { error: "Essa pessoa já tem um convite pendente." });
      u.sponsoring = { code: found.user.code, email: found.user.email, name: found.user.name, status: "pending" };
      found.user.pendingInvite = { fromCode: u.code, fromEmail: u.email, fromName: u.name };
      writeUser(found.accountId, found.user);
      writeUser(me.accountId, u);
      return sendJSON(res, 200, publicAccount(u));
    }

    if (pathname === "/api/sponsor/cancel" && req.method === "POST") {
      const me = requireUser(req, res); if (!me) return;
      const u = me.user;
      if (!u.sponsoring || u.sponsoring.status !== "pending") return sendJSON(res, 400, { error: "Não há convite pendente para cancelar." });
      clearSponsoringSide(u);
      writeUser(me.accountId, u);
      return sendJSON(res, 200, publicAccount(u));
    }

    if (pathname === "/api/sponsor/revoke" && req.method === "POST") {
      const me = requireUser(req, res); if (!me) return;
      const u = me.user;
      if (!u.sponsoring || u.sponsoring.status !== "active") return sendJSON(res, 400, { error: "Você não está apadrinhando ninguém no momento." });
      clearSponsoringSide(u);
      writeUser(me.accountId, u);
      return sendJSON(res, 200, publicAccount(u));
    }

    if (pathname === "/api/sponsor/respond" && req.method === "POST") {
      const me = requireUser(req, res); if (!me) return;
      const u = me.user;
      if (!u.pendingInvite) return sendJSON(res, 400, { error: "Você não tem nenhum convite pendente." });
      const body = await readJSONBody(req);
      const from = findByCode(u.pendingInvite.fromCode);
      if (body.accept) {
        if (!from) { u.pendingInvite = null; writeUser(me.accountId, u); return sendJSON(res, 410, { error: "Esse convite não é mais válido." }); }
        from.user.sponsoring = { code: u.code, email: u.email, name: u.name, status: "active" };
        writeUser(from.accountId, from.user);
        u.sponsoredBy = { code: from.user.code, email: from.user.email, name: from.user.name };
        grantSponsoredPremium(u);
      } else if (from && from.user.sponsoring && from.user.sponsoring.code === u.code) {
        from.user.sponsoring = null;
        writeUser(from.accountId, from.user);
      }
      u.pendingInvite = null;
      writeUser(me.accountId, u);
      return sendJSON(res, 200, publicAccount(u));
    }

    if (pathname === "/api/sponsor/leave" && req.method === "POST") {
      const me = requireUser(req, res); if (!me) return;
      const u = me.user;
      if (!u.sponsoredBy) return sendJSON(res, 400, { error: "Você não é apadrinhado por ninguém." });
      clearSponsoredSide(u);
      u.sponsoredBy = null;
      revokeSponsoredPremium(u);
      writeUser(me.accountId, u);
      return sendJSON(res, 200, publicAccount(u));
    }

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);

    res.writeHead(404); res.end("Not found");
  } catch (err) {
    sendJSON(res, 500, { error: "Erro interno do servidor." });
  }
});

server.listen(PORT, () => {
  console.log(`NeuroSync rodando em http://localhost:${PORT}`);
  console.log(`Dados salvos em: ${USERS_DIR}`);
});
