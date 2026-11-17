import { getStore } from "@netlify/blobs";
import { timingSafeEqual, randomUUID, scryptSync, randomBytes, createHmac, randomInt } from "node:crypto";

/* Stat Tap API
   Roles:
   - owner  : the SaaS owner. Manages every business. Signs in at /admin.html
   - client : a business owner. Sees only their own business. Signs in at /login
   - public : customers leaving a review (no login), and businesses requesting a demo.
              Businesses are set up by the owner only; there is no public self sign-up.
   Google: after submitting, every customer is offered the business's Google review page, whatever
   their rating (no review gating). Only the owner can switch this on or off for a business;
   clients can't change it.
   Demo (trial): every new business starts as a demo (default 14 days). During a demo, reviews stay
   private and Google is always off. When it ends, the owner console flags it; nothing changes until
   the owner chooses: Go live (Google on), Extend, or End (cards stop working, client can't sign in).
   Businesses created before demos existed have no plan and count as live.
*/

const DAY = 86400000;
const TRIAL_DAYS = 14;
// "trial" | "live" | "ended". Businesses made before demos existed have no plan: they're live.
const planOf = (c) => (["trial", "live", "ended"].includes(c.plan) ? c.plan : "live");
const trialDaysLeft = (c) => (planOf(c) === "trial" ? Math.ceil((Date.parse(c.trialEnds || 0) - Date.now()) / DAY) : null);
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
  { id: "coffee", name: "Coffee shops & counter service", questions: [
    { label: "Drink & food quality", hint: "Taste, temperature and freshness" },
    { label: "Speed", hint: "How fast your order was ready" },
    { label: "Order accuracy", hint: "Got exactly what you ordered" },
    { label: "Friendly staff", hint: "Welcoming and helpful at the counter" },
    { label: "Cleanliness & vibe", hint: "Tables, counters and seating" } ] },
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
  { id: "notary", name: "Notary", questions: [
    { label: "On time", hint: "Arrived or ready at the scheduled time" },
    { label: "Accuracy", hint: "Documents done right, no errors or rejections" },
    { label: "Professionalism", hint: "Knowledgeable, explained what to sign" },
    { label: "Convenience", hint: "Easy to book, flexible hours or location" },
    { label: "Fair pricing", hint: "Fees clear up front, no surprises" } ] },
  { id: "other", name: "Something else", questions: [
    { label: "Overall quality", hint: "How good the product or service was" },
    { label: "Customer service", hint: "Friendly and helpful staff" },
    { label: "Wait time", hint: "How long things took" },
    { label: "Value", hint: "Worth what you paid" },
    { label: "Cleanliness", hint: "Tidy and well kept" } ] },
].map((ind) => ({ ...ind, questions: ind.questions.map((q, i) => ({ k: q.k || `q${i + 1}`, label: q.label, hint: q.hint })) }));
const industry = (id) => INDUSTRIES.find((x) => x.id === id) || null;
const DEFAULT_QS = INDUSTRIES[0].questions;
// Applies edited wording to a business's five questions. The keys stay the same so scores keep lining up.
const customQs = (base, edits) => base.map((q, i) => {
  const e = Array.isArray(edits) ? edits[i] || {} : {};
  const label = clean(e.label, 40), hint = clean(e.hint, 80);
  return { k: q.k, label: label || q.label, hint: "hint" in e ? hint : q.hint };
});
const questionsOf = (c) => (Array.isArray(c.questions) && c.questions.length === 5 ? c.questions : DEFAULT_QS);

const RESERVED = new Set(["login", "signup", "admin", "api", "review", "dashboard", "home", "about", "settings",
  "help", "support", "pricing", "terms", "privacy", "contact", "app", "www", "static", "assets", "demo", "owner",
  "stattap", "index", "favicon", "robots", "sitemap"]);
const isSlug = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s) && !s.includes("--") && !RESERVED.has(s);
const slugKey = (s) => `slugs/${s}`;

const store = () => getStore({ name: "review-desk", consistency: "strong" });
const json = (data, status = 200) => {
  // Log the reason for any rejected request (message only, never passwords) so problems can be traced.
  if (status >= 400 && data && data.error) console.log("rejected", status, data.error);
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

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
// Facebook / Tripadvisor links: web addresses only (never javascript: or other schemes).
const webLink = (v) => { const s = clean(v, 600); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : ""; };
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
    if (!c || !c.pwHash || (c.ver || 1) !== p.v || planOf(c) === "ended") return null;
    return { role: "client", client: c };
  }
  return null;
}

