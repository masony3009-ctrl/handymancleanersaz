// How a request's contact details are checked, and the key a client is
// stored under. Kept out of index.js so it can be tested without the Workers
// runtime (index.js imports cloudflare:email, which plain Node cannot load).
//
// A request needs a phone number OR an email. Requiring a phone cost about
// half of all form submissions in published tests (Unbounce, Vital Design),
// and the hosts most likely to skip it - owners reading on a laptop from
// another state - are exactly the ones who would rather get the price by email.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// clients.phone is NOT NULL UNIQUE and is the dedupe key. An email-only client
// is stored under "email:<address>" so it still dedupes, needs no schema
// change, and can never be mistaken for a dialable number (it has letters).
export const EMAIL_KEY_PREFIX = "email:";

export function checkContact(phoneRaw, emailRaw) {
  const phone = String(phoneRaw || "").replace(/\D/g, "");
  const email = String(emailRaw || "").trim();

  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, error: "Please enter a valid email address or leave the email field blank." };
  }
  if (phone && (phone.length < 10 || phone.length > 15)) {
    return { ok: false, error: "Please check the phone number - it should have 10 digits, for example 480-800-7789." };
  }
  if (!phone && !email) {
    return { ok: false, error: "Please add a phone number or an email so we can send your price." };
  }
  return { ok: true, phone, email, key: phone || EMAIL_KEY_PREFIX + email.toLowerCase() };
}

// True only for a stored key that is a real number (not an email-only key).
export function isDialable(key) {
  return /^\d{10,15}$/.test(String(key || ""));
}
