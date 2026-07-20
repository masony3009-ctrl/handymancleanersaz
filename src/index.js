// HandymanCleaners site Worker.
// Serves the static site (via the assets binding) and handles the
// service-request form: POST /api/request -> validate -> store in D1 -> email Mason.

import { EmailMessage } from "cloudflare:email";
import { handleAdmin } from "./admin.js";

const DEST = "handymancleanersaz@gmail.com";
const FROM = "requests@handymancleanersaz.com";
const MAX_FIELD = 2000; // per-field length cap
const MAX_FIELDS = 40;
const MAX_BODY_BYTES = 64 * 1024;

const ALLOWED_FIELDS = new Set([
  "website",
  "Name",
  "Phone",
  "Email",
  "Service type",
  "Cleaning date",
  "Cleaning date ISO",
  "Preferred arrival time",
  "Same-day turnover",
  "Guest checkout time",
  "Next guest check-in time",
  "Property address",
  "Bedrooms",
  "Bathrooms",
  "Current condition",
  "Supplies and linens",
  "Calendar sync requested",
  "Checklist or notes",
  "Add-ons or extra requests",
  "Handyman address",
  "Handyman preferred date",
  "Handyman preferred date ISO",
  "Handyman description",
  "Address",
  "Message",
  "How did you hear about us",
  "Acknowledgment",
]);

const SERVICE_TYPES = new Map([
  ["turnover", "Turnover cleaning for an Airbnb property (one-time)"],
  ["Turnover cleaning for an Airbnb property (one-time)", "Turnover cleaning for an Airbnb property (one-time)"],
  ["recurring", "Recurring cleaning for Airbnb hosts / calendar sync"],
  ["Recurring cleaning for Airbnb hosts / calendar sync", "Recurring cleaning for Airbnb hosts / calendar sync"],
  ["handyman", "Handyman / repairs & installs"],
  ["Handyman / repairs & installs", "Handyman / repairs & installs"],
  ["other", "Something else / not sure"],
  ["Something else / not sure", "Something else / not sure"],
]);

const CANONICAL_HOST = "handymancleanersaz.com";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Canonical host + scheme: 301 www/http/workers.dev variants to the
    // HTTPS apex so search engines see exactly one version of every URL.
    if (!LOCAL_HOSTS.has(url.hostname) && (url.hostname !== CANONICAL_HOST || url.protocol !== "https:")) {
      url.hostname = CANONICAL_HOST;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }

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
        if (err instanceof RequestInputError) {
          return json({ ok: false, error: err.message }, err.status);
        }
        console.error("request-form error:", err && err.message);
        return json(
          { ok: false, error: "Something went wrong on our end. Please email " + DEST + " or call 480-800-7789." },
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
  const name = singleLine(fields["Name"], 100);
  const phoneRaw = singleLine(fields["Phone"], 30);
  const phone = phoneRaw.replace(/\D/g, "");
  const email = singleLine(fields["Email"], 254);
  const serviceType = SERVICE_TYPES.get(singleLine(fields["Service type"], 100));
  const consent = clean(fields["Acknowledgment"]);

  if (!name || phone.length < 10 || phone.length > 15 || !serviceType) {
    return json({ ok: false, error: "Please fill in your name, a valid phone number, and the service you need." }, 400);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "Please enter a valid email address or leave the email field blank." }, 400);
  }
  if (!consent) {
    return json({ ok: false, error: "Please check the box agreeing to the Privacy Policy and Terms." }, 400);
  }

  // A public submission may create a client, but it must never overwrite an
  // existing client's trusted contact details just because the phone matches.
  // Every submission remains available as an immutable snapshot in details.
  const address = clean(
    fields["Property address"] || fields["Handyman address"] || fields["Address"] || "",
    300
  );
  const requestedDate = clean(
    fields["Cleaning date ISO"] || fields["Handyman preferred date ISO"] ||
    fields["Cleaning date"] || fields["Handyman preferred date"] || ""
  );

  await env.DB.prepare(
    `INSERT INTO clients (name, phone, email) VALUES (?1, ?2, ?3)
     ON CONFLICT(phone) DO NOTHING`
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
  const mediaType = ct.split(";", 1)[0].trim();
  const fields = {};
  let wantsHtml = false;

  if (mediaType === "application/json") {
    const raw = await readBoundedText(request);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new RequestInputError(400, "The request could not be read. Please refresh the page and try again.");
    }
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new RequestInputError(400, "The request could not be read. Please refresh the page and try again.");
    }
    for (const [k, v] of Object.entries(body || {})) {
      if (Object.keys(fields).length >= MAX_FIELDS) break;
      const key = String(k).slice(0, 100);
      if (!ALLOWED_FIELDS.has(key)) continue;
      fields[key] = String(v == null ? "" : v).replace(/\0/g, "").slice(0, MAX_FIELD);
    }
  } else if (mediaType === "application/x-www-form-urlencoded") {
    // Plain form post (no-JS fallback).
    wantsHtml = true;
    const form = new URLSearchParams(await readBoundedText(request));
    for (const [k, v] of form) {
      if (Object.keys(fields).length >= MAX_FIELDS) break;
      const key = String(k).slice(0, 100);
      if (!ALLOWED_FIELDS.has(key)) continue;
      fields[key] = String(v).replace(/\0/g, "").slice(0, MAX_FIELD);
    }
  } else {
    throw new RequestInputError(415, "Unsupported request format. Please refresh the page and try again.");
  }
  return { fields, wantsHtml };
}

async function readBoundedText(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RequestInputError(413, "That request is too large. Please shorten the notes and try again.");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestInputError(413, "That request is too large. Please shorten the notes and try again.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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

function clean(v, max = MAX_FIELD) {
  return String(v == null ? "" : v).replace(/\0/g, "").trim().slice(0, max);
}

function singleLine(v, max) {
  return clean(v, max).replace(/[\r\n\t]/g, " ").replace(/\s{2,}/g, " ");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    },
  });
}

function htmlThanks() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Request received | HandymanCleaners</title><link rel="stylesheet" href="/styles.css"></head><body><main style="display:grid;place-items:center;min-height:70vh;padding:24px;text-align:center;"><div><h1 style="font-size:34px;">Request received</h1><p style="max-width:460px;color:#5c6b76;">Thanks - we have your request and will get back to you shortly by phone, text, or email.</p><p><a class="button primary" href="/" style="display:inline-flex;min-height:46px;align-items:center;padding:0 22px;background:#0aa5a0;color:#fff;border-radius:10px;text-decoration:none;font-weight:800;">Back to the site</a></p></div></main></body></html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      },
    }
  );
}

class RequestInputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
