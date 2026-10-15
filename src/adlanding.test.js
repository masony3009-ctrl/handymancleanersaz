// Tests for the house cleaning ad landing redirect (src/adlanding.js).
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { landingFor, handleAdLanding, LOCATION_PAGES, FALLBACK_PAGE } from "./adlanding.js";

const BASE = "https://handymancleanersaz.com/house-cleaning/";
const at = (query) => landingFor(new URL(BASE + query));

test("each city ID lands on its own page", () => {
  assert.equal(at("?loc=1013445"), "/locations/mesa/");
  assert.equal(at("?loc=1013416"), "/locations/gilbert/house-cleaning/");
  assert.equal(at("?loc=1013469"), "/locations/queen-creek/house-cleaning/");
  assert.equal(at("?loc=9052798"), "/locations/san-tan-valley/house-cleaning/");
});

test("ZIP-level IDs land on their city's page", () => {
  assert.equal(at("?loc=9030039"), "/locations/mesa/"); // 85212
  assert.equal(at("?loc=9030098"), "/locations/gilbert/house-cleaning/"); // 85298
  assert.equal(at("?loc=9030021"), "/locations/queen-creek/house-cleaning/"); // 85142
  assert.equal(at("?loc=9053836"), "/locations/san-tan-valley/house-cleaning/"); // 85140
});

test("unknown, missing, unfilled and Chandler locations fall back to the general page", () => {
  for (const q of ["", "?loc=", "?loc=1013387", "?loc=999", "?loc={loc_physical_ms}", "?loc=%7Bloc_physical_ms%7D"]) {
    assert.equal(at(q), FALLBACK_PAGE, q);
  }
});

test("click ids and other params survive the hop; loc itself is dropped", () => {
  assert.equal(at("?loc=1013416&gclid=Cj0KTESTclick_123"), "/locations/gilbert/house-cleaning/?gclid=Cj0KTESTclick_123");
  assert.equal(at("?wbraid=TESTwbraid&loc=9052798&utm_source=google"), "/locations/san-tan-valley/house-cleaning/?wbraid=TESTwbraid&utm_source=google");
  assert.equal(at("?gbraid=TESTgbraid"), FALLBACK_PAGE + "?gbraid=TESTgbraid");
});

test("every mapped page is one of the four city pages", () => {
  const pages = new Set(LOCATION_PAGES.values());
  assert.deepEqual([...pages].sort(), [
    "/locations/gilbert/house-cleaning/",
    "/locations/mesa/",
    "/locations/queen-creek/house-cleaning/",
    "/locations/san-tan-valley/house-cleaning/",
  ]);
});

test("response: uncached, unindexed 302 to a same-site path", () => {
  const res = handleAdLanding(new Request(BASE + "?loc=1013445&gclid=TESTgclid0001"));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/locations/mesa/?gclid=TESTgclid0001");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
});

test("arriving on the general page with an unknown loc cannot loop: the hop drops loc", () => {
  const hop = at("?loc=1013387&gclid=TESTgclid0002");
  assert.equal(hop, FALLBACK_PAGE + "?gclid=TESTgclid0002");
  assert.ok(!new URL(hop, BASE).searchParams.has("loc"));
});
