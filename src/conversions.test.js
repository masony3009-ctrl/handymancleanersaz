// Tests for the Google Ads conversion feed (src/conversions.js).
// Run with: npm test
//
// The D1 binding is replaced by a stub that records what was bound and hands
// back canned rows, so no database, Wrangler or network is needed. Every value
// below is made up; nothing here is a real click id or a real customer.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { handleConversionsFeed } from "./conversions.js";

const KEY = "test-feed-key";
const URL_BASE = "https://handymancleanersaz.com/api/conversions.csv";
const HEADER = "Google Click ID,WBRAID,GBRAID,Conversion Name,Conversion Time";

// Customer fields are included on purpose: the feed must never echo them.
const CUSTOMER = { Name: "Pat Testcustomer", Phone: "5550000001", Email: "pat.testcustomer@mail.invalid" };

const ROWS = [
  { created_at: "2026-10-09 18:04:11", details: JSON.stringify({ ...CUSTOMER, "Google click ID": "Cj0KCQjwTESTgclid123_abc-XYZ" }) },
  { created_at: "2026-10-09 18:05:22", details: JSON.stringify({ ...CUSTOMER, "Google click ID": "wbraid:Cj8TESTwbraid456" }) },
  { created_at: "2026-10-09 18:05:40", details: JSON.stringify({ ...CUSTOMER, "Google click ID": "gbraid:Cj9TESTgbraid789" }) },
  // Organic visits: empty click id, and the key absent entirely.
  { created_at: "2026-10-09 18:06:33", details: JSON.stringify({ ...CUSTOMER, "Google click ID": "" }) },
  { created_at: "2026-10-09 18:07:00", details: JSON.stringify({ ...CUSTOMER }) },
  // Unreadable details must cost only this row, not the whole file.
  { created_at: "2026-10-09 18:08:00", details: "{not json" },
  // A timestamp we cannot read honestly is skipped, never guessed at.
  { created_at: "yesterday", details: JSON.stringify({ "Google click ID": "BADTIMESTAMPSHOULDNOTAPPEAR" }) },
  // Comma + double quote + newline must stay inside one quoted CSV field.
  { created_at: "2026-10-09 18:09:00", details: JSON.stringify({ "Google click ID": 'ev,il"id\nnext' }) },
];

// The handler logs skipped rows and a missing key on purpose; keep that out of
// the test output while still letting a test assert that it happened.
let logged;
beforeEach(() => {
  logged = mock.method(console, "error", () => {});
});
afterEach(() => mock.restoreAll());

// The feed reads two tables: form submissions (requests) and confirmed text/call
// leads (ad_contacts, see contacts.js). The stub keeps them apart so a test about
// one query can never be satisfied by the other. contactRows may be an Error,
// which the contacts query then throws.
function stubEnv(rows, overrides = {}, contactRows = []) {
  const calls = { sql: null, bound: null, contactSql: null, contactBound: null };
  const env = {
    CONVERSIONS_FEED_KEY: KEY,
    DB: {
      prepare(sql) {
        const contacts = /ad_contacts/.test(sql);
        if (contacts) calls.contactSql = sql;
        else calls.sql = sql;
        return {
          bind(...args) {
            if (contacts) calls.contactBound = args;
            else calls.bound = args;
            return this;
          },
          all: async () => {
            if (!contacts) return { results: rows };
            if (contactRows instanceof Error) throw contactRows;
            return { results: contactRows };
          },
        };
      },
    },
    ...overrides,
  };
  return { env, calls };
}

function req(query = "", headers = {}) {
  return new Request(URL_BASE + query, { headers });
}

