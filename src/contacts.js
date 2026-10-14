// Texts and calls from people who arrived on a Google ad.
//
// WHY THIS EXISTS
// The conversion feed (conversions.js) credits an ad click only when the
// visitor submits the request form, because that is the only moment the click
// id reaches the server. Many customers text or call instead - including the
// best one so far, a host with 3-5 turnovers a month who texted. Those leads
// never reached Google, so the campaign that earned them looked like it had
// produced nothing.
//
// HOW IT WORKS
//   1. site.js already keeps the ad click id in localStorage (see hcClickId).
//   2. When such a visitor taps a Text or Call link, site.js derives a short
//      reference from the click id (refFor below - the browser runs the same
//      algorithm) and beacons {ref, channel, click} to POST /api/contact-tap.
//      A Text link also opens the message pre-filled with "ref XXXXX".
//   3. The tap is stored here. Nothing is a conversion yet: anyone can tap.
//   4. When the text or call turns out to be a real lead, Mason marks it in
//      /admin - matching a text by its ref, a call by the time it came in.
//   5. Marked taps join the conversion feed under the same conversion name as
//      form submissions. For bidding, a lead is a lead.
//
// PRIVACY
// Nothing is sent unless the visitor taps Text or Call, which is the same kind
// of deliberate contact as submitting the form, and the privacy policy says so.
// The site never sees the phone number or the message: those go through the
// visitor's own phone. Only Google's click identifier, the channel, and the
// time are stored. No cookies are involved.

// 31 symbols: digits and capitals minus 0/O and 1/I/L, so a ref read out over
// the phone or typed back from a text cannot be misread.
export const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REF_LENGTH = 5;

const CHANNELS = new Set(["text", "call"]);

// Matches what site.js stores: a bare gclid, or "wbraid:"/"gbraid:" + value.
const CLICK_ID = /^(?:(?:wbraid|gbraid):)?[A-Za-z0-9_.-]{10,200}$/;

// One person tapping Text three times is one contact, not three.
const DEDUPE_MINUTES = 10;

// Deterministic, so the browser and the server agree without a round trip and
// the server can reject a ref that does not belong to the click id it came with.
export async function refFor(clickId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(clickId)));
  const bytes = new Uint8Array(digest);
  let ref = "";
  for (let i = 0; i < REF_LENGTH; i++) ref += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return ref;
}

// Created on first use, so a deploy needs no separate migration step. The same
// statements are recorded in schema.sql.
let tableReady = false;
export async function ensureContactsTable(env) {
  if (tableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ad_contacts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ref TEXT NOT NULL,
       channel TEXT NOT NULL,
       click_id TEXT NOT NULL,
       tapped_at TEXT NOT NULL DEFAULT (datetime('now')),
       lead_at TEXT
     )`
  ).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ad_contacts_tapped ON ad_contacts(tapped_at)`).run();
  tableReady = true;
}

// Test hook: the module-level flag would otherwise leak between test cases.
export function resetContactsTableFlag() {
  tableReady = false;
}

export class ContactTapError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Parse and validate a beacon body. Exported so the rules are testable on
// their own. navigator.sendBeacon sends a string as text/plain, so the body is
// read as text and parsed regardless of Content-Type.
export async function parseContactTap(text) {
  if (typeof text !== "string" || text.length > 1000) throw new ContactTapError("Bad request", 400);
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new ContactTapError("Bad request", 400);
  }
  const channel = String((body && body.channel) || "");
  const click = String((body && body.click) || "");
  const ref = String((body && body.ref) || "");
  if (!CHANNELS.has(channel) || !CLICK_ID.test(click)) throw new ContactTapError("Bad request", 400);
  if (ref !== (await refFor(click))) throw new ContactTapError("Bad request", 400);
  return { channel, click, ref };
}

export async function handleContactTap(request, env) {
  // Same per-IP limiter as the request form. Fails open, like the form: a lost
  // attribution is worse than a few junk rows nobody will ever mark as a lead.
  if (env.REQUEST_LIMITER) {
    try {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const verdict = await env.REQUEST_LIMITER.limit({ key: "tap:" + ip });
      if (!verdict.success) return new Response(null, { status: 429 });
    } catch (err) {
      console.error("contact-tap limiter errored, failing open:", err && err.message);
    }
  }

  const tap = await parseContactTap(await request.text());
  await ensureContactsTable(env);

  const recent = await env.DB.prepare(
    `SELECT id FROM ad_contacts
      WHERE ref = ?1 AND channel = ?2 AND tapped_at >= datetime('now', ?3)
      LIMIT 1`
  ).bind(tap.ref, tap.channel, `-${DEDUPE_MINUTES} minutes`).first();
  if (!recent) {
    await env.DB.prepare(`INSERT INTO ad_contacts (ref, channel, click_id) VALUES (?1, ?2, ?3)`)
      .bind(tap.ref, tap.channel, tap.click).run();
  }
  return new Response(null, { status: 204 });
}

// For /admin. The click id itself is not sent to the page: Mason matches on the
// ref (texts) or the time (calls), and never needs the raw identifier.
export async function listContactTaps(env) {
  await ensureContactsTable(env);
  const { results } = await env.DB.prepare(
    `SELECT id, ref, channel, tapped_at, lead_at FROM ad_contacts
      WHERE tapped_at >= datetime('now', '-30 days')
      ORDER BY tapped_at DESC LIMIT 200`
  ).all();
  return results || [];
}

export async function setContactLead(env, id, isLead) {
  await ensureContactsTable(env);
  await env.DB.prepare(
    `UPDATE ad_contacts SET lead_at = CASE WHEN ?2 = 1 THEN datetime('now') ELSE NULL END WHERE id = ?1`
  ).bind(id, isLead ? 1 : 0).run();
}

// Rows for the conversion feed: taps Mason confirmed as leads, timed at the tap
// (when the contact actually happened), inside Google's 90-day upload window.
// A missing table means no taps have ever been recorded - zero rows, not an
// error, so the feed keeps serving form conversions regardless.
export async function contactLeadsForFeed(env, windowDays, maxRows) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT click_id, tapped_at FROM ad_contacts
        WHERE lead_at IS NOT NULL AND tapped_at >= datetime('now', ?1)
        ORDER BY tapped_at ASC
        LIMIT ?2`
    ).bind(`-${windowDays} days`, maxRows).all();
    return (results || []).filter((r) => r && r.click_id && r.tapped_at);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return [];
    throw err;
  }
}
