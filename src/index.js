// HandymanCleaners site Worker.
// Serves the static site (via the assets binding) and handles the
// service-request form: POST /api/request -> validate -> store in D1 -> email Mason.

import { EmailMessage } from "cloudflare:email";
import { handleAdmin } from "./admin.js";

const DEST = "handymancleanersaz@gmail.com";
const FROM = "requests@handymancleanersaz.com";
const MAX_FIELD = 2000; // per-field length cap
const MAX_FIELDS = 40;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env);
    }

    if (url.pathname === "/api/request") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }
      try {
        return await handleRequestForm(request, env);
      } catch (err) {
        console.error("request-form error:", err && err.message);
        return json(
          { ok: false, error: "Something went wrong on our end. Please email " + DEST + " or call 650-265-1193." },
          500
        );
      }
    }

    // Everything else: static site.
    return env.ASSETS.fetch(request);
  },
};

async function handleRequestForm(request, env) {
  const { fields, wantsHtml } = await readSubmission(request);

  // Honeypot: bots fill the hidden "website" field. Pretend success, store nothing.
  if (fields["website"]) {
    return wantsHtml ? htmlThanks() : json({ ok: true });
  }

  // Validate the required contact basics.
  const name = clean(fields["Name"]);
  const phoneRaw = clean(fields["Phone"]);
  const phone = phoneRaw.replace(/\D/g, "");
  const email = clean(fields["Email"]);
  const serviceType = clean(fields["Service type"]);
  const consent = clean(fields["Acknowledgment"]);

  if (!name || phone.length < 10 || !serviceType) {
    return json({ ok: false, error: "Please fill in your name, a valid phone number, and the service you need." }, 400);
  }
  if (!consent) {
    return json({ ok: false, error: "Please check the box agreeing to the Privacy Policy and Terms." }, 400);
  }

  // Store: dedupe the client by phone, then record the request.
  const address = clean(
    fields["Property address"] || fields["Office address"] || fields["Handyman address"] || fields["Restock address"] || fields["Address"] || ""
  );
  const requestedDate = clean(fields["Cleaning date"] || fields["Handyman preferred date"] || "");

  await env.DB.prepare(
    `INSERT INTO clients (name, phone, email) VALUES (?1, ?2, ?3)
     ON CONFLICT(phone) DO UPDATE SET
       name = excluded.name,
       email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE clients.email END`
  ).bind(name, phone, email).run();

  const client = await env.DB.prepare(`SELECT id FROM clients WHERE phone = ?1`).bind(phone).first();

  await env.DB.prepare(
    `INSERT INTO requests (client_id, service_type, address, requested_date, details)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(client.id, serviceType, address, requestedDate, JSON.stringify(fields)).run();

  // Email the submission. If email delivery hiccups, the request is already
  // saved in D1 - report success but log loudly.
  try {
    await sendNotification(env, fields, serviceType, requestedDate);
  } catch (err) {
    console.error("email send failed (request IS saved in D1):", err && err.message);
  }

  return wantsHtml ? htmlThanks() : json({ ok: true });
}

async function readSubmission(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  const fields = {};
  let wantsHtml = false;

  if (ct.includes("application/json")) {
    const body = await request.json();
    for (const [k, v] of Object.entries(body || {})) {
      if (Object.keys(fields).length >= MAX_FIELDS) break;
      fields[String(k).slice(0, 100)] = String(v == null ? "" : v).slice(0, MAX_FIELD);
    }
  } else {
    // Plain form post (no-JS fallback).
    wantsHtml = true;
    const form = await request.formData();
    for (const [k, v] of form.entries()) {
      if (Object.keys(fields).length >= MAX_FIELDS) break;
      if (typeof v === "string") fields[String(k).slice(0, 100)] = v.slice(0, MAX_FIELD);
    }
  }
  return { fields, wantsHtml };
}

async function sendNotification(env, fields, serviceType, requestedDate) {
  const lines = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!v || k === "website") continue;
    lines.push(k + ": " + v);
  }
  const subjectSafe = ("Service request - " + serviceType + (requestedDate ? " - " + requestedDate : ""))
    .replace(/[^\x20-\x7E]/g, " ")
    .slice(0, 150);

  const raw =
    `From: HandymanCleaners Website <${FROM}>\r\n` +
    `To: <${DEST}>\r\n` +
    `Subject: ${subjectSafe}\r\n` +
    `Message-ID: <${crypto.randomUUID()}@handymancleanersaz.com>\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    `New service request from the website:\r\n\r\n` +
    lines.join("\r\n") +
    `\r\n\r\n(Stored in the client database. Reply to the customer's email or call/text their phone above.)\r\n`;

  await env.NOTIFY.send(new EmailMessage(FROM, DEST, raw));
}

function clean(v) {
  return String(v == null ? "" : v).trim().slice(0, MAX_FIELD);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlThanks() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Request received | HandymanCleaners</title><link rel="stylesheet" href="/styles.css"></head><body><main style="display:grid;place-items:center;min-height:70vh;padding:24px;text-align:center;"><div><h1 style="font-size:34px;">Request received</h1><p style="max-width:460px;color:#5c6b76;">Thanks - we have your request and will get back to you shortly by phone, text, or email.</p><p><a class="button primary" href="/" style="display:inline-flex;min-height:46px;align-items:center;padding:0 22px;background:#0aa5a0;color:#fff;border-radius:3px;text-decoration:none;font-weight:800;">Back to the site</a></p></div></main></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