function basic(user, password) {
  return { Authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64") };
}

// Records are CRLF-terminated; a bare \n can only appear inside a quoted field.
function records(body) {
  return body.split("\r\n").filter((line) => line !== "");
}

// ---------- auth ----------

test("no credentials -> 401 with a Basic challenge", async () => {
  const res = await handleConversionsFeed(req(), stubEnv(ROWS).env);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate"), /^Basic /);
});

test("correct ?key= -> 200", async () => {
  const res = await handleConversionsFeed(req(`?key=${KEY}`), stubEnv(ROWS).env);
  assert.equal(res.status, 200);
});

test("wrong ?key= -> 401", async () => {
  const res = await handleConversionsFeed(req("?key=nope"), stubEnv(ROWS).env);
  assert.equal(res.status, 401);
});

test("correct HTTP Basic password -> 200", async () => {
  const res = await handleConversionsFeed(req("", basic("googleads", KEY)), stubEnv(ROWS).env);
  assert.equal(res.status, 200);
});

test("wrong HTTP Basic password -> 401", async () => {
  const res = await handleConversionsFeed(req("", basic("googleads", "wrong")), stubEnv(ROWS).env);
  assert.equal(res.status, 401);
});

test("malformed Basic header -> 401, not a crash", async () => {
  const res = await handleConversionsFeed(req("", { Authorization: "Basic !!!not-base64!!!" }), stubEnv(ROWS).env);
  assert.equal(res.status, 401);
});

test("unconfigured CONVERSIONS_FEED_KEY -> 503 and the database is never touched", async () => {
  const { env, calls } = stubEnv(ROWS, { CONVERSIONS_FEED_KEY: "" });
  const res = await handleConversionsFeed(req(`?key=${KEY}`), env);
  assert.equal(res.status, 503);
  assert.equal(calls.sql, null);
  assert.equal(logged.mock.callCount(), 1);
});

// ---------- response ----------

test("headers: CSV content type, not indexable, not cacheable", async () => {
  const res = await handleConversionsFeed(req(`?key=${KEY}`), stubEnv(ROWS).env);
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(res.headers.get("Cache-Control"), /no-store/);
});

test("rows: each click id kind lands in its own column; bad rows are skipped", async () => {
  const body = await (await handleConversionsFeed(req(`?key=${KEY}`), stubEnv(ROWS).env)).text();
  assert.ok(body.endsWith("\r\n"), "file ends with CRLF");
  assert.deepEqual(records(body), [
    HEADER,
    "Cj0KCQjwTESTgclid123_abc-XYZ,,,Request Form Submitted,2026-10-09 18:04:11+00:00",
    ",Cj8TESTwbraid456,,Request Form Submitted,2026-10-09 18:05:22+00:00",
    ",,Cj9TESTgbraid789,Request Form Submitted,2026-10-09 18:05:40+00:00",
    '"ev,il""id\nnext",,,Request Form Submitted,2026-10-09 18:09:00+00:00',
  ]);
  assert.doesNotMatch(body, /BADTIMESTAMPSHOULDNOTAPPEAR/);
  assert.equal(logged.mock.callCount(), 1, "the unparseable row is logged once");
});

test("no customer data (name, phone, email) ever appears in the feed", async () => {
  const body = await (await handleConversionsFeed(req(`?key=${KEY}`), stubEnv(ROWS.slice(0, 5)).env)).text();
  for (const value of Object.values(CUSTOMER)) assert.ok(!body.includes(value), `leaked: ${value}`);
  assert.doesNotMatch(body, /Testcustomer|mail\.invalid|555000/);
});

test("query is bound to the 90-day window", async () => {
  const { env, calls } = stubEnv(ROWS.slice(0, 1));
  await handleConversionsFeed(req(`?key=${KEY}`), env);
  assert.equal(calls.bound[0], "-90 days");
  assert.match(calls.sql, /datetime\('now', \?1\)/);
});

// ---------- placeholder row ----------
// Google's connector refuses a header-only file, so an empty window must still
// emit exactly one obviously-fake row - and only while there are no real ones.

test("no real rows -> exactly one SAMPLE-SCHEMA placeholder row", async () => {
  const body = await (await handleConversionsFeed(req(`?key=${KEY}`), stubEnv([]).env)).text();
  const lines = records(body);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], HEADER);
  assert.match(
    lines[1],
    /^SAMPLE-SCHEMA-ROW-NOT-A-REAL-CLICK,,,Request Form Submitted,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+00:00$/
  );
});

