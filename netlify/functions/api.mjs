import { getStore } from "@netlify/blobs";
import { timingSafeEqual, randomUUID, scryptSync, randomBytes, createHmac, randomInt } from "node:crypto";

/* Stat Tap API
   Roles:
   - owner  : the SaaS owner. Manages every business. Signs in at /admin.html
   - client : a business owner. Sees only their own business. Signs in at /login
   - public : customers leaving a review (no login), and new businesses signing up
   Google: after submitting, every customer is offered the business's Google review page, whatever
   their rating (no review gating). Only the owner can switch this on or off for a business;
   clients can't change it. It's on by default.
*/

const DAY = 86400000;
const TOKEN_DAYS = 30;

/* ---------- Industry question sets ----------
   Restaurants keep the original keys so existing reviews keep their scores. */
const INDUSTRIES = [
  { id: "restaurant", name: "Restaurants", questions: [
    { k: "clean", label: "Cleanliness", hint: "Tables, floors and restrooms" },
    { k: "atmos", label: "Atmosphere", hint: "Music, lighting and comfort" },
    { k: "service", label: "Waiter service", hint: "Friendly and attentive staff" },
    { k: "present", label: "Meal presentation", hint: "How your food looked" },
    { k: "timing", label: "Meal timing", hint: "How long your food took" } ] },
  { id: "salon", name: "Salons & barbers", questions: [
    { label: "Your result", hint: "Did you get the look you asked for" },
    { label: "Your stylist", hint: "Who did your service" },
    { label: "Wait time", hint: "Seen on time for your appointment" },
    { label: "Consultation", hint: "Listened and explained clearly" },
    { label: "Cleanliness", hint: "Stations, tools and chairs" } ] },
  { id: "auto", name: "Auto repair", questions: [
    { label: "Quality of the work", hint: "Was the problem actually fixed" },
    { label: "Honest pricing", hint: "Final bill matched the quote" },
    { label: "Turnaround time", hint: "Ready when promised" },
    { label: "Communication", hint: "Explained the issue in plain terms" },
    { label: "Customer service", hint: "Friendly staff and waiting area" } ] },
  { id: "clinic", name: "Clinics & urgent care", questions: [
    { label: "Wait time", hint: "From check-in to being seen" },
    { label: "Your provider", hint: "Listened and took their time" },
    { label: "Front desk", hint: "Check-in and friendliness" },
    { label: "Explanation", hint: "Next steps were clear" },
    { label: "Billing clarity", hint: "Costs explained up front" } ] },
  { id: "dental", name: "Dental", questions: [
    { label: "Comfort", hint: "How comfortable you felt" },
    { label: "Your dentist or hygienist", hint: "Gentle, clear and unhurried" },
    { label: "Wait time", hint: "Seen close to your appointment" },
    { label: "Front desk", hint: "Scheduling and check-in" },
    { label: "Billing & insurance", hint: "No surprise charges" } ] },
  { id: "fitness", name: "Gyms & studios", questions: [
    { label: "Cleanliness", hint: "Equipment, mats and locker rooms" },
    { label: "Coaches & trainers", hint: "Helpful and motivating" },
    { label: "Classes", hint: "Schedule and quality" },
    { label: "Crowding", hint: "Space and equipment available" },
    { label: "Front desk", hint: "Membership and check-in" } ] },
  { id: "home", name: "Home services", questions: [
    { label: "Quality of the work", hint: "Done right the first time" },
    { label: "On time", hint: "Arrived in the window promised" },
    { label: "Fair pricing", hint: "Price matched the estimate" },
    { label: "Communication", hint: "Kept you in the loop" },
    { label: "Clean-up", hint: "Left your home tidy" } ] },
  { id: "hotel", name: "Hotels", questions: [
    { label: "Room cleanliness", hint: "Room and bathroom" },
    { label: "Check-in", hint: "Quick and welcoming" },
    { label: "Comfort & sleep", hint: "Bed, quiet and temperature" },
    { label: "Staff", hint: "Helpful during your stay" },
    { label: "Value", hint: "Worth what you paid" } ] },
  { id: "retail", name: "Retail", questions: [
    { label: "Selection", hint: "Found what you came for" },
    { label: "Staff help", hint: "Easy to get help" },
    { label: "Checkout", hint: "Quick line and payment" },
    { label: "Store tidiness", hint: "Clean and easy to shop" },
    { label: "Value", hint: "Fair prices" } ] },
  { id: "other", name: "Something else", questions: [
    { label: "Overall quality", hint: "How good the product or service was" },
    { label: "Customer service", hint: "Friendly and helpful staff" },
    { label: "Wait time", hint: "How long things took" },
    { label: "Value", hint: "Worth what you paid" },
    { label: "Cleanliness", hint: "Tidy and well kept" } ] },
].map((ind) => ({ ...ind, questions: ind.questions.map((q, i) => ({ k: q.k || `q${i + 1}`, label: q.label, hint: q.hint })) }));
const industry = (id) => INDUSTRIES.find((x) => x.id === id) || null;
const DEFAULT_QS = INDUSTRIES[0].questions;
const questionsOf = (c) => (Array.isArray(c.questions) && c.questions.length === 5 ? c.questions : DEFAULT_QS);

