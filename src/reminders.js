// Morning "Cleaning today!" pushes for the TurnTrack crew app.
//
// WHY THIS EXISTS
// The phones used to schedule these themselves, up to a month ahead, and only
// rescheduled when someone opened the app. So a cleaning Airbnb moved at
// midnight still announced itself at 8 the next morning on its old day. Sent
// from here instead, each reminder reads the live schedule the moment it's due.
//
// HOW IT WORKS
//   1. The cron in wrangler.jsonc runs this every 15 minutes, 4:00-8:45 AM
//      Phoenix time.
//   2. Each run owns the reminders due since the run before (the day's first
//      run also takes anything since midnight), so none is sent twice and a
//      slow run can't skip one.
//   3. A phone only gets these once its device record says serverReminders:
//      the app sets that when it saves a working push token, and from then on
//      schedules none of its own (TurnTrack notifications.ts). A phone without
//      a token keeps its own reminders, so nobody goes unreminded and nobody is
//      told twice.
//
// The wording and timing match what the app used to schedule, so the crew sees
// the same notification, just never a stale one.

export const REMINDER_STEP_MS = 15 * 60 * 1000; // keep in step with the cron
const PHOENIX_OFFSET_MS = 7 * 60 * 60 * 1000; // Arizona is UTC-7 all year (no DST)
const FIRST_RUN_MINUTES = 4 * 60; // the cron's first run of the day, 4:00 AM
const MAIN_REMINDER_MINUTES = 8 * 60; // most reminders go out at 8:00
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH = 100;

// "YYYY-MM-DD" in Phoenix for an instant.
export function phoenixDateKey(ms) {
  return new Date(ms - PHOENIX_OFFSET_MS).toISOString().slice(0, 10);
}

// Minutes after midnight, Phoenix time, on that day -> the instant.
function phoenixAt(dateKey, minutes) {
  return Date.parse(dateKey + "T00:00:00Z") + PHOENIX_OFFSET_MS + minutes * 60000;
}

// The app's rule (jobTime.ts reminderAt): 8:00, or an hour before a start
// earlier than 9:00. Never before that day's midnight.
export function reminderAt(dateKey, time) {
  const eight = phoenixAt(dateKey, MAIN_REMINDER_MINUTES);
  const m = TIME.exec(time || "");
  if (!m) return eight;
  const hourBefore = phoenixAt(dateKey, Number(m[1]) * 60 + Number(m[2]) - 60);
  return Math.max(phoenixAt(dateKey, 0), Math.min(eight, hourBefore));
}

// The reminders one run owns: due after `from`, up to and including `to`.
export function reminderWindow(scheduledMs) {
  const day = phoenixDateKey(scheduledMs);
  const midnight = phoenixAt(day, 0);
  const first = scheduledMs - midnight <= FIRST_RUN_MINUTES * 60000;
  return { day, from: first ? midnight - 1 : scheduledMs - REMINDER_STEP_MS, to: scheduledMs };
}

// The run that sends the 8:00 reminders, which is the one that tells the owner
// when something is broken (once a day, not every 15 minutes).
export function isMainRun(window) {
  const eight = phoenixAt(window.day, MAIN_REMINDER_MINUTES);
  return eight > window.from && eight <= window.to;
}

export function reminderMessage(job) {
  const who = job.assignedToName ? ` (${job.assignedToName})` : " (unassigned)";
  const sameDay = job.sameDayTurnover === true;
  return {
    title: sameDay ? "Same-day turnover today!" : "Cleaning today!",
    body: sameDay
      ? `${job.address} — same-day checkout and check-in${who}`
      : `${job.address} — ${job.type || "Cleaning"}${who}`,
    data: { jobId: job.id },
  };
}

// Who hears about what: an owner's phone about every cleaning that day, a
// cleaner's phone about the ones assigned to them. Unconfirmed website
// requests, cancelled and finished cleanings never remind anyone.
export function remindersDue(jobs, devices, employees, window) {
  const active = new Set(employees.filter((e) => e.active).map((e) => e.id));
  const phones = devices.filter(
    (d) => d.serverReminders === true && typeof d.pushToken === "string" && d.pushToken.startsWith("ExponentPushToken")
  );
  const seen = new Set();
  const out = [];
  for (const job of jobs) {
    if (job.cancelled || job.done || job.pending || job.dateKey !== window.day) continue;
    const at = reminderAt(job.dateKey, job.time);
    if (at <= window.from || at > window.to) continue;
    const message = reminderMessage(job);
    for (const d of phones) {
      const mine = d.role === "owner" || (d.role === "cleaner" && active.has(d.employeeId) && job.assignedTo === d.employeeId);
      const key = d.pushToken + "|" + job.id;
      if (!mine || seen.has(key)) continue;
      seen.add(key);
      out.push({ to: d.pushToken, ...message });
    }
  }
  return out;
}

// Firestore REST values -> plain JS.
export function plain(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(plain);
  if ("mapValue" in v) return fromFields(v.mapValue.fields);
  return null;
}

function fromFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, x]) => [k, plain(x)]));
}

function fromDoc(doc) {
  return { id: doc.name.split("/").pop(), ...fromFields(doc.fields) };
}

