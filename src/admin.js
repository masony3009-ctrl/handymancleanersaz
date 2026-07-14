// Private /admin dashboard: request queue + client list.
// Auth: password (ADMIN_PASSWORD secret) -> HMAC-signed session cookie
// (ADMIN_SESSION_KEY secret). No third-party services.

const COOKIE = "hc_admin";
const SESSION_HOURS = 24 * 7; // 7 days
const STATUSES = ["new", "contacted", "confirmed", "done", "declined"];

export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const headers = { "X-Robots-Tag": "noindex, nofollow" };

  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_KEY) {
    return html("<h1>Admin not configured</h1><p>Set the ADMIN_PASSWORD and ADMIN_SESSION_KEY secrets.</p>", 503, headers);
  }

  if (path === "/admin/login" && request.method === "POST") {
    return login(request, env, headers);
  }
  if (path === "/admin/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { ...headers, Location: "/admin", "Set-Cookie": `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict` },
    });
  }

  const authed = await hasValidSession(request, env);

  if (path === "/admin" || path === "/admin/") {
    return authed ? html(dashboardPage(), 200, headers) : html(loginPage(false), 200, headers);
  }
  if (!authed) {
    return json({ ok: false, error: "Not signed in" }, 401, headers);
  }
  if (path === "/admin/api/data" && request.method === "GET") {
    return dataEndpoint(env, headers);
  }
  if (path === "/admin/api/status" && request.method === "POST") {
    return statusEndpoint(request, env, headers);
  }
  if (path === "/admin/api/client-note" && request.method === "POST") {
    return noteEndpoint(request, env, headers);
  }
  return json({ ok: false, error: "Not found" }, 404, headers);
}

// ---------- auth ----------

