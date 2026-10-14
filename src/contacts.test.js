// Tests for text/call attribution (src/contacts.js).
// Run with: npm test
//
// D1 is replaced by a stub that records every statement and bound value, so no
// database, Wrangler or network is needed. Every click id below is made up.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  REF_ALPHABET,
  REF_LENGTH,
  refFor,
  parseContactTap,
  handleContactTap,
  listContactTaps,
  setContactLead,
  contactLeadsForFeed,
  resetContactsTableFlag,
  ContactTapError,
} from "./contacts.js";

const GCLID = "Cj0KCQjwTESTgclid_contacts-123";
const WBRAID = "wbraid:Cj8TESTwbraidcontacts456";

let errors;
beforeEach(() => {
  resetContactsTableFlag();
  errors = mock.method(console, "error", () => {});
});
afterEach(() => mock.restoreAll());

// recent: what the dedupe SELECT returns (null = no recent tap).
function stubDB({ recent = null, rows = [], throwOn = null } = {}) {
  const log = [];
  const DB = {
    prepare(sql) {
      const entry = { sql, bound: [] };
      log.push(entry);
      const stmt = {
        bind(...args) {
          entry.bound = args;
          return stmt;
        },
        run: async () => ({ success: true }),
        first: async () => recent,
        all: async () => {
          if (throwOn && throwOn.test(sql)) throw new Error("D1_ERROR: no such table: ad_contacts");
          return { results: rows };
        },
      };
      return stmt;
    },
  };
  return { DB, log };
}

function tapRequest(body, ip = "203.0.113.7") {
  return new Request("https://handymancleanersaz.com/api/contact-tap", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", "CF-Connecting-IP": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function validTap(channel = "text", click = GCLID) {
  return { channel, click, ref: await refFor(click) };
}

// ---------- refFor ----------

test("refFor: 5 symbols from the unambiguous alphabet", async () => {
  const ref = await refFor(GCLID);
  assert.equal(ref.length, REF_LENGTH);
  for (const ch of ref) assert.ok(REF_ALPHABET.includes(ch), `unexpected symbol ${ch}`);
  assert.doesNotMatch(REF_ALPHABET, /[0O1IL]/, "no look-alike characters");
});

test("refFor: deterministic, and different click ids give different refs", async () => {
  assert.equal(await refFor(GCLID), await refFor(GCLID));
  assert.notEqual(await refFor(GCLID), await refFor(GCLID + "x"));
});

// Pinned so a change to the algorithm is caught: site.js computes the same ref
// in the browser, and the two must never drift apart.
test("refFor: pinned vector shared with site.js", async () => {
  assert.equal(await refFor("TEST-PIN-CLICK-ID-0001"), "7KKTG");
});

// ---------- parseContactTap ----------

test("parse: a valid text tap and a valid call tap are accepted", async () => {
  assert.deepEqual(await parseContactTap(JSON.stringify(await validTap("text"))), await validTap("text"));
  assert.deepEqual(await parseContactTap(JSON.stringify(await validTap("call", WBRAID))), await validTap("call", WBRAID));
});

test("parse: a ref that does not belong to the click id is rejected", async () => {
  const tap = await validTap();
  tap.ref = tap.ref === "AAAAA" ? "BBBBB" : "AAAAA";
  await assert.rejects(parseContactTap(JSON.stringify(tap)), ContactTapError);
});

test("parse: unknown channel, malformed click id, bad JSON and oversized bodies are rejected", async () => {
  const bad = [
    JSON.stringify({ ...(await validTap()), channel: "email" }),
    JSON.stringify({ channel: "text", click: "short", ref: await refFor("short") }),
    JSON.stringify({ channel: "text", click: "has spaces in it ok", ref: await refFor("has spaces in it ok") }),
    "{not json",
    "x".repeat(1001),
  ];
  for (const body of bad) await assert.rejects(parseContactTap(body), ContactTapError, body.slice(0, 40));
});

// ---------- handleContactTap ----------

test("tap: stored once, returns 204, never echoes anything", async () => {
  const { DB, log } = stubDB();
  const res = await handleContactTap(tapRequest(await validTap()), { DB });
  assert.equal(res.status, 204);
  const insert = log.find((e) => /INSERT INTO ad_contacts/.test(e.sql));
  assert.ok(insert, "a row is inserted");
  assert.deepEqual(insert.bound, [await refFor(GCLID), "text", GCLID]);
  assert.ok(log.some((e) => /CREATE TABLE IF NOT EXISTS ad_contacts/.test(e.sql)), "table is created on first use");
});

test("tap: a repeat within the dedupe window is not stored again", async () => {
  const { DB, log } = stubDB({ recent: { id: 7 } });
  const res = await handleContactTap(tapRequest(await validTap()), { DB });
  assert.equal(res.status, 204);
  assert.ok(!log.some((e) => /INSERT INTO ad_contacts/.test(e.sql)));
  const dedupe = log.find((e) => /SELECT id FROM ad_contacts/.test(e.sql));
  assert.equal(dedupe.bound[2], "-10 minutes");
});

test("tap: invalid body -> ContactTapError (400), nothing written", async () => {
  const { DB, log } = stubDB();
  await assert.rejects(handleContactTap(tapRequest("{nope"), { DB }), (err) => err instanceof ContactTapError && err.status === 400);
  assert.ok(!log.some((e) => /INSERT/.test(e.sql)));
});

test("tap: rate limited -> 429, nothing written", async () => {
  const { DB, log } = stubDB();
  const REQUEST_LIMITER = { limit: async () => ({ success: false }) };
  const res = await handleContactTap(tapRequest(await validTap()), { DB, REQUEST_LIMITER });
  assert.equal(res.status, 429);
  assert.equal(log.length, 0);
});

test("tap: limiter errors fail open, the tap is still stored", async () => {
  const { DB, log } = stubDB();
  const REQUEST_LIMITER = { limit: async () => { throw new Error("limiter down"); } };
  const res = await handleContactTap(tapRequest(await validTap()), { DB, REQUEST_LIMITER });
  assert.equal(res.status, 204);
  assert.ok(log.some((e) => /INSERT INTO ad_contacts/.test(e.sql)));
  assert.equal(errors.mock.callCount(), 1);
});

// ---------- admin + feed queries ----------

test("admin list never selects the raw click id", async () => {
  const { DB, log } = stubDB({ rows: [{ id: 1, ref: "ABCDE", channel: "text", tapped_at: "2026-10-12 16:20:00", lead_at: null }] });
  const rows = await listContactTaps({ DB });
  assert.equal(rows.length, 1);
  const select = log.find((e) => /SELECT .* FROM ad_contacts/s.test(e.sql));
  assert.doesNotMatch(select.sql, /click_id/);
});

test("marking and unmarking a lead binds 1 / 0", async () => {
  const { DB, log } = stubDB();
  await setContactLead({ DB }, 5, true);
  await setContactLead({ DB }, 5, false);
  const updates = log.filter((e) => /UPDATE ad_contacts/.test(e.sql));
  assert.deepEqual(updates.map((u) => u.bound), [[5, 1], [5, 0]]);
});

test("feed rows: missing table -> empty list, other errors propagate", async () => {
  const missing = stubDB({ throwOn: /ad_contacts/ });
  assert.deepEqual(await contactLeadsForFeed({ DB: missing.DB }, 90, 5000), []);
  const broken = { prepare: () => ({ bind() { return this; }, all: async () => { throw new Error("D1 is down"); } }) };
  await assert.rejects(contactLeadsForFeed({ DB: broken }, 90, 5000), /D1 is down/);
});
