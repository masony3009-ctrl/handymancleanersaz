// Tests for the Microsoft Ads conversion feed (src/msconversions.js).
// Run with: npm test
//
// Same stub approach as conversions.test.js. Every value below is made up;
// nothing here is a real click id or a real customer.

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { handleMicrosoftConversionsFeed, microsoftTime } from "./msconversions.js";
import { handleConversionsFeed } from "./conversions.js";

const KEY = "test-feed-key";
const URL_BASE = "https://handymancleanersaz.com/api/microsoft-conversions.csv";
const PARAMETERS = "Parameters:TimeZone=+0000";
const HEADER = "Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Microsoft Click ID";

const CUSTOMER = { Name: "Pat Testcustomer", Phone: "5550000001", Email: "pat.testcustomer@mail.invalid" };

const ROWS = [
  { created_at: "2026-11-05 18:04:11", details: JSON.stringify({ ...CUSTOMER, "Google click ID": "msclkid:0a1b2c3dTESTmsclkid4e5f6a7b8c9d" }) },
  { created_at: "2026-11-05 00:30:00", details: JSON.stringify({ ...CUSTOMER, "Google click ID": "Cj0KCQjwTESTgclid123_abc-XYZ" }) },
  { created_at: "2026-11-05 12:00:00", details: JSON.stringify({ ...CUSTOMER, "Google click ID": "wbraid:Cj8TESTwbraid456" }) },
  { created_at: "2026-11-05 12:05:00", details: JSON.stringify({ ...CUSTOMER, "Google click ID": "" }) },
  { created_at: "yesterday", details: JSON.stringify({ "Google click ID": "msclkid:BADTIMESTAMPSHOULDNOTAPPEAR" }) },
];

beforeEach(() => {
  mock.method(console, "error", () => {});
});
afterEach(() => mock.restoreAll());

function stubEnv(rows, contactRows = [], overrides = {}) {
  return {
    CONVERSIONS_FEED_KEY: KEY,
    DB: {
      prepare(sql) {
        const contacts = /ad_contacts/.test(sql);
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: contacts ? contactRows : rows };
          },
        };
      },
    },
    ...overrides,
  };
}

function get(env, query = `?key=${KEY}`) {
  return handleMicrosoftConversionsFeed(new Request(URL_BASE + query), env);
}

test("missing key -> 503 naming this feed", async () => {
  const res = await get(stubEnv(ROWS, [], { CONVERSIONS_FEED_KEY: "" }));
  assert.equal(res.status, 503);
  assert.match(console.error.mock.calls[0].arguments[0], /microsoft-conversions\.csv/);
});

test("wrong key -> 401", async () => {
  const res = await get(stubEnv(ROWS), "?key=nope");
  assert.equal(res.status, 401);
});

test("only Microsoft click ids are listed, in Microsoft's template shape", async () => {
  const res = await get(stubEnv(ROWS));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("Cache-Control"), "no-store, max-age=0");
  const lines = (await res.text()).split("\r\n");
  assert.deepEqual(lines, [
    PARAMETERS,
    HEADER,
    "Request Form Submitted,11/5/2026 6:04:11 PM,,,0a1b2c3dTESTmsclkid4e5f6a7b8c9d",
    "",
  ]);
});

test("no customer data ever reaches the feed", async () => {
  const body = await (await get(stubEnv(ROWS))).text();
  for (const value of Object.values(CUSTOMER)) assert.ok(!body.includes(value));
});

test("confirmed text/call leads with a Microsoft click are listed at the tap time", async () => {
  const contacts = [
    { click_id: "msclkid:ffffTESTcontactmsclkid0000", tapped_at: "2026-11-06 07:15:09" },
    { click_id: "Cj0KCQjwTESTgclidcontact", tapped_at: "2026-11-06 08:00:00" },
  ];
  const lines = (await (await get(stubEnv([], contacts))).text()).split("\r\n");
  assert.deepEqual(lines.slice(2, -1), ["Request Form Submitted,11/6/2026 7:15:09 AM,,,ffffTESTcontactmsclkid0000"]);
});

test("no Microsoft leads -> just the parameters and header lines", async () => {
  const body = await (await get(stubEnv(ROWS.slice(1)))).text();
  assert.equal(body, `${PARAMETERS}\r\n${HEADER}\r\n`);
});

test("the Google feed never lists a Microsoft click id", async () => {
  const res = await handleConversionsFeed(
    new Request(`https://handymancleanersaz.com/api/conversions.csv?key=${KEY}`),
    stubEnv(ROWS)
  );
  const body = await res.text();
  assert.ok(!body.includes("msclkid"));
  assert.ok(!body.includes("0a1b2c3dTESTmsclkid4e5f6a7b8c9d"));
  assert.ok(body.includes("Cj0KCQjwTESTgclid123_abc-XYZ"));
});

test("microsoftTime: midnight, noon and single-digit dates", () => {
  assert.equal(microsoftTime("2026-01-02 00:00:00"), "1/2/2026 12:00:00 AM");
  assert.equal(microsoftTime("2026-12-31 12:59:59"), "12/31/2026 12:59:59 PM");
  assert.equal(microsoftTime("2026-07-04 23:05:01"), "7/4/2026 11:05:01 PM");
});