async function login(request, env, headers) {
  const form = await request.formData().catch(() => null);
  const given = form ? String(form.get("password") || "") : "";
  const ok = await constantTimeEqual(given, env.ADMIN_PASSWORD);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 400)); // slow brute force
    return html(loginPage(true), 401, headers);
  }
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const sig = await sign(String(exp), env.ADMIN_SESSION_KEY);
  return new Response(null, {
    status: 303,
    headers: {
      ...headers,
      Location: "/admin",
      "Set-Cookie": `${COOKIE}=${exp}.${sig}; Path=/admin; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}

async function hasValidSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`${COOKIE}=([0-9]+)\\.([A-Za-z0-9_-]+)`));
  if (!m) return false;
  const [, exp, sig] = m;
  if (Number(exp) < Date.now()) return false;
  const expected = await sign(exp, env.ADMIN_SESSION_KEY);
  return constantTimeEqual(sig, expected);
}

async function sign(msg, key) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function constantTimeEqual(a, b) {
  const da = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(a))));
  const db = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(b))));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

// ---------- data endpoints ----------

async function dataEndpoint(env, headers) {
  const requests = await env.DB.prepare(
    `SELECT r.id, r.service_type, r.address, r.requested_date, r.details, r.status, r.created_at,
            c.id AS client_id, c.name, c.phone, c.email
     FROM requests r JOIN clients c ON c.id = r.client_id
     ORDER BY r.created_at DESC LIMIT 300`
  ).all();
  const clients = await env.DB.prepare(
    `SELECT c.id, c.name, c.phone, c.email, c.first_seen, c.notes,
            COUNT(r.id) AS request_count
     FROM clients c LEFT JOIN requests r ON r.client_id = c.id
     GROUP BY c.id ORDER BY c.first_seen DESC LIMIT 300`
  ).all();
  return json({ ok: true, requests: requests.results, clients: clients.results }, 200, headers);
}

async function statusEndpoint(request, env, headers) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const status = String(body.status || "");
  if (!Number.isInteger(id) || !STATUSES.includes(status)) {
    return json({ ok: false, error: "Bad id or status" }, 400, headers);
  }
  await env.DB.prepare(`UPDATE requests SET status = ?1 WHERE id = ?2`).bind(status, id).run();
  return json({ ok: true }, 200, headers);
}

async function noteEndpoint(request, env, headers) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const notes = String(body.notes || "").slice(0, 2000);
  if (!Number.isInteger(id)) return json({ ok: false, error: "Bad id" }, 400, headers);
  await env.DB.prepare(`UPDATE clients SET notes = ?1 WHERE id = ?2`).bind(notes, id).run();
  return json({ ok: true }, 200, headers);
}

// ---------- helpers ----------

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });
}

function html(body, status, extra) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...extra } });
}

// ---------- pages ----------

function loginPage(failed) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Admin | HandymanCleaners</title><style>
  body{margin:0;font-family:Inter,Arial,sans-serif;background:#f3f7f7;display:grid;place-items:center;min-height:100vh;color:#233038}
  form{background:#fff;border:1px solid #e3e9ec;border-radius:6px;padding:32px;box-shadow:0 16px 38px rgba(30,42,50,.10);display:grid;gap:14px;width:min(340px,90vw)}
  h1{margin:0;font-size:22px}
  input{padding:12px;border:1px solid #e3e9ec;border-radius:4px;font:inherit;background:#f3f7f7}
  button{padding:12px;border:0;border-radius:4px;background:#0aa5a0;color:#fff;font-weight:800;font-size:14px;letter-spacing:1px;text-transform:uppercase;cursor:pointer}
  button:hover{background:#087f7b}
  .err{margin:0;color:#a03232;font-size:13.5px;font-weight:600}
  </style></head><body>
  <form method="post" action="/admin/login">
    <h1>HandymanCleaners Admin</h1>
    ${failed ? '<p class="err">Wrong password - try again.</p>' : ""}
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
    <button type="submit">Sign In</button>
  </form></body></html>`;
}

function dashboardPage() {
  // Data renders client-side with textContent only (no innerHTML of stored values)
  // so customer-submitted text can never inject markup into the admin page.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Admin | HandymanCleaners</title><style>
  :root{--teal:#0aa5a0;--teal-dark:#087f7b;--ink:#233038;--muted:#5c6b76;--light:#f3f7f7;--line:#e3e9ec}
  body{margin:0;font-family:Inter,Arial,sans-serif;background:var(--light);color:var(--ink)}
  header{display:flex;justify-content:space-between;align-items:center;background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;position:sticky;top:0}
  header h1{margin:0;font-size:18px}
  header form{margin:0}
  .lo{background:none;border:1px solid var(--line);border-radius:4px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer}
  main{max-width:1100px;margin:0 auto;padding:20px}
  h2{font-size:16px;text-transform:uppercase;letter-spacing:1px;margin:26px 0 10px}
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
  .chip{border:1px solid var(--line);background:#fff;border-radius:20px;padding:6px 14px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}
  .chip.on{background:var(--teal);border-color:var(--teal);color:#fff}
  .card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin-bottom:10px;display:grid;gap:8px}
  .row1{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}
  .who{font-weight:800}
  .who a{color:var(--teal-dark);text-decoration:none}
  .meta{color:var(--muted);font-size:13px}
  .svc{font-size:14px;font-weight:600}
  select{padding:8px;border:1px solid var(--line);border-radius:4px;font:inherit;font-size:13px;background:var(--light)}
  select.s-new{border-color:#e0a53c;background:#fdf4e3}
  select.s-confirmed{border-color:var(--teal);background:#e3f4f3}
  select.s-done{border-color:#9bb89b;background:#eef4ee}
  details{font-size:13px;color:var(--muted)}
  details pre{white-space:pre-wrap;background:var(--light);border-radius:4px;padding:10px;margin:6px 0 0}
  .empty{color:var(--muted);padding:30px;text-align:center;background:#fff;border:1px dashed var(--line);border-radius:6px}
  textarea{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:4px;padding:8px;font:inherit;font-size:13px;background:var(--light);resize:vertical}
  .saved{color:var(--teal-dark);font-size:12px;font-weight:700;visibility:hidden}
  .saved.show{visibility:visible}
  </style></head><body>
  <header>
    <h1>HandymanCleaners Admin</h1>
    <form method="post" action="/admin/logout"><button class="lo" type="submit">Log out</button></form>
  </header>
  <main>
    <h2>Requests</h2>
    <div class="chips" id="chips"></div>
    <div id="requests"></div>
    <h2>Clients</h2>
    <div id="clients"></div>
  </main>
  <script>
  var STATUSES = ${JSON.stringify(STATUSES)};
  var state = { filter: "all", data: null };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtDate(s) { return s ? s.replace(":00", "").replace("T", " ") : ""; }

  function renderChips() {
    var counts = { all: state.data.requests.length };
    STATUSES.forEach(function (s) { counts[s] = state.data.requests.filter(function (r) { return r.status === s; }).length; });
    var box = document.getElementById("chips");
    box.replaceChildren();
    ["all"].concat(STATUSES).forEach(function (f) {
      var b = el("button", "chip" + (state.filter === f ? " on" : ""), f + " (" + (counts[f] || 0) + ")");
      b.onclick = function () { state.filter = f; render(); };
      box.appendChild(b);
    });
  }

  function renderRequests() {
    var box = document.getElementById("requests");
    box.replaceChildren();
    var rows = state.data.requests.filter(function (r) { return state.filter === "all" || r.status === state.filter; });
    if (!rows.length) { box.appendChild(el("div", "empty", "No requests here yet.")); return; }
    rows.forEach(function (r) {
      var card = el("div", "card");
      var row1 = el("div", "row1");
      var who = el("div", "who");
      who.appendChild(el("span", null, r.name + " "));
      var tel = el("a", null, r.phone);
      tel.href = "tel:" + r.phone;
      who.appendChild(tel);
      if (r.email) {
        who.appendChild(el("span", null, " "));
        var em = el("a", null, r.email);
        em.href = "mailto:" + r.email;
        who.appendChild(em);
      }
      row1.appendChild(who);
      var sel = el("select", "s-" + r.status);
      STATUSES.forEach(function (s) {
        var o = el("option", null, s);
        o.value = s;
        if (s === r.status) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () {
        fetch("/admin/api/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id, status: sel.value }) })
          .then(function (res) { if (!res.ok) throw 0; r.status = sel.value; sel.className = "s-" + sel.value; renderChips(); })
          .catch(function () { alert("Save failed - try again"); sel.value = r.status; });
      };
      row1.appendChild(sel);
      card.appendChild(row1);
      card.appendChild(el("div", "svc", r.service_type + (r.requested_date ? " - " + r.requested_date : "")));
      if (r.address) card.appendChild(el("div", "meta", r.address));
      card.appendChild(el("div", "meta", "Received " + fmtDate(r.created_at)));
      var det = el("details");
      det.appendChild(el("summary", null, "All submitted fields"));
      var pre = el("pre");
      try {
        var d = JSON.parse(r.details);
        pre.textContent = Object.keys(d).map(function (k) { return k + ": " + d[k]; }).join("\\n");
      } catch (e) { pre.textContent = r.details; }
      det.appendChild(pre);
      card.appendChild(det);
      box.appendChild(card);
    });
  }

  function renderClients() {
    var box = document.getElementById("clients");
    box.replaceChildren();
    if (!state.data.clients.length) { box.appendChild(el("div", "empty", "No clients yet - they appear when requests come in.")); return; }
    state.data.clients.forEach(function (c) {
      var card = el("div", "card");
      var row1 = el("div", "row1");
      var who = el("div", "who");
      who.appendChild(el("span", null, c.name + " "));
      var tel = el("a", null, c.phone);
      tel.href = "tel:" + c.phone;
      who.appendChild(tel);
      row1.appendChild(who);
      row1.appendChild(el("div", "meta", c.request_count + " request" + (c.request_count === 1 ? "" : "s") + " - since " + fmtDate(c.first_seen)));
      card.appendChild(row1);
      if (c.email) card.appendChild(el("div", "meta", c.email));
      var ta = el("textarea");
      ta.rows = 2;
      ta.placeholder = "Notes (gate codes, preferences, linen counts...)";
      ta.value = c.notes || "";
      var saved = el("span", "saved", "Saved");
      var t;
      ta.oninput = function () {
        clearTimeout(t);
        t = setTimeout(function () {
          fetch("/admin/api/client-note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id, notes: ta.value }) })
            .then(function (res) { if (res.ok) { saved.classList.add("show"); setTimeout(function () { saved.classList.remove("show"); }, 1200); } });
        }, 600);
      };
      card.appendChild(ta);
      card.appendChild(saved);
      box.appendChild(card);
    });
  }

  function render() { renderChips(); renderRequests(); renderClients(); }

  fetch("/admin/api/data").then(function (r) { return r.json(); }).then(function (d) {
    if (!d.ok) { location.href = "/admin"; return; }
    state.data = d;
    render();
  });
  </script></body></html>`;
}
