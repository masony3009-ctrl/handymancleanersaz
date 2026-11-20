// Tests for the phone-or-email rule on /api/request (src/contactkey.js).
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkContact, isDialable, EMAIL_KEY_PREFIX } from "./contactkey.js";

test("a phone alone is enough, and formatting is stripped", () => {
  const r = checkContact("(480) 555-0100", "");
  assert.equal(r.ok, true);
  assert.equal(r.phone, "4805550100");
  assert.equal(r.key, "4805550100");
});

test("an email alone is enough and becomes a lower-cased email key", () => {
  const r = checkContact("", "  Owner@Example.COM ");
  assert.equal(r.ok, true);
  assert.equal(r.phone, "");
  assert.equal(r.email, "Owner@Example.COM");
  assert.equal(r.key, EMAIL_KEY_PREFIX + "owner@example.com");
});

test("with both, the phone stays the dedupe key", () => {
  const r = checkContact("480.555.0100", "owner@example.com");
  assert.equal(r.ok, true);
  assert.equal(r.key, "4805550100");
});

test("neither one is refused with a plain-language reason", () => {
  for (const [p, e] of [["", ""], [null, undefined], ["   ", "  "]]) {
    const r = checkContact(p, e);
    assert.equal(r.ok, false);
    assert.match(r.error, /phone number or an email/);
  }
});

test("a short or overlong phone is refused even when an email is present", () => {
  assert.equal(checkContact("555-0100", "owner@example.com").ok, false);
  assert.equal(checkContact("1234567890123456", "").ok, false);
  assert.match(checkContact("555-0100", "").error, /10 digits/);
});

test("a malformed email is refused even when a phone is present", () => {
  const r = checkContact("4805550100", "not-an-email");
  assert.equal(r.ok, false);
  assert.match(r.error, /valid email/);
});

test("international numbers up to 15 digits pass", () => {
  assert.equal(checkContact("+44 20 7946 0958", "").ok, true);
});

test("isDialable tells real numbers from email-only keys", () => {
  assert.equal(isDialable("4805550100"), true);
  assert.equal(isDialable(EMAIL_KEY_PREFIX + "owner@example.com"), false);
  assert.equal(isDialable(""), false);
  assert.equal(isDialable(null), false);
  assert.equal(isDialable("12345"), false);
});