// TURNTRACK_JOBS_URL is the jobs collection; everything else lives beside it.
function documentsBase(env) {
  const base = String(env.TURNTRACK_JOBS_URL || "").replace(/\/jobs\/?$/, "");
  if (!/\/documents$/.test(base)) throw new Error("TURNTRACK_JOBS_URL not configured");
  return base;
}

async function firestore(fetchImpl, url, auth, body) {
  const res = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + auth, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("firestore " + res.status + " " + (await res.text().catch(() => "")).slice(0, 120));
  return res.json();
}

async function listCollection(fetchImpl, base, auth, collection) {
  const out = [];
  let page = "";
  do {
    const body = await firestore(fetchImpl, `${base}/${collection}?pageSize=300${page ? "&pageToken=" + encodeURIComponent(page) : ""}`, auth);
    for (const doc of body.documents || []) out.push(fromDoc(doc));
    page = body.nextPageToken || "";
  } while (page);
  return out;
}

async function jobsOn(fetchImpl, base, auth, day) {
  const rows = await firestore(fetchImpl, base + ":runQuery", auth, {
    structuredQuery: {
      from: [{ collectionId: "jobs" }],
      where: { fieldFilter: { field: { fieldPath: "dateKey" }, op: "EQUAL", value: { stringValue: day } } },
    },
  });
  return (Array.isArray(rows) ? rows : []).filter((r) => r.document).map((r) => fromDoc(r.document));
}

// Expo answers 200 even when single messages fail, so every ticket is checked.
async function pushAll(fetchImpl, messages) {
  let sent = 0;
  const failures = [];
  for (let i = 0; i < messages.length; i += EXPO_BATCH) {
    const batch = messages.slice(i, i + EXPO_BATCH);
    const res = await fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(batch.map((m) => ({
        to: m.to,
        sound: "default",
        channelId: "default",
        // Android holds normal-priority pushes while the phone dozes.
        priority: "high",
        title: m.title,
        body: m.body,
        data: m.data,
      }))),
    });
    if (!res.ok) throw new Error("expo push " + res.status + " " + (await res.text().catch(() => "")).slice(0, 120));
    const tickets = ((await res.json().catch(() => null)) || {}).data;
    batch.forEach((m, j) => {
      const t = Array.isArray(tickets) ? tickets[j] : null;
      if (t && t.status === "ok") sent += 1;
      else failures.push((t && (t.details?.error || t.message)) || "no ticket");
    });
  }
  return { sent, failures };
}

// Sends this run's reminders. deps.idToken signs in to TurnTrack (the bridge
// in index.js); deps.alert reaches the owner. Throws only for the caller to log.
export async function sendCrewReminders(env, scheduledMs, deps) {
  const fetchImpl = deps.fetch || fetch;
  const window = reminderWindow(scheduledMs);
  const base = documentsBase(env);
  const auth = await deps.idToken(env);
  const [jobs, devices, employees] = await Promise.all([
    jobsOn(fetchImpl, base, auth, window.day),
    listCollection(fetchImpl, base, auth, "devices"),
    listCollection(fetchImpl, base, auth, "employees"),
  ]);
  const messages = remindersDue(jobs, devices, employees, window);
  if (!messages.length) return { window, sent: 0, failures: [] };
  const result = await pushAll(fetchImpl, messages);
  if (result.failures.length) {
    await deps.alert(
      "TurnTrack reminders didn't all go out",
      `${result.failures.length} of ${messages.length} morning reminders weren't accepted (${[...new Set(result.failures)].join(", ")}). ` +
        "A phone may need TurnTrack opened again to refresh its notifications."
    );
  }
  return { window, ...result };
}

// The cron entry point: logs every run that did something, and tells the owner
// once a day if reminders are failing outright.
export async function runCrewReminders(env, scheduledMs, deps) {
  try {
    const r = await sendCrewReminders(env, scheduledMs, deps);
    if (r.sent || r.failures.length) console.log("crew reminders:", JSON.stringify({ day: r.window.day, sent: r.sent, failed: r.failures.length }));
  } catch (err) {
    console.error("crew reminders failed:", err && err.message);
    if (isMainRun(reminderWindow(scheduledMs))) {
      await deps.alert("TurnTrack reminders failed", "This morning's cleaning reminders couldn't be sent: " + (err && err.message)).catch(() => {});
    }
  }
}

// One plain-text line to the owner on whichever channel is set up (the same
// ones booking alerts use). Never throws; says so in the log if nothing worked.
export async function alertOwner(env, title, body) {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: title + "\n\n" + body, disable_web_page_preview: true }),
      });
      if (res.ok) return;
    } catch (err) {
      console.error("owner alert via telegram threw:", err && err.message);
    }
  }
  if (env.NTFY_TOPIC) {
    try {
      const headers = { Title: title.replace(/[^\x20-\x7E]/g, " "), Priority: "high", Tags: "warning" };
      if (env.NTFY_TOKEN) headers.Authorization = "Bearer " + env.NTFY_TOKEN;
      const res = await fetch("https://ntfy.sh/" + encodeURIComponent(env.NTFY_TOPIC), { method: "POST", headers, body });
      if (res.ok) return;
    } catch (err) {
      console.error("owner alert via ntfy threw:", err && err.message);
    }
  }
  console.error("OWNER ALERT NOT DELIVERED:", title, "-", body);
}
