// Microsoft Ads conversion feed: GET /api/microsoft-conversions.csv
//
// The Microsoft Advertising twin of conversions.js, and it exists for the same
// reason: Microsoft's own tag (UET) sets cookies and loads a third-party
// script, and the privacy policy promises this site does neither. So site.js
// stores Microsoft's click id (msclkid) exactly as it stores Google's, prefixed
// "msclkid:", and Microsoft Advertising pulls this CSV on a schedule (Tools >
// Offline conversions > Offline conversion schedules) and matches each id back
// to the click that produced it.
//
// Same leads, same key, same rules as the Google feed: form submissions plus
// text/call taps Mason confirmed in /admin, and nothing about the customer -
// only Microsoft's own identifier and the time of the lead. No value is sent;
// the conversion goal in the Microsoft UI is set not to assign one.

import { FEED_HEADERS, adLeads, csv, refuseFeedRequest } from "./conversions.js";

// Must match the offline conversion goal name in Microsoft Advertising exactly.
const CONVERSION_NAME = "Request Form Submitted";

// Microsoft's import template: a time zone line, then these columns. Value and
// currency stay empty, and the two hashed-customer columns of the template are
// left out entirely - those are for enhanced conversions, which this site does
// not send.
const PARAMETERS = "Parameters:TimeZone=+0000";
const HEADER = "Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Microsoft Click ID";

const PREFIX = "msclkid:";

export async function handleMicrosoftConversionsFeed(request, env) {
  const refused = await refuseFeedRequest(request, env, "/api/microsoft-conversions.csv");
  if (refused) return refused;

  const lines = [PARAMETERS, HEADER];

  for (const lead of await adLeads(env)) {
    const id = microsoftClickId(lead.clickId);
    if (!id) continue; // organic visit or a Google click - nothing for Microsoft to match
    lines.push([csv(CONVERSION_NAME), csv(microsoftTime(lead.time)), "", "", csv(id)].join(","));
  }

  // Microsoft's "Save and preview" would not save the schedule while this file
  // held no data rows, the same wall Google's connector hit (see conversions.js).
  // So the same fix: with no real leads, one placeholder row whose click id is
  // deliberately fake. Microsoft rejects that row on import - a harmless warning
  // that proves the feed is alive - and it disappears with the first real lead.
  if (lines.length === 2) {
    const stamp = microsoftTime(new Date().toISOString().slice(0, 19).replace("T", " "));
    lines.push(`${CONVERSION_NAME},${stamp},,,SAMPLE-SCHEMA-ROW-NOT-A-REAL-CLICK`);
  }

  return new Response(lines.join("\r\n") + "\r\n", {
    status: 200,
    headers: { ...FEED_HEADERS, "Content-Type": "text/csv; charset=utf-8" },
  });
}

function microsoftClickId(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value.startsWith(PREFIX)) return "";
  return value.slice(PREFIX.length).trim().slice(0, 200);
}

// "2026-11-05 18:04:11" (UTC, as SQLite writes it) -> "11/5/2026 6:04:11 PM",
// the shape Microsoft's own offline conversion examples use. The time zone
// line above says it is UTC.
export function microsoftTime(sqliteUtc) {
  const [date, time] = String(sqliteUtc).split(" ");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":");
  const h = Number(hour);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${month}/${day}/${year} ${h12}:${minute}:${second} ${h < 12 ? "AM" : "PM"}`;
}