const RESERVED = new Set(["login", "signup", "admin", "api", "review", "dashboard", "home", "about", "settings",
  "help", "support", "pricing", "terms", "privacy", "contact", "app", "www", "static", "assets", "demo", "owner",
  "stattap", "index", "favicon", "robots", "sitemap"]);
const isSlug = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s) && !s.includes("--") && !RESERVED.has(s);
const slugKey = (s) => `slugs/${s}`;

const store = () => getStore({ name: "review-desk", consistency: "strong" });
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const isId = (v) => typeof v === "string" && /^[a-z0-9-]{6,64}$/i.test(v);
const normEmail = (e) => String(e || "").trim().toLowerCase();
const isEmail = (e) => e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (x, y) => {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && timingSafeEqual(a, b);
};
const hashPw = (pw, salt) => scryptSync(pw, salt, 32).toString("hex");
const newHash = (pw) => {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: hashPw(pw, salt) };
};
const checkPw = (pw, rec) => !!(rec && rec.salt && rec.hash && pw && same(rec.hash, hashPw(pw, rec.salt)));
const loginKey = (email) => `logins/${encodeURIComponent(email)}`;
const brandColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : "#8fa2ff");
const tempPassword = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = ""; for (let i = 0; i < 12; i++) s += a[randomInt(a.length)]; return s;
};
/* Clean a list of 5 questions sent by a page. Keys come from the template, never from the page. */
function cleanQuestions(list, base) {
  const qs = base.map((q, i) => {
    const x = Array.isArray(list) ? list[i] || {} : {};
    return { k: q.k, label: clean(x.label ?? q.label, 40), hint: clean(x.hint ?? q.hint, 70) };
  });
  const bad = qs.findIndex((q) => !q.label);
  return bad >= 0 ? { error: `Question ${bad + 1} needs a name.` } : { qs };
}

/* ---------- Sign-in tokens ---------- */
async function signingKey(s) {
  let c = await s.get("config/secret", { type: "json" });
  if (!c?.key) {
    await s.setJSON("config/secret", { key: randomBytes(32).toString("hex") });
    c = await s.get("config/secret", { type: "json" });
  }
  return c.key;
}
async function makeToken(s, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_DAYS * DAY })).toString("base64url");
  const sig = createHmac("sha256", await signingKey(s)).update(body).digest("base64url");
  return `${body}.${sig}`;
}
async function readToken(s, req) {
  const h = req.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const [body, sig] = tok.split(".");
  if (!body || !sig) return null;
  const expect = createHmac("sha256", await signingKey(s)).update(body).digest("base64url");
  if (!same(sig, expect)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!p || typeof p.exp !== "number" || p.exp < Date.now()) return null;
  return p;
}
async function authenticate(s, req) {
  const p = await readToken(s, req);
  if (!p) return null;
  if (p.r === "owner") {
    const cfg = await s.get("config/admin", { type: "json" });
    if (!cfg || (cfg.v || 1) !== p.v) return null;
    return { role: "owner" };
  }
  if (p.r === "client" && isId(p.c)) {
    const c = await s.get(`clients/${p.c}`, { type: "json" });
    if (!c || !c.pwHash || (c.ver || 1) !== p.v) return null;
    return { role: "client", client: c };
  }
  return null;
}

