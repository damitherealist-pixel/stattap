/* Stat Tap — shared helpers and the business dashboard (used by both the client and owner pages). */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Default (restaurant) questions. Each business's own five questions replace these when its dashboard loads.
  let CATS = [
    { k: 'clean', label: 'Cleanliness' },
    { k: 'atmos', label: 'Atmosphere' },
    { k: 'service', label: 'Waiter service' },
    { k: 'present', label: 'Meal presentation' },
    { k: 'timing', label: 'Meal timing' },
  ];
  const catLabel = (k) => (k === 'overall' ? 'Overall rating' : (CATS.find((c) => c.k === k) || {}).label || k);
  const STATUS = { new: 'New', followed: 'Followed up', posted: 'On Google' };

  /* ---------- API ---------- */
  const RD = { token: null, onUnauthorized: null, onMustChange: null };
  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(RD.token ? { authorization: 'Bearer ' + RD.token } : {}) };
    let r;
    try { r = await fetch('/api/' + path, { ...opts, headers }); }
    catch (e) { throw new Error('Could not reach the server. Check your connection and try again.'); }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && RD.token && RD.onUnauthorized) RD.onUnauthorized();
    if (r.status === 403 && data.mustChange && RD.onMustChange) RD.onMustChange();
    if (!r.ok) { const e = new Error(data.error || 'Something went wrong. Try again.'); e.status = r.status; e.data = data; throw e; }
    return data;
  }

  /* ---------- Small helpers ---------- */
  function starsHtml(n) {
    n = Math.round(n || 0);
    let s = '';
    for (let i = 1; i <= 5; i++) s += i <= n ? '★' : '<span class="off">★</span>';
    return `<span class="stars" aria-label="${n} of 5 stars">${s}</span>`;
  }
  const fmt = (n) => (n == null ? '–' : n.toFixed(1));
  function deltaHtml(d) {
    if (d == null) return '<span class="flat">–</span>';
    const cls = d >= 0.1 ? 'up' : d <= -0.1 ? 'down' : 'flat';
    const arrow = cls === 'up' ? '▲ ' : cls === 'down' ? '▼ ' : '';
    const sign = d > 0.04 ? '+' : d < -0.04 ? '−' : '±';
    return `<span class="${cls}">${arrow}${sign}${Math.abs(d).toFixed(1)}</span>`;
  }
  const score = (r, k) => (k === 'overall' ? r.stars : (r.cats && typeof r.cats[k] === 'number' ? r.cats[k] : null));
  function avg(list, k) {
    let s = 0, n = 0;
    for (const r of list) { const v = score(r, k); if (v != null) { s += v; n++; } }
    return n ? s / n : null;
  }
  function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function weeks(count, from = new Date()) {
    const out = []; let s = weekStart(from);
    for (let i = 0; i < count; i++) { out.push({ start: s, end: addDays(s, 7) }); s = addDays(s, -7); }
    return out;
  }
  const inRange = (r, a, b) => { const t = Date.parse(r.createdAt); return t >= a.getTime() && t < b.getTime(); };
  const fmtDay = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fmtDate = (s) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  function googleUrl(g) { g = (g || '').trim(); if (!g) return ''; if (/^https?:\/\//i.test(g)) return g; return 'https://search.google.com/local/writereview?placeid=' + encodeURIComponent(g); }
  // A business with its own address gets stattap.net/<address>; older ones keep the review.html link.
  const reviewLink = (c) => (c && typeof c === 'object'
    ? (c.slug ? location.origin + '/' + c.slug : location.origin + '/review.html?c=' + c.id)
    : location.origin + '/review.html?c=' + c);
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = t), 1400); } return true; }
    catch (e) { if (btn) btn.textContent = 'Copy failed'; return false; }
  }
  function sparkline(vals, label) {
    const w = 128, h = 34, p = 4, n = vals.length;
    const X = (i) => p + (w - 2 * p) * (n < 2 ? 0 : i / (n - 1));
    const Y = (v) => p + (h - 2 * p) * (5 - v) / 4;
    let d = '', pen = false, last = -1;
    vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; last = i; });
    const dots = vals.map((v, i) => (v == null ? '' : `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${i === last ? 3 : 1.6}" fill="${i === last ? 'var(--accent)' : 'var(--muted)'}"/>`)).join('');
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label || 'Trend')}"><line x1="${p}" x2="${w - p}" y1="${Y(3)}" y2="${Y(3)}" stroke="var(--line)" stroke-dasharray="2 3"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
  }
  function qrSvg(text) {
    if (!window.qrcode) return '<p class="note">QR code could not load. Refresh the page to try again.</p>';
    const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag(4, 2);
  }

  /* ---------- Charts ---------- */
  const RATE_COLORS = { 5: 'var(--rate5)', 4: 'var(--rate4)', 3: 'var(--rate3)', 2: 'var(--rate2)', 1: 'var(--rate1)' };
  function lineChart(pts, title) {
    const W = 640, H = 230, L = 34, R = 18, T = 18, B = 32, n = pts.length;
    const X = (i) => L + (W - L - R) * (n < 2 ? 0.5 : i / (n - 1));
    const Y = (v) => T + (H - T - B) * (5 - v) / 4;
    const grid = [1, 2, 3, 4, 5].map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 10}" y="${Y(v) + 4}" text-anchor="end" class="ax">${v}★</text>`).join('');
    let d = '', pen = false;
    pts.forEach((p, i) => { if (p.v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1); pen = true; });
    const xl = pts.map((p, i) => `<text x="${X(i)}" y="${H - 10}" text-anchor="middle" class="ax${p.sel ? ' sel' : ''}">${esc(p.label)}</text>`).join('');
    const marks = pts.map((p, i) => p.v == null ? '' : `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="${p.sel ? 6 : 4}" fill="${p.sel ? 'var(--accent)' : 'var(--surface)'}" stroke="var(--accent)" stroke-width="2"/>`).join('');
    const sel = pts.findIndex((p) => p.sel && p.v != null);
    const selLabel = sel >= 0 ? `<text x="${X(sel)}" y="${Y(pts[sel].v) - 12}" text-anchor="middle" class="vl">${pts[sel].v.toFixed(1)}</text>` : '';
    const colW = (W - L - R) / Math.max(1, n - 1);
    const hits = pts.map((p, i) => `<rect class="hit" x="${(X(i) - colW / 2).toFixed(1)}" y="${T}" width="${colW.toFixed(1)}" height="${H - T - B}" fill="transparent" tabindex="0" data-tip="${esc(`<b>Week of ${p.label}</b><br>${p.v == null ? 'No reviews' : `Average ${p.v.toFixed(1)}★ · ${p.n} review${p.n === 1 ? '' : 's'}`}`)}"/>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${marks}${selLabel}${xl}${hits}</svg>`;
  }
  function donut(counts, avgVal) {
    const total = [5, 4, 3, 2, 1].reduce((a, s) => a + counts[s], 0);
    if (!total) return '<div class="empty">No reviews this week yet.</div>';
    const r = 70, C = 2 * Math.PI * r, segs = [5, 4, 3, 2, 1].filter((s) => counts[s]);
    const gap = segs.length > 1 ? 3 : 0;
    let off = 0;
    const arcs = segs.map((s) => {
      const len = (counts[s] / total) * C, a = `<circle cx="90" cy="90" r="${r}" fill="none" stroke="${RATE_COLORS[s]}" stroke-width="26" stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 90 90)" class="seg" tabindex="0" data-tip="${esc(`<b>${s} star${s > 1 ? 's' : ''}</b><br>${counts[s]} review${counts[s] === 1 ? '' : 's'} · ${Math.round((counts[s] / total) * 100)}%`)}"/>`;
      off += len; return a;
    }).join('');
    const legend = [5, 4, 3, 2, 1].map((s) => `<li><span class="sw" style="background:${RATE_COLORS[s]}"></span><span>${s} star${s > 1 ? 's' : ''}</span><b>${counts[s]}</b><span class="pct">${Math.round((counts[s] / total) * 100)}%</span></li>`).join('');
    return `<div class="donutwrap"><svg class="donut" viewBox="0 0 180 180" role="img" aria-label="Rating mix this week">${arcs}<text x="90" y="88" text-anchor="middle" class="dv">${avgVal == null ? '–' : avgVal.toFixed(1)}</text><text x="90" y="110" text-anchor="middle" class="dl">avg of ${total}</text></svg><ul class="dlegend">${legend}</ul></div>`;
  }
  function areaBars(rows) {
    return `<div class="legend"><span><i class="sw" style="background:var(--accent)"></i>This week</span><span><i class="sw" style="background:var(--prev-bar)"></i>Last week</span></div>
      <div class="hbars">${rows.map((x) => `
        <div class="hb">
          <div class="hb-l"><span>${esc(x.label)}</span>${deltaHtml(x.d)}</div>
          <div class="hb-t" data-tip="${esc(`<b>${x.label}</b><br>This week ${fmt(x.now)}★<br>Last week ${fmt(x.prev)}★`)}" tabindex="0">
            <div class="hb-row"><i style="width:${x.now == null ? 0 : (x.now / 5) * 100}%;background:var(--accent)"></i><span>${fmt(x.now)}</span></div>
            <div class="hb-row"><i style="width:${x.prev == null ? 0 : (x.prev / 5) * 100}%;background:var(--prev-bar)"></i><span>${fmt(x.prev)}</span></div>
          </div>
        </div>`).join('')}</div>`;
  }
  function attachTips(root) {
    let tip = document.getElementById('vtip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'vtip'; tip.className = 'vtip'; tip.hidden = true; document.body.appendChild(tip); }
    const show = (el, x, y) => { tip.innerHTML = el.dataset.tip; tip.hidden = false; const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2)) + 'px'; tip.style.top = Math.max(8, y - h - 14) + 'px'; };
    root.addEventListener('mousemove', (e) => { const el = e.target.closest('[data-tip]'); if (el && root.contains(el)) show(el, e.clientX, e.clientY); else tip.hidden = true; });
    root.addEventListener('mouseleave', () => (tip.hidden = true));
    root.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) { const b = el.getBoundingClientRect(); show(el, b.left + b.width / 2, b.top); } });
    root.addEventListener('focusout', () => (tip.hidden = true));
    window.addEventListener('scroll', () => (tip.hidden = true), { passive: true });
  }

  /* ---------- Weekly report maths ---------- */
  function weeklyReport(R, wIdx) {
    const ws = weeks(wIdx + 10);
    const w = ws[wIdx], p = ws[wIdx + 1];
    const W = R.filter((r) => inRange(r, w.start, w.end)), P = R.filter((r) => inRange(r, p.start, p.end));
    const trendWeeks = ws.slice(wIdx, wIdx + 8).reverse();
    const row = (k) => {
      const a = avg(W, k), b = avg(P, k);
      return { k, label: catLabel(k), now: a, prev: b, d: a != null && b != null ? a - b : null,
        trend: trendWeeks.map((x) => avg(R.filter((r) => inRange(r, x.start, x.end)), k)) };
    };
    const overall = row('overall');
    const cats = CATS.map((c) => row(c.k));
    const trendPts = trendWeeks.map((x, i) => { const rs = R.filter((r) => inRange(r, x.start, x.end)); return { label: fmtDay(x.start), v: avg(rs, 'overall'), n: rs.length, sel: i === trendWeeks.length - 1 }; });
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; W.forEach((r) => { if (counts[r.stars] != null) counts[r.stars]++; });
    let verdict;
    if (!W.length) verdict = { cls: 'neutral', tag: 'No data yet', title: 'No reviews this week', text: 'Share the review link or QR code with guests to start collecting reviews for this week.' };
    else if (!P.length) verdict = { cls: 'neutral', tag: 'First week', title: `Average ${fmt(overall.now)} from ${W.length} review${W.length > 1 ? 's' : ''}`, text: 'There were no reviews the week before, so there is nothing to compare yet. Next week’s report will show growth or decline.' };
    else {
      const d = overall.d;
      if (d >= 0.1) verdict = { cls: 'good', tag: 'Growth', title: `Rating up from ${fmt(overall.prev)} to ${fmt(overall.now)}`, text: '' };
      else if (d > -0.1) verdict = { cls: 'neutral', tag: 'Holding steady', title: `Rating steady at ${fmt(overall.now)}`, text: '' };
      else if (d > -0.3) verdict = { cls: 'warn', tag: 'Slight decline', title: `Rating down from ${fmt(overall.prev)} to ${fmt(overall.now)}`, text: '' };
      else verdict = { cls: 'bad', tag: 'Decline', title: `Rating down from ${fmt(overall.prev)} to ${fmt(overall.now)}`, text: '' };
    }
    const declining = cats.filter((c) => c.d != null && c.d <= -0.2).sort((a, b) => a.d - b.d);
    const improving = cats.filter((c) => c.d != null && c.d >= 0.2).sort((a, b) => b.d - a.d);
    const ranked = cats.filter((c) => c.now != null).sort((a, b) => b.now - a.now);
    if (verdict.cls !== 'neutral' || (W.length && P.length)) {
      if (declining.length) verdict.text = `The biggest drop is in ${declining[0].label.toLowerCase()} (${fmt(declining[0].prev)} → ${fmt(declining[0].now)}).`;
      else if (overall.d != null && overall.d <= -0.1) verdict.text = 'No single area dropped sharply. The dip is spread across several areas.';
      else if (improving.length) verdict.text = `${improving[0].label} improved the most (${fmt(improving[0].prev)} → ${fmt(improving[0].now)}).`;
      else verdict.text = 'All five areas stayed close to last week.';
    }
    const drivers = declining.map((c) => ({
      ...c,
      lowCount: W.filter((r) => score(r, c.k) != null && score(r, c.k) <= 2).length,
      rated: W.filter((r) => score(r, c.k) != null).length,
      quotes: W.filter((r) => score(r, c.k) != null && score(r, c.k) <= 3 && r.body).sort((a, b) => score(a, c.k) - score(b, c.k)).slice(0, 2),
    }));
    return { w, p, W, P, overall, cats, verdict, drivers, improving, trendPts, counts, best: ranked[0], worst: ranked[ranked.length - 1] };
  }

  /* ---------- Dashboard ---------- */
  function Dashboard(root, { clientId = null, isOwner = false, onBack = null, onToken = null } = {}) {
    const st = { data: null, tab: 'reviews', cat: 'all', star: 'all', status: 'all', sort: 'new', week: 0, qr: false };
    try { const t = localStorage.getItem('rd-dtab'); if (['reviews', 'report', 'settings'].includes(t)) st.tab = t; } catch (e) {}
    root.innerHTML = '<div class="panel empty">Loading reviews…</div>';
    const q = clientId ? '?id=' + encodeURIComponent(clientId) : '';

    async function load() {
      try { st.data = await api('dashboard' + q); useQuestions(); render(); }
      catch (e) { root.innerHTML = `<div class="panel empty">${esc(e.message)}<div style="margin-top:12px"><button class="btn" data-act="retry">Try again</button></div></div>`; }
    }
    async function refresh() {
      try { st.data = await api('dashboard' + q); useQuestions(); if (st.tab !== 'settings') renderPane(); } catch (e) {}
    }
    function useQuestions() {
      const qs = st.data && st.data.client && st.data.client.questions;
      if (Array.isArray(qs) && qs.length) CATS = qs.map((x) => ({ k: x.k, label: x.label }));
      if (st.cat !== 'all' && !CATS.some((c) => c.k === st.cat)) st.cat = 'all';
    }

    function render() {
      const c = st.data.client;
      root.innerHTML = `
        ${isOwner ? `<div class="backbar row" style="margin-bottom:14px"><button class="btn ghost" data-act="back">← All businesses</button><span class="note">You are viewing this business as the owner.</span></div>` : ''}
        <div class="row spread" style="margin-bottom:16px">
          <div class="row"><span class="dot" style="background:${esc(c.color)}"></span><h2 style="font-size:1.35rem">${esc(c.name)}</h2></div>
          <div class="tabs" role="tablist">${[['reviews', 'Reviews'], ['report', 'Weekly report'], ['settings', 'Settings']]
            .map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${st.tab === k}">${l}</button>`).join('')}</div>
        </div>
        <div id="pane"></div>`;
      renderPane();
    }
    function renderPane() {
      const pane = $('#pane', root); if (!pane) return;
      pane.innerHTML = st.tab === 'report' ? paneReport() : st.tab === 'settings' ? paneSettings() : paneReviews();
      if (st.tab === 'settings' && st.qr) { const b = $('#qrbox', root); if (b) b.innerHTML = qrSvg(reviewLink(st.data.client)); }
    }

    /* ----- Reviews tab with the 5 category tabs ----- */
    function paneReviews() {
      const R = st.data.reviews;
      const now = new Date(), d30 = addDays(now, -30), d60 = addDays(now, -60);
      const last30 = R.filter((r) => new Date(r.createdAt) >= d30);
      const prev30 = R.filter((r) => { const t = new Date(r.createdAt); return t >= d60 && t < d30; });
      const k = st.cat === 'all' ? 'overall' : st.cat;
      const tabs = [{ k: 'all', label: 'All reviews' }, ...CATS].map((t) => {
        const kk = t.k === 'all' ? 'overall' : t.k;
        return `<button role="tab" data-cat="${t.k}" aria-selected="${st.cat === t.k}">${t.label} <b>${fmt(avg(last30, kk))}</b></button>`;
      }).join('');
      const a30 = avg(last30, k), p30 = avg(prev30, k);
      const dist = [5, 4, 3, 2, 1].map((s) => ({ s, n: last30.filter((r) => score(r, k) === s).length }));
      const tot = dist.reduce((a, b) => a + b.n, 0) || 1;
      const wk = weeks(8).reverse();
      const spark = wk.map((w) => avg(R.filter((r) => inRange(r, w.start, w.end)), k));
      const follow = R.filter((r) => r.stars <= 3 && r.status === 'new').length;

      let list = R.filter((r) => score(r, k) != null);
      if (st.star === 'low') list = list.filter((r) => r.stars <= 3 && r.status === 'new');
      else if (st.star !== 'all') list = list.filter((r) => score(r, k) === +st.star);
      if (st.status !== 'all') list = list.filter((r) => r.status === st.status);
      if (st.sort === 'low') list = [...list].sort((a, b) => score(a, k) - score(b, k) || b.createdAt.localeCompare(a.createdAt));
      if (st.sort === 'high') list = [...list].sort((a, b) => score(b, k) - score(a, k) || b.createdAt.localeCompare(a.createdAt));
      const chipBase = R.filter((r) => score(r, k) != null);
      const chips = [['all', 'All'], ['5', '5 ★'], ['4', '4 ★'], ['3', '3 ★'], ['2', '2 ★'], ['1', '1 ★'], ['low', 'Needs follow-up']].map(([v, l]) => {
        const n = v === 'all' ? chipBase.length : v === 'low' ? follow : chipBase.filter((r) => score(r, k) === +v).length;
        return `<button class="chip" data-star="${v}" aria-pressed="${st.star === v}">${l} <span style="opacity:.6">${n}</span></button>`;
      }).join('');

      return `
        <div class="panel" style="padding:0 16px 16px">
          <div class="cattabs" role="tablist" aria-label="Rating categories">${tabs}</div>
          <div class="summary" style="padding-top:18px">
            <div><div class="note">${esc(catLabel(k))} · last 30 days</div>
              <div class="row" style="align-items:baseline;gap:10px;margin-top:4px"><span class="big">${fmt(a30)}</span>${a30 != null ? starsHtml(a30) : ''}</div>
              <div class="note" style="margin-top:6px">${deltaHtml(a30 != null && p30 != null ? a30 - p30 : null)} vs the 30 days before · ${last30.filter((r) => score(r, k) != null).length} ratings</div></div>
            <div class="dist" aria-label="Rating breakdown">${dist.map((x) => `<div><span>${x.s}★</span><span class="bar"><i style="width:${(x.n / tot) * 100}%"></i></span><span>${x.n}</span></div>`).join('')}</div>
            <div><div class="note" style="margin-bottom:4px">Last 8 weeks</div>${sparkline(spark, catLabel(k) + ' over the last 8 weeks')}</div>
          </div>
        </div>
        <div class="panel stack" style="margin-top:14px">
          <div class="row spread">
            <div class="chips">${chips}</div>
            <div class="row">
              <select class="inline" data-filter="status" aria-label="Status"><option value="all">Any status</option>${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${st.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <select class="inline" data-filter="sort" aria-label="Sort"><option value="new" ${st.sort === 'new' ? 'selected' : ''}>Newest first</option><option value="low" ${st.sort === 'low' ? 'selected' : ''}>Lowest ${st.cat === 'all' ? 'rating' : 'score'} first</option><option value="high" ${st.sort === 'high' ? 'selected' : ''}>Highest first</option></select>
            </div>
          </div>
          <div>${list.length ? list.slice(0, 300).map((r) => reviewItem(r)).join('') : `<div class="empty">${R.length ? 'No reviews match these filters.' : 'No reviews yet. Share the review link from Settings to collect your first one.'}</div>`}</div>
          ${list.length > 300 ? '<p class="note">Showing the first 300. Use the filters to narrow the list.</p>' : ''}
        </div>`;
    }
    function reviewItem(r) {
      const cats = r.cats ? `<div class="catscores">${CATS.map((c) => { const v = r.cats[c.k]; return `<span class="cs ${v <= 2 ? 'low' : ''} ${st.cat === c.k ? 'cur' : ''}">${c.label} <b>${v ?? '–'}</b></span>`; }).join('')}</div>` : '';
      return `<div class="review">
        <div class="review-meta">${starsHtml(r.stars)}<strong>${esc(r.name || 'Anonymous')}</strong><span>${fmtDate(r.createdAt)}</span><span class="pill ${esc(r.status)}">${STATUS[r.status] || 'New'}</span></div>
        ${cats}
        ${r.body ? `<p>${esc(r.body)}</p>` : '<p class="note">No written comment.</p>'}
        <div class="row">
          <select class="inline" data-rid="${r.id}" aria-label="Status">${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${r.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${r.body ? `<button class="btn" data-copy="${r.id}">Copy text</button>` : ''}
        </div></div>`;
    }

    /* ----- Weekly report tab ----- */
    function paneReport() {
      const rep = weeklyReport(st.data.reviews, st.week);
      const opts = weeks(12).map((w, i) => `<option value="${i}" ${st.week === i ? 'selected' : ''}>${fmtDay(w.start)} – ${fmtDay(addDays(w.end, -1))}${i === 0 ? ' (this week)' : i === 1 ? ' (last week)' : ''}</option>`).join('');
      const rows = [rep.overall, ...rep.cats].map((x, i) => `<tr class="${i === 0 ? 'total' : ''}"><td>${esc(x.label)}</td><td>${fmt(x.now)}</td><td>${fmt(x.prev)}</td><td>${deltaHtml(x.d)}</td><td>${sparkline(x.trend, x.label + ' trend')}</td></tr>`).join('');
      const vol = `${rep.W.length} review${rep.W.length === 1 ? '' : 's'} this week · ${rep.P.length} the week before`;
      const drivers = rep.drivers.length ? rep.drivers.map((d) => `
          <div class="driver"><h3>${esc(d.label)} ${deltaHtml(d.d)}</h3>
            <p class="note">Fell from ${fmt(d.prev)} to ${fmt(d.now)}. ${d.lowCount} of ${d.rated} guests rated it 2 stars or lower this week.</p>
            ${d.quotes.map((r) => `<p class="quote">“${esc(r.body.length > 220 ? r.body.slice(0, 220) + '…' : r.body)}” <span class="note">— ${esc(r.name || 'Guest')}, ${d.label.toLowerCase()} ${score(r, d.k)}★</span></p>`).join('')}
          </div>`).join('')
        : `<p class="note">${rep.W.length && rep.P.length ? 'No area dropped by 0.2 stars or more this week.' : 'This section fills in once there are two weeks of reviews to compare.'}</p>`;
      const improving = rep.improving.length ? rep.improving.map((c) => `<li>${esc(c.label)}: ${fmt(c.prev)} → ${fmt(c.now)} ${deltaHtml(c.d)}</li>`).join('') : '<li class="note">No area rose by 0.2 stars or more.</li>';
      return `
        <div class="stack">
          <div class="row spread no-print">
            <label class="row" style="font-weight:600;gap:8px" for="weekSel">Week <select id="weekSel" class="inline" data-filter="week">${opts}</select></label>
            <button class="btn" data-act="print">Print or save as PDF</button>
          </div>
          <div class="verdict ${rep.verdict.cls}">
            <span class="tag">${esc(rep.verdict.tag)} · ${fmtDay(rep.w.start)} – ${fmtDay(addDays(rep.w.end, -1))}</span>
            <h2>${esc(rep.verdict.title)}</h2>
            ${rep.verdict.text ? `<p style="margin:0">${esc(rep.verdict.text)}</p>` : ''}
            <p class="note">${vol}${rep.W.length && rep.W.length < 5 ? '. With fewer than 5 reviews, small changes can swing the average.' : ''}</p>
          </div>
          <div class="chartgrid">
            <div class="panel"><h2>Rating trend</h2><p class="note" style="margin-bottom:8px">Average rating each week, last 8 weeks</p>${lineChart(rep.trendPts, 'Average rating each week for the last 8 weeks')}</div>
            <div class="panel"><h2>Rating mix</h2><p class="note" style="margin-bottom:8px">How guests rated the selected week</p>${donut(rep.counts, rep.overall.now)}</div>
          </div>
          <div class="panel">
            <h2>Each area, this week vs last week</h2><p class="note" style="margin-bottom:10px">Out of 5 stars</p>
            ${areaBars(rep.cats)}
          </div>
          <div class="panel">
            <h2 style="margin-bottom:8px">Full numbers</h2>
            <div class="tablewrap"><table><thead><tr><th>Area</th><th>This week</th><th>Last week</th><th>Change</th><th>Last 8 weeks</th></tr></thead><tbody>${rows}</tbody></table></div>
          </div>
          <div class="grid2">
            <div class="panel"><h2 style="margin-bottom:6px">${rep.overall.d != null && rep.overall.d < 0 ? 'Where the decline is coming from' : 'Areas to watch'}</h2>${drivers}</div>
            <div class="panel stack">
              <div><h2 style="margin-bottom:6px">What improved</h2><ul style="margin:0;padding-left:18px;display:grid;gap:4px">${improving}</ul></div>
              ${rep.best ? `<div><h2 style="margin-bottom:6px">Strongest and weakest</h2><p style="margin:0">Strongest: <b>${esc(rep.best.label)}</b> (${fmt(rep.best.now)})<br>Weakest: <b>${esc(rep.worst.label)}</b> (${fmt(rep.worst.now)})</p></div>` : ''}
            </div>
          </div>
        </div>`;
    }

    /* ----- Settings tab ----- */
    function paneSettings() {
      const c = st.data.client, link = reviewLink(c);
      return `
        <div class="grid2">
          <div class="panel stack">
            <h2>Review link</h2>
            <p class="note">One link for every guest. Write it to your StatTap NFC cards, text or email it, or print the QR code for tables, menus and receipts.</p>
            <div class="mono">${esc(link)}</div>
            <div class="row"><button class="btn primary" data-act="copylink">Copy link</button><button class="btn" data-act="qr">${st.qr ? 'Hide QR code' : 'Show QR code'}</button><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open review page</a></div>
            ${st.qr ? '<div class="qr" id="qrbox"></div>' : ''}
          </div>
          <form class="panel form" id="settingsForm">
            <h2>Google reviews</h2>
            <p class="note">After submitting, every guest is offered your Google review page with their review already copied, so they only paste it and press Post. Every guest gets this whatever their rating, which keeps your business within Google's rules. Add your Google link below to turn it on.</p>
            <label for="sGoogle">Google review link or Place ID<input id="sGoogle" type="text" value="${esc(c.google)}" placeholder="https://g.page/r/.../review"></label>
            <label for="sContact">Contact for unhappy guests <small>Shown to guests who rate 1–3 stars.</small><input id="sContact" type="text" value="${esc(c.contact)}" placeholder="manager@restaurant.com or phone"></label>
            <label for="sColor">Brand color<input id="sColor" type="color" value="${esc(c.color)}"></label>
            <div class="row"><button class="btn primary" type="submit">Save settings</button><span class="note" id="sMsg" role="status"></span></div>
          </form>
          ${isOwner ? '' : `
          <form class="panel form" id="pwForm">
            <h2>Change your password</h2>
            <label for="pCur">Current password<input id="pCur" type="password" autocomplete="current-password" required></label>
            <label for="pNew">New password <small>At least 8 characters</small><input id="pNew" type="password" autocomplete="new-password" required minlength="8"></label>
            <div class="row"><button class="btn" type="submit">Update password</button><span class="note" id="pMsg" role="status"></span></div>
          </form>`}
        </div>`;
    }

    async function saveSettings(patch, msgEl) {
      try {
        const c = await api('settings', { method: 'POST', body: JSON.stringify({ clientId: st.data.client.id, ...patch }) });
        st.data.client = c; if (msgEl) msgEl.textContent = 'Saved.'; return true;
      } catch (e) { if (msgEl) msgEl.textContent = e.message; return false; }
    }

    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b || !root.contains(b)) return;
      if (b.dataset.tab) { st.tab = b.dataset.tab; try { localStorage.setItem('rd-dtab', st.tab); } catch (err) {} render(); return; }
      if (b.dataset.cat) { st.cat = b.dataset.cat; st.star = 'all'; renderPane(); return; }
      if (b.dataset.star) { st.star = b.dataset.star; renderPane(); return; }
      if (b.dataset.copy) { const r = st.data.reviews.find((x) => x.id === b.dataset.copy); if (r) copy(r.body, b); return; }
      const act = b.dataset.act;
      if (act === 'retry') load();
      if (act === 'back' && onBack) onBack();
      if (act === 'print') window.print();
      if (act === 'copylink') copy(reviewLink(st.data.client), b);
      if (act === 'qr') { st.qr = !st.qr; renderPane(); }
    });
    root.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.dataset.rid) {
        const r = st.data.reviews.find((x) => x.id === t.dataset.rid); if (!r) return;
        try { await api('reviews', { method: 'PATCH', body: JSON.stringify({ clientId: st.data.client.id, id: r.id, status: t.value }) }); r.status = t.value; renderPane(); }
        catch (err) { t.value = r.status; }
        return;
      }
      if (t.dataset.filter === 'status') { st.status = t.value; renderPane(); }
      if (t.dataset.filter === 'sort') { st.sort = t.value; renderPane(); }
      if (t.dataset.filter === 'week') { st.week = +t.value; renderPane(); }
    });
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (e.target.id === 'settingsForm') {
        await saveSettings({ google: $('#sGoogle', root).value, contact: $('#sContact', root).value, color: $('#sColor', root).value }, $('#sMsg', root));
      }
      if (e.target.id === 'pwForm') {
        const msg = $('#pMsg', root);
        try {
          const d = await api('me/password', { method: 'POST', body: JSON.stringify({ current: $('#pCur', root).value, password: $('#pNew', root).value }) });
          if (onToken) onToken(d.token);
          e.target.reset(); msg.textContent = 'Password updated.';
        } catch (err) { msg.textContent = err.message; }
      }
    });

    attachTips(root);
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && st.data && st.tab === 'reviews') refresh(); }, 60000);
    return { destroy() { clearInterval(timer); } };
  }

  window.RD = Object.assign(RD, { $, esc, api, starsHtml, fmt, deltaHtml, copy, googleUrl, reviewLink, qrSvg, Dashboard });
})();