test("only organic / unusable rows -> still exactly one placeholder", async () => {
  const body = await (await handleConversionsFeed(req(`?key=${KEY}`), stubEnv([ROWS[3], ROWS[4]]).env)).text();
  assert.equal(body.match(/SAMPLE-SCHEMA-ROW-NOT-A-REAL-CLICK/g)?.length, 1);
});

test("real rows present -> no placeholder", async () => {
  const body = await (await handleConversionsFeed(req(`?key=${KEY}`), stubEnv(ROWS.slice(0, 3)).env)).text();
  assert.doesNotMatch(body, /SAMPLE-SCHEMA-ROW/);
  assert.equal(records(body).length, 4);
});

// ---------- text / call leads (contacts.js) ----------
// Visitors from an ad who texted or called, and whom Mason confirmed as a lead
// in /admin. They join the feed under the same conversion name, timed at the tap.

const CONTACT_ROWS = [
  { click_id: "Cj0KCQjwTESTtextlead999", tapped_at: "2026-10-12 16:20:00" },
  { click_id: "wbraid:Cj8TESTcallwbraid1", tapped_at: "2026-10-12 17:45:30" },
  // A tap timestamp we cannot read honestly is skipped, as with form rows.
  { click_id: "Cj0KCQjwTESTbadtime", tapped_at: "soon" },
];

test("confirmed text/call leads appear, each click id kind in its own column", async () => {
  const body = await (await handleConversionsFeed(req(`?key=${KEY}`), stubEnv([], {}, CONTACT_ROWS).env)).text();
  assert.deepEqual(records(body), [
    HEADER,
    "Cj0KCQjwTESTtextlead999,,,Request Form Submitted,2026-10-12 16:20:00+00:00",
    ",Cj8TESTcallwbraid1,,Request Form Submitted,2026-10-12 17:45:30+00:00",
  ]);
});

test("form rows and text/call leads are both reported", async () => {
  const body = await (await handleConversionsFeed(req(`?key=${KEY}`), stubEnv(ROWS.slice(0, 1), {}, CONTACT_ROWS.slice(0, 1)).env)).text();
  assert.equal(records(body).length, 3);
  assert.match(body, /Cj0KCQjwTESTgclid123_abc-XYZ/);
  assert.match(body, /Cj0KCQjwTESTtextlead999/);
});

test("a confirmed text/call lead alone suppresses the placeholder row", async () => {
  const body = await (await handleConversionsFeed(req(`?key=${KEY}`), stubEnv([], {}, CONTACT_ROWS.slice(0, 1)).env)).text();
  assert.doesNotMatch(body, /SAMPLE-SCHEMA-ROW/);
});

test("both queries are bound to the 90-day window, each checked on its own", async () => {
  const { env, calls } = stubEnv(ROWS.slice(0, 1), {}, []);
  await handleConversionsFeed(req(`?key=${KEY}`), env);
  assert.match(calls.sql, /FROM requests/);
  assert.equal(calls.bound[0], "-90 days");
  assert.match(calls.contactSql, /FROM ad_contacts/);
  assert.match(calls.contactSql, /lead_at IS NOT NULL/, "only taps Mason confirmed");
  assert.equal(calls.contactBound[0], "-90 days");
});

test("no ad_contacts table yet -> form conversions are still served", async () => {
  const missing = new Error("D1_ERROR: no such table: ad_contacts: SQLITE_ERROR");
  const res = await handleConversionsFeed(req(`?key=${KEY}`), stubEnv(ROWS.slice(0, 1), {}, missing).env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Cj0KCQjwTESTgclid123_abc-XYZ/);
});