/* ---------- Shapes ---------- */
const publicClient = (c) => ({
  id: c.id, name: c.name, slug: c.slug || "", google: c.google || "", contact: c.contact || "",
  color: brandColor(c.color), questions: questionsOf(c),
  autoGoogle: c.autoGoogle !== false, // on unless the owner turned it off
});
const fullClient = (c) => ({
  ...publicClient(c), industry: c.industry || "restaurant", loginEmail: c.loginEmail || "",
  hasLogin: !!c.pwHash, mustChange: !!c.mustChange, selfSignup: !!c.selfSignup, createdAt: c.createdAt,
});

/* ---------- Slugs ---------- */
async function slugFree(s, slug, ownId) {
  if (!isSlug(slug)) return false;
  const m = await s.get(slugKey(slug), { type: "json" });
  return !m || m.clientId === ownId;
}
async function setSlug(s, c, slug) {
  if ((c.slug || "") === slug) return null;
  if (slug) {
    if (!isSlug(slug)) return "Use 3 to 40 lowercase letters, numbers or single dashes. Some words are reserved.";
    if (!(await slugFree(s, slug, c.id))) return "That address is taken. Try adding your city.";
    await s.setJSON(slugKey(slug), { clientId: c.id });
  }
  if (c.slug) await s.delete(slugKey(c.slug));
  c.slug = slug;
  return null;
}

/* ---------- Reviews ---------- */
// Review ids start with the creation time in base 36, so keys can be filtered by date without reading them.
const keyTime = (key) => {
  const t = parseInt(key.split("/").pop().split("-")[0], 36);
  return Number.isFinite(t) ? t : 0;
};
async function reviewKeys(s, cid) {
  const { blobs } = await s.list({ prefix: `reviews/${cid}/` });
  return blobs.map((b) => b.key);
}
async function getMany(s, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = await Promise.all(keys.slice(i, i + 40).map((k) => s.get(k, { type: "json" })));
    out.push(...chunk.filter(Boolean));
  }
  return out;
}
async function clientStats(s, cid) {
  const keys = await reviewKeys(s, cid);
  const now = Date.now();
  const rs = await getMany(s, keys.filter((k) => keyTime(k) >= now - 15 * DAY));
  const wk = rs.filter((r) => Date.parse(r.createdAt) >= now - 7 * DAY);
  const pv = rs.filter((r) => Date.parse(r.createdAt) < now - 7 * DAY && Date.parse(r.createdAt) >= now - 14 * DAY);
  const avg = (l) => (l.length ? l.reduce((x, r) => x + r.stars, 0) / l.length : null);
  return { total: keys.length, week: { n: wk.length, avg: avg(wk) }, prev: { n: pv.length, avg: avg(pv) } };
}

