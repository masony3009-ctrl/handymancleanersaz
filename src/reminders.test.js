// Tests for the crew app's morning reminders (src/reminders.js).
// Run with: npm test
//
// Firestore and Expo are replaced by a stub fetch, so no network is needed.
// Every address, name and token below is made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMainRun,
  phoenixDateKey,
  reminderAt,
  reminderMessage,
  remindersDue,
  reminderWindow,
  runCrewReminders,
  sendCrewReminders,
} from "./reminders.js";

// Phoenix wall-clock time -> the instant (Arizona is UTC-7 all year).
const az = (day, hh, mm = 0) => Date.parse(`${day}T00:00:00Z`) + (hh + 7) * 3600000 + mm * 60000;

const owner = { id: "o1", role: "owner", pushToken: "ExponentPushToken[owner]", serverReminders: true };
const sam = { id: "c1", role: "cleaner", employeeId: "e1", pushToken: "ExponentPushToken[sam]", serverReminders: true };
const employees = [{ id: "e1", name: "Sam Rivera", active: true }];
const job = (extra = {}) => ({
  id: "j1", dateKey: "2026-10-29", address: "9 Bean Way", type: "Standard Cleaning",
  assignedTo: "e1", assignedToName: "Sam Rivera", done: false, cancelled: false, pending: false, ...extra,
});

test("phoenixDateKey rolls over at Phoenix midnight, not UTC's", () => {
  assert.equal(phoenixDateKey(az("2026-10-29", 23, 30)), "2026-10-29");
  assert.equal(phoenixDateKey(az("2026-10-29", 0, 5)), "2026-10-29");
  assert.equal(phoenixDateKey(az("2026-10-29", 0) - 1), "2026-10-28");
});

test("reminderAt is 8:00, or an hour before an earlier start", () => {
  assert.equal(reminderAt("2026-10-29", null), az("2026-10-29", 8));
  assert.equal(reminderAt("2026-10-29", "14:00"), az("2026-10-29", 8));
  assert.equal(reminderAt("2026-10-29", "08:30"), az("2026-10-29", 7, 30));
  assert.equal(reminderAt("2026-10-29", "00:30"), az("2026-10-29", 0));
  assert.equal(reminderAt("2026-10-29", "9am"), az("2026-10-29", 8));
});

test("each run owns the 15 minutes before it; the first also takes the night", () => {
  const w = reminderWindow(az("2026-10-29", 8));
  assert.deepEqual(w, { day: "2026-10-29", from: az("2026-10-29", 7, 45), to: az("2026-10-29", 8) });
  assert.equal(isMainRun(w), true);
  assert.equal(isMainRun(reminderWindow(az("2026-10-29", 8, 15))), false);
  const first = reminderWindow(az("2026-10-29", 4));
  assert.equal(first.from, az("2026-10-29", 0) - 1);
  // Back-to-back runs tile the morning with no gap and no overlap.
  assert.equal(reminderWindow(az("2026-10-29", 4, 15)).from, first.to);
});

test("reminderMessage reads the same as the app's old local reminder", () => {
  assert.deepEqual(reminderMessage(job()), {
    title: "Cleaning today!",
    body: "9 Bean Way — Standard Cleaning (Sam Rivera)",
    data: { jobId: "j1" },
  });
  const sameDay = reminderMessage(job({ sameDayTurnover: true, assignedToName: null }));
  assert.equal(sameDay.title, "Same-day turnover today!");
  assert.equal(sameDay.body, "9 Bean Way — same-day checkout and check-in (unassigned)");
});

test("remindersDue: owner hears every cleaning, a cleaner only theirs", () => {
  const w = reminderWindow(az("2026-10-29", 8));
  const other = job({ id: "j2", address: "4 Oak Rd", assignedTo: null, assignedToName: null });
  const out = remindersDue([job(), other], [owner, sam], employees, w);
  assert.deepEqual(out.map((m) => [m.to, m.data.jobId]), [
    ["ExponentPushToken[owner]", "j1"],
    ["ExponentPushToken[sam]", "j1"],
    ["ExponentPushToken[owner]", "j2"],
  ]);
});

test("remindersDue: a cleaning moved off today says nothing today", () => {
  const w = reminderWindow(az("2026-10-29", 8));
  // Airbnb moved it from the 29th to Nov 1 overnight: the live record is what counts.
  assert.deepEqual(remindersDue([job({ dateKey: "2026-11-01" })], [owner, sam], employees, w), []);
});

