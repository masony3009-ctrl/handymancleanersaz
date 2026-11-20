// Shared site behavior for all pages.
(function () {
  // Mobile nav toggle
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".site-header nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.addEventListener("click", function (event) {
      if (event.target.tagName === "A") {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Google Ads click attribution.
  //
  // When someone arrives from a Google ad the URL carries a click id (gclid,
  // or wbraid/gbraid on iOS). Stash it so that if they submit the request
  // form - possibly several pages and days later - the booking records which
  // ad click produced it. That is the ground truth for whether ad spend is
  // working, independent of any tag Google does or does not manage to fire.
  //
  // localStorage, not a cookie, on purpose: the privacy policy promises this
  // site sets no cookies and shows no cookie banner. Ninety days is Google's
  // hard deadline for uploading an offline conversion after the click (the
  // click-through conversion WINDOW is a separate account setting, 30 days by
  // default, and must be raised to 90 in the account); older ids are useless
  // to upload, so treat them as expired.
  //
  // gclid, wbraid and gbraid are three DIFFERENT identifiers, and Google's
  // offline-conversion upload requires exactly one of them in its own column
  // - a wbraid uploaded in the gclid column is silently rejected. So the kind
  // is recorded along with the value: gclid values are stored bare, and the
  // iOS-privacy variants are prefixed ("wbraid:..." / "gbraid:..."), which is
  // exactly how they land in the booking record for the upload script to
  // split apart.
  //
  // Microsoft Ads (Bing) clicks carry msclkid instead, stored the same way as
  // "msclkid:..." and reported by src/msconversions.js; the Google feed skips
  // them. Microsoft's offline-conversion window is also 90 days.
  (function () {
    var KEY = "hc_gclid";
    var MAX_AGE_MS = 90 * 864e5;

    try {
      var q = new URLSearchParams(location.search);
      var kinds = ["gclid", "wbraid", "gbraid", "msclkid"];
      for (var i = 0; i < kinds.length; i++) {
        var id = q.get(kinds[i]);
        if (id) {
          window.localStorage.setItem(KEY, JSON.stringify({
            v: id.slice(0, 200),
            k: kinds[i],
            t: Date.now()
          }));
          break;
        }
      }
    } catch (e) { /* private mode or no storage - attribution is best-effort */ }

    // Read back the stored click id ("" when absent/expired/unreadable).
    // Bare value for gclid; "wbraid:..." / "gbraid:..." for the iOS variants.
    window.hcClickId = function () {
      try {
        var raw = window.localStorage.getItem(KEY);
        if (!raw) return "";
        var o = JSON.parse(raw);
        if (!o || !o.v || !o.t) return "";
        if (Date.now() - o.t > MAX_AGE_MS) return "";
        return (o.k && o.k !== "gclid" ? o.k + ":" : "") + o.v;
      } catch (e) {
        return "";
      }
    };
  })();

  // Texts and calls from ad visitors (server side: src/contacts.js).
  //
  // Many customers text or call instead of using the form, and those leads
  // could never be credited to the ad that produced them. So when this visitor
  // arrived on a Google ad, every Text link opens the message with a short
  // reference ("ref K7Q2M"), and tapping Text or Call tells the server which
  // ad click it came from. Mason confirms the real leads in /admin, and only
  // those reach Google. Nothing is sent for visitors who did not come from an
  // ad, and nothing is sent until they tap - the privacy policy says so.
  //
  // The ref MUST be computed exactly as refFor() in src/contacts.js: the
  // server rejects a ref that does not match the click id it arrives with.
  (function () {
    var ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    var LENGTH = 5;
    var click = window.hcClickId ? window.hcClickId() : "";
    if (!click || !window.crypto || !window.crypto.subtle || !window.TextEncoder) return;
    var ref = "";

    window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(click)).then(function (buf) {
      var bytes = new Uint8Array(buf);
      for (var i = 0; i < LENGTH; i++) ref += ALPHABET[bytes[i] % ALPHABET.length];
      tagTextLinks();
    }).catch(function () { /* attribution is best-effort */ });

    // sms:NUMBER  or  sms:NUMBER?&body=TEXT (the cross-platform form this site uses)
    function withRef(href) {
      var m = /^sms:([^?]*)(?:\?&?body=(.*))?$/i.exec(href || "");
      if (!m || !ref) return href;
      var body = "";
      try { body = m[2] != null ? decodeURIComponent(m[2]) : ""; } catch (e) { return href; }
      if (body.indexOf("ref " + ref) !== -1) return href;
      body = body ? body + " (ref " + ref + ")" : "Hi! (ref " + ref + ") ";
      return "sms:" + m[1] + "?&body=" + encodeURIComponent(body);
    }

    function tagTextLinks() {
      var links = document.querySelectorAll('a[href^="sms:"]');
      for (var i = 0; i < links.length; i++) links[i].setAttribute("href", withRef(links[i].getAttribute("href")));
    }

    // Capture phase, so it runs before the browser follows the link. Links
    // created after load (the contact card) are tagged here at tap time.
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="sms:"], a[href^="tel:"]') : null;
      if (!a || !ref) return;
      var channel = /^sms:/i.test(a.getAttribute("href")) ? "text" : "call";
      if (channel === "text") a.setAttribute("href", withRef(a.getAttribute("href")));
      try {
        navigator.sendBeacon("/api/contact-tap", JSON.stringify({ ref: ref, channel: channel, click: click }));
      } catch (err) { /* attribution is best-effort */ }
    }, true);
  })();

  // Legacy anchors from the old single-page site -> their new homes.
  if (location.pathname === "/") {
    var moved = {
      "#request": "/request-service/",
      "#checklist": "/services/vacation-rental-turnover-cleaning/#checklist"
    };
    var dest = moved[location.hash];
    if (dest) location.replace(dest);
  }

  // Contact card: after a short delay, a small corner card asks a few quick
  // questions and turns the answers into a ready-to-send price text.
  // Non-blocking by design - no overlay, no scroll lock, the page stays fully
  // usable. Shown once per visitor (remembered 30 days); never on the request
  // page, where they are already filling out the form.
  //
  // It replaced a free-walkthrough invite that was shown 213 times in
  // Sept-Oct 2026 and texted 0. A text that arrives already written, with a
  // question we can answer in one reply, is the whole point.
  (function () {
    var KEY = "hc_cp_seen";
    var DELAY_MS = 12000;
    var REMEMBER_DAYS = 30;
    var PHONE = "4808007789";
    var path = location.pathname;

    var CITIES = ["San Tan Valley", "Queen Creek", "Gilbert", "Mesa", "Somewhere else"];
    var BEDS = ["1", "2", "3", "4", "5+"];
    var BATHS = ["1", "1.5", "2", "2.5", "3", "3.5", "4+"];

    function size(v) {
      var s = [v.beds && v.beds + " bed", v.baths && v.baths + " bath"].filter(Boolean).join(" / ");
      return s ? s + " " : "";
    }

    function where(v) {
      return v.city && v.city !== "Somewhere else" ? " in " + v.city : "";
    }

    // Options are [value, label] when the text needs different wording than
    // the dropdown shows.
    var HOME_KINDS = [
      ["cleaning every 2 weeks", "Every 2 weeks"],
      ["weekly cleaning", "Weekly"],
      ["monthly cleaning", "Monthly"]
    ];

    function turnover(noun) {
      return {
        kicker: "Quick Price",
        title: "What’s Your Turnover Rate?",
        body: "Pick your rental’s size and city and we’ll text back your exact flat rate within 30 minutes (9 AM–9 PM).",
        label: "Turnover price check",
        fields: [["beds", "Beds", BEDS], ["baths", "Baths", BATHS], ["city", "City", CITIES]],
        service: function () { return "turnover"; },
        msg: function (v) {
          return "Hi! What would a turnover cost for my " + size(v) + noun + where(v) + "?";
        }
      };
    }

    var HOME = {
      kicker: "Quick Price",
      title: "What Would Your Home Cost?",
      body: "Pick how often and your home’s size. We’ll text back a price within 30 minutes (9 AM–9 PM), then lock the exact rate at a free walkthrough.",
      label: "House cleaning price check",
      fields: [["kind", "How often", HOME_KINDS, true], ["beds", "Beds", BEDS], ["baths", "Baths", BATHS], ["city", "City", CITIES]],
      service: function () { return "housecleaning"; },
      msg: function (v) {
        return "Hi! What would " + (v.kind || "a house cleaning") + " cost for my " + size(v) + "home" + where(v) + "?";
      }
    };

    var HANDYMAN = {
      kicker: "Quick Price",
      title: "What Needs Doing?",
      body: "Pick the job and city and we’ll text back a price within 30 minutes (9 AM–9 PM). $100 first hour, $80/hr after. Not a licensed contractor.",
      label: "Handyman price check",
      fields: [["job", "Pick the job", [
        ["a TV wall mount", "TV wall mount"],
        ["a ceiling fan install", "Ceiling fan install"],
        ["a light fixture swap", "Light fixture swap"],
        ["a faucet replacement", "Faucet replacement"],
        ["a small drywall patch", "Small drywall patch"],
        ["a door repair", "Door repair"],
        ["some furniture or BBQ assembly", "Assembly"],
        ["a handyman job", "Something else"]
      ], true], ["city", "City", CITIES, true]],
      service: function () { return "handyman"; },
      msg: function (v) {
        return "Hi! What would " + (v.job || "a handyman job") + " cost" + where(v) + "?";
      }
    };

    // Pages with no single service (about, legal, 404) ask which one first.
    var ANY = {
      kicker: "Quick Price",
      title: "Get a Price by Text",
      body: "Pick what you need and your home’s size. We’ll text back a price within 30 minutes (9 AM–9 PM).",
      label: "Cleaning price check",
      fields: [["svc", "What do you need?", [
        ["turnover", "Airbnb / Vrbo turnover"],
        ["a house cleaning", "House cleaning"]
      ], true], ["beds", "Beds", BEDS], ["baths", "Baths", BATHS], ["city", "City", CITIES]],
      service: function (v) {
        if (v.svc === "turnover") return "turnover";
        return v.svc ? "housecleaning" : "other";
      },
      msg: function (v) {
        if (v.svc === "turnover") return turnover("rental").msg(v);
        return "Hi! What would " + (v.svc || "a cleaning") + " cost for my " + size(v) + "home" + where(v) + "?";
      }
    };

    // The card follows the page it appears on: a homeowner reading about house
    // cleaning is not handing over a key to a rental, and rental copy there
    // reads as though we mistook what they came for. The Mesa page leads with
    // house cleaning; Mesa's Airbnb page is /locations/mesa/airbnb-cleaning/.
    // The homepage and the other city pages lead with Airbnb turnovers.
    var COPY =
      /^\/services\/house-cleaning|^\/locations\/[^\/]+\/house-cleaning\/|^\/locations\/mesa\/?$/.test(path) ? HOME :
      /^\/services\/handyman/.test(path) ? HANDYMAN :
      /^\/services\/airbnb/.test(path) ? turnover("Airbnb") :
      /^\/services\/vrbo/.test(path) ? turnover("Vrbo") :
      /^\/(services|locations)\//.test(path) || path === "/" ? turnover("rental") :
      turnover("rental"); // was ANY (asks house cleaning vs turnover); residential paused Nov 16 2026

    if (location.pathname.indexOf("/request-service") === 0) return;
    // Pages with the inline price box (below) already ask the same questions
    // in the page itself; a second, timed copy only interrupts.
    if (document.querySelector("[data-quick-price]")) return;

    function seen() {
      try {
        var until = window.localStorage.getItem(KEY);
        return until && Number(until) > Date.now();
      } catch (e) {
        return false; // storage blocked: show it, but never loop
      }
    }

    function remember() {
      try {
        window.localStorage.setItem(KEY, String(Date.now() + REMEMBER_DAYS * 864e5));
      } catch (e) { /* private mode - fine */ }
    }

    if (seen()) return;

    var card;

    function close() {
      if (!card) return;
      remember();
      document.removeEventListener("keydown", onKey);
      var dying = card;
      card = null;
      dying.classList.add("cp-closing");
      setTimeout(function () { if (dying.parentNode) dying.remove(); }, 200);
    }

    function onKey(e) {
      if (e.key === "Escape") close();
    }

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function input(type, name, placeholder, auto) {
      var i = el("input", "ph-no-capture");
      i.type = type;
      i.name = name;
      i.placeholder = placeholder;
      i.setAttribute("aria-label", placeholder);
      i.autocomplete = auto;
      return i;
    }

    // A computer has nothing to send an sms: link with, so there the card
    // takes a name and number and sends the answers through the request form's
    // endpoint (email + phone alert + TurnTrack), and we text the price back.
    // Oct 29 2026: both desktop visitors who answered the questions got
    // nowhere - one gave up, one picked up her phone and texted anyway.
    var CAN_TEXT = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

    function sendForm(values, filled) {
      var form = el("form", "cp-send");
      var host = card; // the card may be closed while a send is in flight
      var name = input("text", "Name", "Your name", "name");
      var phone = input("tel", "Phone", "Mobile number (we text your price)", "tel");
      var email = input("email", "Email", "Email (optional)", "email");
      name.required = true;
      phone.required = true;
      phone.pattern = "[^0-9]*([0-9][^0-9]*){10,15}";
      phone.title = "A 10-digit phone number";

      var consent = el("label", "cp-consent");
      var box = el("input");
      box.type = "checkbox";
      box.required = true;
      consent.appendChild(box);
      consent.appendChild(document.createTextNode(" I agree to the "));
      var privacy = el("a", null, "Privacy Policy");
      privacy.href = "/privacy/";
      var terms = el("a", null, "Terms");
      terms.href = "/terms/";
      consent.appendChild(privacy);
      consent.appendChild(document.createTextNode(" and "));
      consent.appendChild(terms);
      consent.appendChild(document.createTextNode("."));

      var send = el("button", "button primary", "Text Me My Price");
      send.type = "submit";
      var status = el("p", "cp-status");
      status.setAttribute("role", "status");

      [name, phone, email, consent, send, status].forEach(function (n) { form.appendChild(n); });

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (send.disabled) return;
        var v = values();
        var data = {
          "Name": name.value,
          "Phone": phone.value,
          "Email": email.value,
          "Service type": COPY.service(v),
          "Message": COPY.msg(v) + " (sent from the quick-price box on " + path + ")",
          "Acknowledgment": "Agreed to Privacy Policy and Terms",
          "Google click ID": typeof window.hcClickId === "function" ? window.hcClickId() : ""
        };
        if (v.beds) data["Bedrooms"] = v.beds;
        if (v.baths) data["Bathrooms"] = v.baths;
        if (v.city && v.city !== "Somewhere else") data["Address"] = v.city + ", AZ";

        send.disabled = true;
        send.textContent = "Sending…";
        status.textContent = "";
        fetch("/api/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data)
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok || !body.ok) throw new Error(body.error || "");
          });
        }).then(function () {
          remember();
          form.replaceWith(el("p", "cp-done", "Got it! We’ll text your price to " + phone.value +
            " within 30 minutes (9 AM–9 PM)."));
          host.dispatchEvent(new CustomEvent("hc:popup-sent", { detail: { filled: filled(v) } }));
        }).catch(function (err) {
          send.disabled = false;
          send.textContent = "Text Me My Price";
          status.textContent = (err.message || "That didn’t go through.") +
            " You can also call or text Mason at 480-800-7789.";
          host.dispatchEvent(new CustomEvent("hc:popup-error"));
        });
      });
      return form;
    }

    function open() {
      if (card || seen()) return;

      card = el("aside", "cp-card");
      card.setAttribute("role", "complementary");
      card.setAttribute("aria-label", COPY.label);

      var x = el("button", "cp-close", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Dismiss");
      x.onclick = close;
      card.appendChild(x);

      card.appendChild(el("p", "cp-kicker", COPY.kicker));
      card.appendChild(el("h2", null, COPY.title));
      card.appendChild(el("p", null, COPY.body));

      var actions = el("div", "cp-actions");
      var text = el("a", "button primary", "Text Me My Price");
      var pick = {};

      function values() {
        var v = {};
        Object.keys(pick).forEach(function (k) { v[k] = pick[k].value; });
        return v;
      }

      // Which answers were given, never what they were.
      function filled(v) {
        return Object.keys(v).filter(function (k) { return v[k]; }).join(",");
      }

      function update() {
        var v = values();
        text.href = "sms:" + PHONE + "?&body=" + encodeURIComponent(COPY.msg(v));
        text.setAttribute("data-filled", filled(v));
      }

      text.addEventListener("click", function () { setTimeout(close, 120); });

      var fields = el("div", "cp-fields");
      COPY.fields.forEach(function (f) {
        var sel = el("select", f[3] ? "cp-wide" : null);
        sel.setAttribute("aria-label", f[1]);
        sel.appendChild(new Option(f[1], ""));
        f[2].forEach(function (o) {
          sel.appendChild(typeof o === "string" ? new Option(o, o) : new Option(o[1], o[0]));
        });
        sel.addEventListener("change", update);
        pick[f[0]] = sel;
        fields.appendChild(sel);
      });
      card.appendChild(fields);
      update();

      if (CAN_TEXT) actions.appendChild(text);
      else actions.appendChild(sendForm(values, filled));

      card.appendChild(actions);
      document.body.appendChild(card);
      document.addEventListener("keydown", onKey);
    }

    setTimeout(open, DELAY_MS);
  })();

  // Inline price box on the rental landing pages (Nov 20 2026).
  // Every paid-ad contact through Nov 19 came from the popup's "Text Me My
  // Price", yet as a popup it appeared ~11s in and was closed ~5s later
  // (39 shown, 1 used, Oct 28 - Nov 19). Here the same questions sit in the
  // page itself, as one-tap buttons instead of dropdowns, and a computer (or
  // a phone visitor who would rather not text) can send it as a short form
  // that needs a phone OR an email (src/contactkey.js).
  (function () {
    var mount = document.querySelector("[data-quick-price]");
    if (!mount) return;

    var PHONE = "4808007789";
    var noun = mount.getAttribute("data-noun") || "rental";
    var path = location.pathname;
    var GROUPS = [
      ["beds", "Bedrooms", ["1", "2", "3", "4", "5+"]],
      ["baths", "Bathrooms", ["1", "1.5", "2", "2.5", "3", "3.5", "4+"]],
      ["city", "City", ["San Tan Valley", "Queen Creek", "Gilbert", "Mesa", "Somewhere else"]]
    ];
    var CAN_TEXT = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    var v = {};
    var picked = false;

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function emit(name, detail) {
      mount.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail || {} }));
    }

    function filled() {
      return Object.keys(v).filter(function (k) { return v[k]; }).join(",");
    }

    function msg() {
      var size = [v.beds && v.beds + " bed", v.baths && v.baths + " bath"].filter(Boolean).join(" / ");
      var where = v.city && v.city !== "Somewhere else" ? " in " + v.city : "";
      return "Hi! What would a turnover cost for my " + (size ? size + " " : "") + noun + where + "?";
    }

    var card = el("div", "qp-box");
    card.setAttribute("aria-label", "Turnover price check");

    GROUPS.forEach(function (g) {
      var group = el("div", "qp-group");
      var label = el("p", "qp-label", g[1]);
      label.id = "qp-" + g[0];
      group.appendChild(label);
      var chips = el("div", "qp-chips");
      chips.setAttribute("role", "group");
      chips.setAttribute("aria-labelledby", label.id);
      g[2].forEach(function (opt) {
        var b = el("button", "qp-chip", opt);
        b.type = "button";
        b.setAttribute("aria-pressed", "false");
        b.addEventListener("click", function () {
          var on = v[g[0]] !== opt;
          v[g[0]] = on ? opt : "";
          Array.prototype.forEach.call(chips.children, function (c) {
            c.setAttribute("aria-pressed", String(on && c === b));
          });
          update();
          if (!picked) { picked = true; emit("hc:qp-pick"); }
        });
        chips.appendChild(b);
      });
      group.appendChild(chips);
      card.appendChild(group);
    });

    var actions = el("div", "qp-actions");
    var text = el("a", "button primary qp-text", "Text Me My Price");
    text.setAttribute("data-qp-text", "");

    function update() {
      text.href = "sms:" + PHONE + "?&body=" + encodeURIComponent(msg());
      text.setAttribute("data-filled", filled());
    }
    update();

    function input(type, name, placeholder, auto) {
      var i = el("input", "ph-no-capture");
      i.type = type;
      i.name = name;
      i.placeholder = placeholder;
      i.setAttribute("aria-label", placeholder);
      i.autocomplete = auto;
      return i;
    }

    var form = el("form", "qp-send");
    form.noValidate = true;
    var name = input("text", "Name", "Your name", "name");
    var phone = input("tel", "Phone", "Mobile number", "tel");
    var email = input("email", "Email", "Email", "email");
    phone.inputMode = "tel";
    var hint = el("p", "qp-hint", "A phone or an email is enough. We reply within 30 minutes, 9 AM–9 PM.");

    var consent = el("label", "qp-consent");
    var box = el("input");
    box.type = "checkbox";
    consent.appendChild(box);
    consent.appendChild(document.createTextNode(" I agree to the "));
    var privacy = el("a", null, "Privacy Policy");
    privacy.href = "/privacy/";
    var terms = el("a", null, "Terms");
    terms.href = "/terms/";
    consent.appendChild(privacy);
    consent.appendChild(document.createTextNode(" and "));
    consent.appendChild(terms);
    consent.appendChild(document.createTextNode("."));

    var send = el("button", "button primary", "Send Me My Price");
    send.type = "submit";
    var status = el("p", "qp-status");
    status.setAttribute("role", "status");
    var row = el("div", "qp-row");
    row.appendChild(phone);
    row.appendChild(email);
    [name, row, hint, consent, send, status].forEach(function (n) { form.appendChild(n); });

    function fail(message, field) {
      status.textContent = message;
      if (field) field.focus();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (send.disabled) return;
      var digits = phone.value.replace(/\D/g, "");
      var mail = email.value.trim();
      if (!name.value.trim()) return fail("Please add your name.", name);
      if (!digits && !mail) return fail("Please add a phone number or an email so we can send your price.", phone);
      if (digits && (digits.length < 10 || digits.length > 15)) return fail("Please check the phone number - it should have 10 digits.", phone);
      if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return fail("Please check the email address.", email);
      if (!box.checked) return fail("Please check the box agreeing to the Privacy Policy and Terms.", box);

      var data = {
        "Name": name.value,
        "Phone": phone.value,
        "Email": mail,
        "Service type": "turnover",
        "Message": msg() + " (sent from the price box on " + path + ")",
        "Acknowledgment": "Agreed to Privacy Policy and Terms",
        "Google click ID": typeof window.hcClickId === "function" ? window.hcClickId() : ""
      };
      if (v.beds) data["Bedrooms"] = v.beds;
      if (v.baths) data["Bathrooms"] = v.baths;
      if (v.city && v.city !== "Somewhere else") data["Address"] = v.city + ", AZ";

      send.disabled = true;
      send.textContent = "Sending…";
      status.textContent = "";
      fetch("/api/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok || !body.ok) throw new Error(body.error || "");
        });
      }).then(function () {
        var to = digits ? phone.value : mail;
        form.replaceWith(el("p", "qp-done", "Got it! We’ll send your price to " + to +
          " within 30 minutes (9 AM–9 PM)."));
        emit("hc:qp-sent", { filled: filled(), channel: digits ? "phone" : "email" });
      }).catch(function (err) {
        send.disabled = false;
        send.textContent = "Send Me My Price";
        fail((err.message || "That didn’t go through.") + " You can also call or text Mason at 480-800-7789.");
        emit("hc:qp-error");
      });
    });

    if (CAN_TEXT) {
      // Phones: one tap opens a ready-to-send text. The form stays folded
      // for anyone who would rather not text.
      actions.appendChild(text);
      var alt = el("button", "qp-alt", "Rather not text? Send it here instead");
      alt.type = "button";
      alt.setAttribute("aria-expanded", "false");
      form.hidden = true;
      alt.addEventListener("click", function () {
        form.hidden = false;
        alt.setAttribute("aria-expanded", "true");
        alt.hidden = true;
        name.focus();
      });
      actions.appendChild(alt);
    }
    actions.appendChild(form);
    card.appendChild(actions);

    mount.replaceChildren(card);
  })();

  // Homepage section chip bar: highlight the section currently in view.
  var jumpBar = document.querySelector(".jump-bar");
  if (jumpBar) {
    var track = jumpBar.querySelector(".jump-track");
    var chips = [];
    jumpBar.querySelectorAll("a[href^='#']").forEach(function (link) {
      var section = document.getElementById(link.getAttribute("href").slice(1));
      if (section) chips.push({ link: link, section: section });
    });

    var updateChips = function () {
      // Viewport-relative math: a section is "current" once its top passes
      // just below the stuck bar. (offsetTop is unreliable here — the page
      // transition on <main> makes it the offsetParent.)
      var line = jumpBar.getBoundingClientRect().bottom + 90;
      var active = null;
      chips.forEach(function (chip) {
        if (chip.section.getBoundingClientRect().top <= line) active = chip;
      });
      chips.forEach(function (chip) {
        var on = chip === active;
        chip.link.classList.toggle("on", on);
        if (on) {
          chip.link.setAttribute("aria-current", "true");
        } else {
          chip.link.removeAttribute("aria-current");
        }
      });
      if (active && track.scrollWidth > track.clientWidth) {
        var left = active.link.offsetLeft - track.offsetLeft;
        var right = left + active.link.offsetWidth;
        if (left < track.scrollLeft || right > track.scrollLeft + track.clientWidth) {
          track.scrollTo({ left: left - 24, behavior: "smooth" });
        }
      }
    };

    var ticking = false;
    window.addEventListener(
      "scroll",
      function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
          ticking = false;
          updateChips();
        });
      },
      { passive: true }
    );
    window.addEventListener("resize", updateChips, { passive: true });
    updateChips();
  }
})();