/* ---------- Shapes ---------- */
const publicClient = (c) => ({
  id: c.id, name: c.name, slug: c.slug || "", google: c.google || "", contact: c.contact || "",
  color: brandColor(c.color), questions: questionsOf(c),
  autoGoogle: planOf(c) === "live" && c.autoGoogle !== false, // never during a demo
  active: planOf(c) !== "ended",
  facebook: c.fbOn && c.facebook ? c.facebook : "",
  tripadvisor: c.taOn && c.tripadvisor ? c.tripadvisor : "",
});
const fullClient = (c) => ({
  ...publicClient(c), industry: c.industry || "restaurant", loginEmail: c.loginEmail || "",
  facebook: c.facebook || "", tripadvisor: c.tripadvisor || "", fbOn: !!c.fbOn, taOn: !!c.taOn,
  hasLogin: !!c.pwHash, mustChange: !!c.mustChange, selfSignup: !!c.selfSignup, createdAt: c.createdAt,
  plan: planOf(c), trialEnds: c.trialEnds || null, trialDaysLeft: trialDaysLeft(c), googleSetting: c.autoGoogle !== false,
});

/* ---------- Slugs ---------- */
async function slugFree(s, slug, ownId) {
  if (!isSlug(slug)) return false;
  const m = await s.get(slugKey(slug), { type: "json" });
  if (!m || m.clientId === ownId) return true;
  // An address left behind by a save that never finished (or a deleted business) is free again.
  return !(await s.get(`clients/${m.clientId}`, { type: "json" }));
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
    if (route === "save-check" && m === "GET") return json((await s.get("debug/lastfail", { type: "json" })) || {});
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
      if (planOf(c) === "ended") return json({ error: "This StatTap card isn't active right now." }, 403);
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

    // Businesses are set up by the owner. Old sign-up calls get a clear answer.
    if (route === "signup" && m === "POST")
      return json({ error: "StatTap accounts are set up for you. Request a demo at stattap.net/demo." }, 410);

    if (route === "demo-request" && m === "POST") {
      const b = await readBody();
      if (clean(b.website, 200)) return json({ ok: true }); // honeypot: pretend success for bots
      const business = clean(b.business, 160), name = clean(b.name, 120);
      const email = normEmail(b.email), phone = clean(b.phone, 40);
      if (!business) return json({ error: "Enter your business name.", field: "business" }, 400);
      if (!name) return json({ error: "Enter your name.", field: "name" }, 400);
      if (email && !isEmail(email)) return json({ error: "Check your email address.", field: "email" }, 400);
      if (!email && !phone) return json({ error: "Add an email or phone number so we can reach you.", field: "email" }, 400);
      if (await overLimit(s, req, "demo", 5)) return json({ error: "Too many requests from this connection. Try again later." }, 429);
      const ind = industry(b.industry);
      const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      await s.setJSON(`requests/${id}`, {
        id, business, name, email, phone,
        industry: ind ? ind.name : clean(b.industry, 60),
        locations: clean(b.locations, 20), notes: clean(b.notes, 1000),
        status: "new", createdAt: new Date().toISOString(),
      });
      return json({ ok: true });
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
      if (planOf(c) === "ended") return json({ error: "Your StatTap demo has ended. Contact StatTap to go live." }, 403);
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
      // Records why a save was refused (no passwords or emails), readable at /api/save-check.
      const fail = async (error, code = 400) => {
        await s.setJSON("debug/lastfail", { at: new Date().toISOString(), error, slug: String(b.slug || ""), pwLen: String(b.password || "").trim().length, hasEmail: !!String(b.loginEmail || "").trim(), editing: !!b.id }).catch(() => {});
        return json({ error }, code);
      };
      const name = clean(b.name, 160);
      if (!name) return await fail("Business name is required.", 400);
      const existing = isId(b.id) ? await s.get(`clients/${b.id}`, { type: "json" }) : null;
      if (isId(b.id) && !existing) return await fail("That business no longer exists.", 404);
      const id = existing?.id || randomUUID();
      const c = {
        ...(existing || {}), id, name,
        google: clean(b.google, 600), contact: clean(b.contact, 200),
        color: brandColor(b.color),
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      if ("autoGoogle" in b) c.autoGoogle = !!b.autoGoogle;
      else if (!existing) c.autoGoogle = false; // new businesses start private
      if ("facebook" in b) { c.facebook = webLink(b.facebook); if (clean(b.facebook, 600) && !c.facebook) return await fail("The Facebook link must start with https://", 400); }
      if ("tripadvisor" in b) { c.tripadvisor = webLink(b.tripadvisor); if (clean(b.tripadvisor, 600) && !c.tripadvisor) return await fail("The Tripadvisor link must start with https://", 400); }
      if ("fbOn" in b) c.fbOn = !!b.fbOn;
      if ("taOn" in b) c.taOn = !!b.taOn;
      // Industry and questions are set when the business is created. Changing them later would
      // mix old and new scores, so an existing business keeps its questions.
      if (existing && Array.isArray(b.questions)) c.questions = customQs(existing.questions || DEFAULT_QS, b.questions);
      if (!existing) {
        const ind = industry(b.industry) || INDUSTRIES[0];
        c.industry = ind.id; c.questions = customQs(ind.questions, b.questions);
        const days = Math.min(90, Math.max(1, parseInt(b.trialDays, 10) || TRIAL_DAYS));
        c.plan = "trial"; c.trialEnds = new Date(Date.now() + days * DAY).toISOString();
      }
      const wantSlug = String(b.slug ?? c.slug ?? "").trim().toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (wantSlug !== (c.slug || "") && wantSlug) {
        if (!isSlug(wantSlug)) return await fail("Use 3 to 40 lowercase letters, numbers or single dashes. Some words are reserved.", 400);
        if (!(await slugFree(s, wantSlug, id))) return await fail("That address is taken. Try adding your city.", 400);
      }
      const email = normEmail(b.loginEmail);
      const pw = String(b.password || "").trim();
      if (email) {
        if (!isEmail(email)) return await fail("Enter a valid email for the client login.", 400);
        const map = await s.get(loginKey(email), { type: "json" });
        if (map && map.clientId !== id) return await fail("That email is already used by another business.", 409);
        if (!c.pwHash && !pw) return await fail("Set a password for the client login.", 400);
      } else if (pw) {
        return await fail("Add a login email to go with the password.", 400);
      }
      if (pw) {
        if (pw.length < 8) return await fail("The client password needs at least 8 characters.", 400);
        const h = newHash(pw);
        c.pwSalt = h.salt; c.pwHash = h.hash; c.ver = (c.ver || 1) + 1; c.mustChange = true;
      }
      // Reserve the address only once everything else has passed, so a failed save can't lock it.
      const slugErr = await setSlug(s, c, wantSlug);
      if (slugErr) return await fail(slugErr, 400);
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

    // Demo lifecycle: go live, extend, or end.
    if (route === "admin/plan" && m === "POST") {
      const b = await readBody();
      const c = isId(b.id) ? await s.get(`clients/${b.id}`, { type: "json" }) : null;
      if (!c) return json({ error: "Business not found" }, 404);
      if (b.action === "live") { c.plan = "live"; c.autoGoogle = true; c.liveSince = new Date().toISOString(); }
      else if (b.action === "extend") {
        const days = Math.min(90, Math.max(1, parseInt(b.days, 10) || 7));
        const from = planOf(c) === "trial" ? Math.max(Date.now(), Date.parse(c.trialEnds || 0) || 0) : Date.now();
        c.plan = "trial"; c.trialEnds = new Date(from + days * DAY).toISOString();
      }
      else if (b.action === "end") { c.plan = "ended"; c.endedAt = new Date().toISOString(); }
      else return json({ error: "Unknown action" }, 400);
      await s.setJSON(`clients/${c.id}`, c);
      return json(fullClient(c));
    }

    if (route === "admin/requests" && m === "GET") {
      const { blobs } = await s.list({ prefix: "requests/" });
      const requests = (await getMany(s, blobs.map((x) => x.key))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ requests });
    }
    if (route === "admin/requests" && m === "PATCH") {
      const b = await readBody();
      if (!/^[a-z0-9-]{6,64}$/.test(String(b.id || "")) || !["new", "contacted", "won", "closed"].includes(b.status))
        return json({ error: "Invalid update" }, 400);
      const r = await s.get(`requests/${b.id}`, { type: "json" });
      if (!r) return json({ error: "Request not found" }, 404);
      r.status = b.status;
      await s.setJSON(`requests/${b.id}`, r);
      return json(r);
    }
    if (route === "admin/requests" && m === "DELETE") {
      const id = String(url.searchParams.get("id") || "");
      if (!/^[a-z0-9-]{6,64}$/.test(id)) return json({ error: "Invalid id" }, 400);
      await s.delete(`requests/${id}`);
      return json({ ok: true });
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
      if ("fbOn" in b && isOwner) c.fbOn = !!b.fbOn;
      if ("taOn" in b && isOwner) c.taOn = !!b.taOn;
      if ("facebook" in b) { const v = webLink(b.facebook); if (clean(b.facebook, 600) && !v) return json({ error: "The Facebook link must start with https://" }, 400); c.facebook = v; }
      if ("tripadvisor" in b) { const v = webLink(b.tripadvisor); if (clean(b.tripadvisor, 600) && !v) return json({ error: "The Tripadvisor link must start with https://" }, 400); c.tripadvisor = v; }
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