test("remindersDue skips what shouldn't remind anyone", () => {
  const w = reminderWindow(az("2026-10-29", 8));
  const quiet = [job({ cancelled: true }), job({ done: true }), job({ pending: true })];
  assert.deepEqual(remindersDue(quiet, [owner, sam], employees, w), []);
  // Not this run's slot: a 7:30 reminder belongs to the 7:30 run.
  assert.deepEqual(remindersDue([job({ time: "08:30" })], [owner], employees, w), []);
  // Phones still scheduling their own, without a token, or a deactivated cleaner.
  const phones = [
    { ...owner, serverReminders: false },
    { ...sam, pushToken: null },
    { ...sam, id: "c2", employeeId: "e2", pushToken: "ExponentPushToken[gone]" },
  ];
  assert.deepEqual(remindersDue([job()], phones, [...employees, { id: "e2", active: false }], w), []);
  // Two device records with the same token get one reminder.
  assert.equal(remindersDue([job()], [owner, { ...owner, id: "o2" }], employees, w).length, 1);
});

// A fetch stub that answers like Firestore and Expo and records what was sent.
function stubFetch({ jobs = [], devices = [], employees: emps = [], tickets } = {}) {
  const calls = [];
  const doc = (collection, d) => ({
    name: `projects/p/databases/(default)/documents/${collection}/${d.id}`,
    fields: Object.fromEntries(Object.entries(d).filter(([k]) => k !== "id").map(([k, v]) => [k,
      v === null ? { nullValue: null } : typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v) }])),
  });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
    if (url.endsWith(":runQuery")) return ok(jobs.map((j) => ({ document: doc("jobs", j) })));
    if (url.includes("/devices?")) return ok({ documents: devices.map((d) => doc("devices", d)) });
    if (url.includes("/employees?")) return ok({ documents: emps.map((e) => doc("employees", e)) });
    if (url.startsWith("https://exp.host/")) {
      const sent = JSON.parse(init.body);
      return ok({ data: tickets || sent.map(() => ({ status: "ok" })) });
    }
    throw new Error("unexpected fetch " + url);
  };
  return { fetchImpl, calls };
}

const env = { TURNTRACK_JOBS_URL: "https://firestore.example/v1/projects/p/databases/(default)/documents/jobs" };

test("sendCrewReminders reads today's jobs and pushes the due ones", async () => {
  const { fetchImpl, calls } = stubFetch({ jobs: [job()], devices: [owner], employees });
  const alerts = [];
  const r = await sendCrewReminders(env, az("2026-10-29", 8), {
    fetch: fetchImpl,
    idToken: async () => "tok",
    alert: async (...a) => alerts.push(a),
  });
  assert.equal(r.sent, 1);
  assert.deepEqual(alerts, []);
  const query = calls.find((c) => c.url.endsWith(":runQuery"));
  assert.equal(query.body.structuredQuery.where.fieldFilter.value.stringValue, "2026-10-29");
  const push = calls.find((c) => c.url.startsWith("https://exp.host/")).body;
  assert.equal(push[0].to, "ExponentPushToken[owner]");
  assert.equal(push[0].title, "Cleaning today!");
  assert.equal(push[0].priority, "high");
});

test("sendCrewReminders tells the owner when Expo turns a reminder away", async () => {
  const tickets = [{ status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }];
  const { fetchImpl } = stubFetch({ jobs: [job()], devices: [owner], employees, tickets });
  const alerts = [];
  const r = await sendCrewReminders(env, az("2026-10-29", 8), { fetch: fetchImpl, idToken: async () => "tok", alert: async (...a) => alerts.push(a) });
  assert.equal(r.sent, 0);
  assert.deepEqual(r.failures, ["DeviceNotRegistered"]);
  assert.match(alerts[0][1], /1 of 1 morning reminders/);
});

test("sendCrewReminders sends nothing when nothing is due", async () => {
  const { fetchImpl, calls } = stubFetch({ jobs: [job()], devices: [owner], employees });
  const r = await sendCrewReminders(env, az("2026-10-29", 9), { fetch: fetchImpl, idToken: async () => "tok", alert: async () => {} });
  assert.equal(r.sent, 0);
  assert.equal(calls.some((c) => c.url.startsWith("https://exp.host/")), false);
});

test("runCrewReminders alerts on a failure only on the 8:00 run", async () => {
  const alerts = [];
  const deps = { idToken: async () => { throw new Error("sign-in down"); }, alert: async (...a) => alerts.push(a) };
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await runCrewReminders(env, az("2026-10-29", 8, 15), deps);
    assert.equal(alerts.length, 0);
    await runCrewReminders(env, az("2026-10-29", 8), deps);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0][1], /sign-in down/);
    assert.equal(errors.length, 2);
    // A missing jobs URL is a failure too, not a quiet no-op.
    await runCrewReminders({}, az("2026-10-29", 8), { ...deps, idToken: async () => "tok" });
    assert.match(alerts[1][1], /TURNTRACK_JOBS_URL/);
  } finally {
    console.error = original;
  }
});
