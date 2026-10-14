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
  (function () {
    var KEY = "hc_gclid";
    var MAX_AGE_MS = 90 * 864e5;

    try {
      var q = new URLSearchParams(location.search);
      var kinds = ["gclid", "wbraid", "gbraid"];
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

  // Contact card: after a short delay, a small corner card invites the visitor
  // to text us about a free walkthrough. Non-blocking by design - no overlay,
  // no scroll lock, the page stays fully usable. Shown once per visitor
  // (remembered 30 days); never on the request page, where they are already
  // filling out the form.
  (function () {
    var KEY = "hc_cp_seen";
    var DELAY_MS = 12000;
    var REMEMBER_DAYS = 30;
    var PHONE = "4808007789";

    // The card follows the page it appears on. A homeowner reading about house
    // cleaning is not handing over a key to a rental, and rental copy on that
    // page reads as though we mistook what they came for.
    var RESIDENTIAL = location.pathname.indexOf("/services/house-cleaning") === 0;

    var COPY = RESIDENTIAL ? {
      title: "Free Walkthrough, Exact Price",
      body: "Before anything is booked, meet the two people who will actually be in your home. We walk it with you, then give you one flat price - locked before we start, no charge, no obligation.",
      msg: "Hi! I saw your site - I’d like a free walkthrough and a flat quote for house cleaning.",
      label: "Free house cleaning walkthrough offer"
    } : {
      title: "Free Walkthrough of Your Rental",
      body: "Before you hand over a key, meet the two people who’ll be in your property. We’ll walk it with you, learn how you like it set up, and answer anything — no charge, no obligation.",
      msg: "Hi! I saw your site - I’d like to hear more about a free walkthrough for my rental.",
      label: "Free walkthrough offer"
    };

    if (location.pathname.indexOf("/request-service") === 0) return;

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

      card.appendChild(el("p", "cp-kicker", "Let’s Meet First"));
      card.appendChild(el("h2", null, COPY.title));
      card.appendChild(el("p", null, COPY.body));

      var actions = el("div", "cp-actions");
      var text = el("a", "button primary", "Text Us to Set It Up");
      text.href = "sms:" + PHONE + "?&body=" + encodeURIComponent(COPY.msg);
      text.addEventListener("click", function () { setTimeout(close, 120); });
      actions.appendChild(text);

      var later = el("button", "cp-later", "No thanks, just browsing");
      later.type = "button";
      later.onclick = close;
      actions.appendChild(later);

      card.appendChild(actions);
      document.body.appendChild(card);
      document.addEventListener("keydown", onKey);
    }

    setTimeout(open, DELAY_MS);
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