/* ---------- Simple rate limit (per IP, per hour) ---------- */
async function overLimit(s, req, bucket, max) {
  const ip = (req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const hour = Math.floor(Date.now() / 3600000);
  const key = `limits/${bucket}/${hour}/${encodeURIComponent(ip)}`;
  const cur = (await s.get(key, { type: "json" }))?.n || 0;
  if (cur >= max) return true;
  await s.setJSON(key, { n: cur + 1 });
  return false;
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const m = req.method;
  const s = store();
  const readBody = async () => (m === "GET" ? {} : await req.json().catch(() => ({})));

  try {
    /* ================= Public ================= */
    if (route === "industries" && m === "GET") return json({ industries: INDUSTRIES });

    if (route === "support" && m === "GET") {
      const cfg = await s.get("config/support", { type: "json" });
      return json({ contact: cfg?.contact || "" });
    }

    if (route === "client" && m === "GET") {
      let id = url.searchParams.get("id");
      const slug = String(url.searchParams.get("slug") || "").toLowerCase();
      if (!isId(id) && slug && /^[a-z0-9-]{3,40}$/.test(slug)) id = (await s.get(slugKey(slug), { type: "json" }))?.clientId;
      const c = isId(id) ? await s.get(`clients/${id}`, { type: "json" }) : null;
      if (!c) return json({ error: "Not found" }, 404);
      return json(publicClient(c));
    }

    if (route === "slug" && m === "GET") {
      const slug = String(url.searchParams.get("s") || "").toLowerCase();
      if (!isSlug(slug)) return json({ ok: false, reason: "format" });
      return json({ ok: await slugFree(s, slug, null) });
    }

    if (route === "review" && m === "POST") {
      const b = await readBody();
      const stars = Number(b.stars);
      if (!isId(b.clientId) || !Number.isInteger(stars) || stars < 1 || stars > 5)
        return json({ error: "Please choose an overall rating." }, 400);
      const c = await s.get(`clients/${b.clientId}`, { type: "json" });
      if (!c) return json({ error: "Unknown business" }, 404);
      const cats = {};
      for (const q of questionsOf(c)) {
        const v = Number(b.cats?.[q.k]);
        if (!Number.isInteger(v) || v < 1 || v > 5) return json({ error: "Please rate all five areas." }, 400);
        cats[q.k] = v;
      }
      if (clean(b.body, 4000).length < 10) return json({ error: "Please write a short review (at least 10 characters)." }, 400);
      if (!clean(b.name, 120)) return json({ error: "Please add your name." }, 400);
      if (await overLimit(s, req, "review", 30)) return json({ error: "Too many reviews from this connection. Try again later." }, 429);
      const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      await s.setJSON(`reviews/${c.id}/${id}`, {
        id, clientId: c.id, stars, cats,
        body: clean(b.body, 4000), name: clean(b.name, 120),
        status: "new", createdAt: new Date().toISOString(),
      });
      return json({ ok: true });
    }

    if (route === "signup" && m === "POST") {
      const b = await readBody();
      if (clean(b.website, 200)) return json({ error: "Sign-up failed." }, 400); // honeypot field real people never see
      const name = clean(b.name, 160);
      const slug = String(b.slug || "").trim().toLowerCase();
      const ind = industry(b.industry);
      const email = normEmail(b.email);
      const pw = String(b.password || "").trim();
      if (!name) return json({ error: "Enter your business name.", field: "name" }, 400);
      if (!isSlug(slug)) return json({ error: "Use 3 to 40 lowercase letters, numbers or single dashes for your address. Some words are reserved.", field: "slug" }, 400);
      if (!ind) return json({ error: "Choose the type of business that fits best.", field: "industry" }, 400);
      const q = cleanQuestions(b.questions, ind.questions);
      if (q.error) return json({ error: q.error, field: "questions" }, 400);
      if (!isEmail(email)) return json({ error: "Enter a valid email for your login.", field: "email" }, 400);
      if (pw.length < 8) return json({ error: "Your password needs at least 8 characters.", field: "password" }, 400);
      if (await s.get(loginKey(email), { type: "json" })) return json({ error: "That email already has a StatTap account. Log in instead.", field: "email" }, 409);
      if (!(await slugFree(s, slug, null))) return json({ error: "That address is taken. Try adding your city.", field: "slug" }, 409);
      if (await overLimit(s, req, "signup", 5)) return json({ error: "Too many sign-ups from this connection. Try again later." }, 429);
      const id = randomUUID();
      const h = newHash(pw);
      const c = {
        id, name, slug, industry: ind.id, questions: q.qs,
        google: clean(b.google, 600), contact: clean(b.contact, 200), color: brandColor(b.color),
        loginEmail: email, pwSalt: h.salt, pwHash: h.hash, ver: 1, selfSignup: true, autoGoogle: true,
        createdAt: new Date().toISOString(),
      };
      await s.setJSON(slugKey(slug), { clientId: id });
      await s.setJSON(loginKey(email), { clientId: id });
      await s.setJSON(`clients/${id}`, c);
      return json({ token: await makeToken(s, { r: "client", c: id, v: 1 }), role: "client", client: fullClient(c) });
    }

    if (route === "setup" && m === "GET") {
      const cfg = await s.get("config/admin", { type: "json" });
      return json({ needsSetup: !cfg });
    }

    if (route === "setup" && m === "POST") {
      if (await s.get("config/admin", { type: "json" }))
        return json({ error: "An owner password is already set. Sign in instead." }, 409);
      const b = await readBody();
      const pw = String(b.password || "").trim();
      if (pw.length < 8) return json({ error: "Use at least 8 characters." }, 400);
      await s.setJSON("config/admin", { ...newHash(pw), v: 1 });
      return json({ token: await makeToken(s, { r: "owner", v: 1 }), role: "owner" });
    }

    if (route === "login" && m === "POST") {
      const b = await readBody();
      const pw = String(b.password || "").trim();
      if (b.role === "owner") {
        const cfg = await s.get("config/admin", { type: "json" });
        if (!cfg) return json({ error: "Create your owner password first.", needsSetup: true }, 409);
        if (!checkPw(pw, cfg)) { await sleep(500); return json({ error: "That password is not right." }, 401); }
        return json({ token: await makeToken(s, { r: "owner", v: cfg.v || 1 }), role: "owner" });
      }
      const email = normEmail(b.email);
      const map = isEmail(email) ? await s.get(loginKey(email), { type: "json" }) : null;
      const c = map ? await s.get(`clients/${map.clientId}`, { type: "json" }) : null;
      if (!c || c.loginEmail !== email || !checkPw(pw, { salt: c.pwSalt, hash: c.pwHash })) {
        await sleep(500);
        return json({ error: "That email or password is not right." }, 401);
      }
      return json({ token: await makeToken(s, { r: "client", c: c.id, v: c.ver || 1 }), role: "client", mustChange: !!c.mustChange });
    }

    /* ================= Signed in ================= */
    const who = await authenticate(s, req);
    if (!who) return json({ error: "Please sign in again." }, 401);
    const isOwner = who.role === "owner";

    // A client signed in with a temporary password must choose a new one before anything else.
    if (!isOwner && who.client.mustChange && route !== "me/password")
      return json({ error: "Choose a new password to continue.", mustChange: true }, 403);

    /* ----- Owner only ----- */
    if (route.startsWith("admin/") && !isOwner) return json({ error: "Not allowed" }, 403);

    if (route === "admin/clients" && m === "GET") {
      const { blobs } = await s.list({ prefix: "clients/" });
      const clients = (await getMany(s, blobs.map((x) => x.key)))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const withStats = await Promise.all(clients.map(async (c) => ({ ...fullClient(c), stats: await clientStats(s, c.id) })));
      return json({ clients: withStats });
    }

    if (route === "admin/clients" && m === "POST") {
      const b = await readBody();
      const name = clean(b.name, 160);
      if (!name) return json({ error: "Business name is required." }, 400);
      const existing = isId(b.id) ? await s.get(`clients/${b.id}`, { type: "json" }) : null;
      if (isId(b.id) && !existing) return json({ error: "That business no longer exists." }, 404);
      const id = existing?.id || randomUUID();
      const c = {
        ...(existing || {}), id, name,
        google: clean(b.google, 600), contact: clean(b.contact, 200),
        color: brandColor(b.color),
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      if ("autoGoogle" in b) c.autoGoogle = !!b.autoGoogle;
      else if (!existing) c.autoGoogle = true;
      // Industry and questions are set when the business is created. Changing them later would
      // mix old and new scores, so an existing business keeps its questions.
      if (!existing) {
        const ind = industry(b.industry) || INDUSTRIES[0];
        c.industry = ind.id; c.questions = ind.questions;
      }
      const slugErr = await setSlug(s, c, String(b.slug ?? c.slug ?? "").trim().toLowerCase());
      if (slugErr) return json({ error: slugErr }, 400);
      const email = normEmail(b.loginEmail);
      const pw = String(b.password || "").trim();
      if (email) {
        if (!isEmail(email)) return json({ error: "Enter a valid email for the client login." }, 400);
        const map = await s.get(loginKey(email), { type: "json" });
        if (map && map.clientId !== id) return json({ error: "That email is already used by another business." }, 409);
        if (!c.pwHash && !pw) return json({ error: "Set a password for the client login." }, 400);
      } else if (pw) {
        return json({ error: "Add a login email to go with the password." }, 400);
      }
      if (pw) {
        if (pw.length < 8) return json({ error: "The client password needs at least 8 characters." }, 400);
        const h = newHash(pw);
        c.pwSalt = h.salt; c.pwHash = h.hash; c.ver = (c.ver || 1) + 1; c.mustChange = true;
      }
      const oldEmail = existing?.loginEmail || "";
      if (oldEmail && oldEmail !== email) {
        await s.delete(loginKey(oldEmail));
        if (!email) { delete c.pwSalt; delete c.pwHash; delete c.mustChange; c.ver = (c.ver || 1) + 1; }
      }
      c.loginEmail = email;
      if (email) await s.setJSON(loginKey(email), { clientId: id });
      await s.setJSON(`clients/${id}`, c);
      return json(fullClient(c));
    }

    if (route === "admin/reset-password" && m === "POST") {
      const b = await readBody();
      const c = isId(b.id) ? await s.get(`clients/${b.id}`, { type: "json" }) : null;
      if (!c) return json({ error: "Business not found" }, 404);
      if (!c.loginEmail) return json({ error: "This business has no client login yet. Add one with Edit." }, 400);
      const pw = tempPassword();
      const h = newHash(pw);
      c.pwSalt = h.salt; c.pwHash = h.hash; c.ver = (c.ver || 1) + 1; c.mustChange = true;
      await s.setJSON(`clients/${c.id}`, c);
      return json({ email: c.loginEmail, password: pw, name: c.name });
    }

    if (route === "admin/support" && m === "POST") {
      const b = await readBody();
      await s.setJSON("config/support", { contact: clean(b.contact, 200) });
      return json({ contact: clean(b.contact, 200) });
    }

    if (route === "admin/clients" && m === "DELETE") {
      const id = url.searchParams.get("id");
      const c = isId(id) ? await s.get(`clients/${id}`, { type: "json" }) : null;
      if (!c) return json({ error: "Not found" }, 404);
      const keys = await reviewKeys(s, id);
      for (let i = 0; i < keys.length; i += 40) await Promise.all(keys.slice(i, i + 40).map((k) => s.delete(k)));
      if (c.loginEmail) await s.delete(loginKey(c.loginEmail));
      if (c.slug) await s.delete(slugKey(c.slug));
      await s.delete(`clients/${id}`);
      return json({ ok: true });
    }

    if (route === "admin/password" && m === "POST") {
      const b = await readBody();
      const cfg = await s.get("config/admin", { type: "json" });
      if (!checkPw(String(b.current || "").trim(), cfg)) return json({ error: "Your current password is not right." }, 400);
      const pw = String(b.password || "").trim();
      if (pw.length < 8) return json({ error: "Use at least 8 characters." }, 400);
      const v = (cfg.v || 1) + 1;
      await s.setJSON("config/admin", { ...newHash(pw), v });
      return json({ token: await makeToken(s, { r: "owner", v }) });
    }

    /* ----- Owner or client (clients only ever reach their own business) ----- */
    const target = async (id) => {
      if (!isOwner) return who.client;
      return isId(id) ? await s.get(`clients/${id}`, { type: "json" }) : null;
    };

    if (route === "dashboard" && m === "GET") {
      const c = await target(url.searchParams.get("id"));
      if (!c) return json({ error: "Business not found" }, 404);
      const keys = await reviewKeys(s, c.id);
      const since = Date.now() - 26 * 7 * DAY;
      const reviews = (await getMany(s, keys.filter((k) => keyTime(k) >= since)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ client: fullClient(c), reviews, total: keys.length });
    }

    if (route === "reviews" && m === "PATCH") {
      const b = await readBody();
      const c = await target(b.clientId);
      if (!c || !isId(b.id) || !["new", "followed", "posted"].includes(b.status))
        return json({ error: "Invalid update" }, 400);
      const key = `reviews/${c.id}/${b.id}`;
      const r = await s.get(key, { type: "json" });
      if (!r) return json({ error: "Review not found" }, 404);
      r.status = b.status;
      await s.setJSON(key, r);
      return json(r);
    }

    if (route === "settings" && m === "POST") {
      const b = await readBody();
      const c = await target(b.clientId);
      if (!c) return json({ error: "Business not found" }, 404);
      if ("google" in b) c.google = clean(b.google, 600);
      if ("contact" in b) c.contact = clean(b.contact, 200);
      if ("color" in b) c.color = brandColor(b.color);
      if ("autoGoogle" in b && isOwner) c.autoGoogle = !!b.autoGoogle; // owner only; ignored from clients
      await s.setJSON(`clients/${c.id}`, c);
      return json(fullClient(c));
    }

    if (route === "me/password" && m === "POST" && !isOwner) {
      const b = await readBody();
      const c = who.client;
      if (!checkPw(String(b.current || "").trim(), { salt: c.pwSalt, hash: c.pwHash }))
        return json({ error: "Your current password is not right." }, 400);
      const pw = String(b.password || "").trim();
      if (pw.length < 8) return json({ error: "Use at least 8 characters." }, 400);
      if (same(pw, String(b.current || "").trim())) return json({ error: "Choose a password that's different from the temporary one." }, 400);
      const h = newHash(pw);
      c.pwSalt = h.salt; c.pwHash = h.hash; c.ver = (c.ver || 1) + 1; delete c.mustChange;
      await s.setJSON(`clients/${c.id}`, c);
      return json({ token: await makeToken(s, { r: "client", c: c.id, v: c.ver }) });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Server error" }, 500);
  }
};

export const config = { path: "/api/*" };
