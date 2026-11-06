// Google Ads conversion feed: GET /api/conversions.csv
//
// WHY THIS EXISTS INSTEAD OF A GOOGLE TAG
// Google's own gtag.js sets _gcl_* cookies and loads from googletagmanager.com.
// Two things on this site rule that out: the privacy policy promises, in bold,
// that the site sets no cookies at all and therefore shows no cookie banner;
// and the CSP in _headers is script-src 'self' (the same reason PostHog is
// proxied through /ph/*). So conversions are reported the other way round:
//
//   1. site.js stores the ad click id (gclid / wbraid / gbraid) from the
//      landing URL in localStorage, for 90 days - Google's upload deadline.
//   2. The request form submits it in the hidden "Google click ID" field, so
//      it lands in requests.details alongside the booking.
//   3. Google Ads pulls this CSV and matches each click id back to the click
//      that produced it, crediting the campaign that actually earned the lead.
//
// No cookies, no third-party script, no CSP change, and nothing about the
// customer leaves the building: the only columns below are an identifier
// Google itself generated and the time the form was sent. Name, phone, email
// and address are read from `details` by nothing in this file.
//
// The conversion VALUE is deliberately not sent. It is configured once on the
// conversion action in the Google Ads UI, which keeps business numbers out of
// this repository - it is public.

import { constantTimeEqual } from "./admin.js";
import { contactLeadsForFeed } from "./contacts.js";

// Must match the conversion action name in Google Ads exactly, or every row
// is rejected as an unknown conversion.
const CONVERSION_NAME = "Request Form Submitted";

// Google refuses a conversion whose click is more than 90 days old, so older
// rows are noise that would earn a warning on every single pull.
const WINDOW_DAYS = 90;

// A full re-send of the window is safe (Google dedupes on click id + name +
// time, and the action counts One per click), so the feed is stateless. The
// cap is only here so a runaway table can never produce an endless response.
const MAX_ROWS = 5000;

// datetime('now') writes UTC in this exact shape; anything else is a row we
// cannot timestamp honestly, so it is skipped rather than guessed at.
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const FEED_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export async function handleConversionsFeed(request, env) {
  const refused = await refuseFeedRequest(request, env, "/api/conversions.csv");
  if (refused) return refused;

  const lines = ["Google Click ID,WBRAID,GBRAID,Conversion Name,Conversion Time"];

  for (const lead of await adLeads(env)) {
    const click = splitClickId(lead.clickId);
    if (!click) continue; // organic visit or a Microsoft click - nothing for Google to match

    lines.push([
      csv(click.kind === "gclid" ? click.value : ""),
      csv(click.kind === "wbraid" ? click.value : ""),
      csv(click.kind === "gbraid" ? click.value : ""),
      csv(CONVERSION_NAME),
      csv(`${lead.time}+00:00`),
    ].join(","));
  }

  // Google's connector infers the column schema from the first DATA row and
  // refuses a header-only file outright ("Failed to determine the data type or
  // schema of the data source"). This feed is legitimately header-only until an
  // ad click produces a booking, which would leave the connection impossible to
  // set up and liable to break again during any later re-validation.
  //
  // So when the window holds no real leads, one placeholder row stands in. Its
  // click id is deliberately not a real one, so Google rejects that single row
  // on import - a visible, harmless warning that also proves the feed is alive.
  // It removes itself the moment a genuine ad-sourced lead exists, with nothing
  // to remember to undo.
  if (lines.length === 1) {
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    lines.push(`SAMPLE-SCHEMA-ROW-NOT-A-REAL-CLICK,,,${CONVERSION_NAME},${stamp}+00:00`);
  }

  return new Response(lines.join("\r\n") + "\r\n", {
    status: 200,
    headers: { ...FEED_HEADERS, "Content-Type": "text/csv; charset=utf-8" },
  });
}

// The gate both conversion feeds share (Microsoft's is msconversions.js):
// a Response to send back when the request may not have the feed, else null.
export async function refuseFeedRequest(request, env, path) {
  // Loud on purpose. A feed that answered 200 with just a header row would be
  // indistinguishable from "no leads yet", which is precisely the silent
  // failure this whole mechanism exists to prevent.
  if (!env.CONVERSIONS_FEED_KEY) {
    console.error(`CONVERSIONS_FEED_KEY missing - ${path} is disabled`);
    return new Response("Conversion feed not configured\n", {
      status: 503,
      headers: { ...FEED_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!(await authorized(request, env.CONVERSIONS_FEED_KEY))) {
    return new Response("Unauthorized\n", {
      status: 401,
      headers: {
        ...FEED_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="conversions", charset="UTF-8"',
      },
    });
  }
  return null;
}

// Every lead in the window that carries an ad click id, as { clickId, time }
// with time in SQLite's UTC shape. Both feeds read this list and each keeps
// only the click ids its own ad network issued.
export async function adLeads(env) {
  const leads = [];

  const { results } = await env.DB.prepare(
    `SELECT details, created_at FROM requests
      WHERE created_at >= datetime('now', ?1)
      ORDER BY created_at ASC
      LIMIT ?2`
  ).bind(`-${WINDOW_DAYS} days`, MAX_ROWS).all();

  for (const row of results || []) {
    if (!SQLITE_UTC.test(String(row.created_at || ""))) continue;

    let details;
    try {
      details = JSON.parse(row.details || "{}");
    } catch (err) {
      // One unreadable row must not cost us every other lead in the file.
      console.error("conversions feed: unparseable details, row skipped");
      continue;
    }

    // The field predates Microsoft Ads; it holds whichever ad's click id
    // site.js stored, Microsoft's included.
    leads.push({ clickId: details["Google click ID"], time: row.created_at });
  }

  // Leads that texted or called instead of using the form (see contacts.js).
  // Only taps Mason confirmed in /admin appear here, timed at the tap.
  for (const row of await contactLeadsForFeed(env, WINDOW_DAYS, MAX_ROWS)) {
    if (!SQLITE_UTC.test(String(row.tapped_at))) continue;
    leads.push({ clickId: row.click_id, time: row.tapped_at });
  }

  return leads;
}

// Two ways in, because Google Ads' scheduled fetch offers a username/password
// pair on some source types and a bare URL on others.
async function authorized(request, secret) {
  const supplied = new URL(request.url).searchParams.get("key");
  if (supplied && (await constantTimeEqual(supplied, secret))) return true;

  const header = request.headers.get("Authorization") || "";
  if (/^Basic /i.test(header)) {
    let decoded;
    try {
      decoded = atob(header.slice(6).trim());
    } catch (err) {
      return false; // malformed header - a failed attempt, not an error
    }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (await constantTimeEqual(password, secret)) return true;
  }
  return false;
}

// site.js stores a gclid bare and prefixes the two iOS-privacy variants,
// because Google's upload wants each kind in its own column and silently
// drops a wbraid handed to it as a gclid.
function splitClickId(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) return null;
  if (value.startsWith("msclkid:")) return null; // Microsoft's - see msconversions.js
  if (value.startsWith("wbraid:")) return kindOf("wbraid", value.slice(7));
  if (value.startsWith("gbraid:")) return kindOf("gbraid", value.slice(7));
  return kindOf("gclid", value);
}

function kindOf(kind, value) {
  const trimmed = value.trim().slice(0, 200);
  return trimmed ? { kind, value: trimmed } : null;
}

export function csv(value) {
  const s = String(value == null ? "" : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
