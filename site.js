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
  // site sets no cookies and shows no cookie banner. Ninety days matches
  // Google's default attribution window; older ids are treated as expired.
  (function () {
    var KEY = "hc_gclid";
    var MAX_AGE_MS = 90 * 864e5;

    try {
      var q = new URLSearchParams(location.search);
      var id = q.get("gclid") || q.get("wbraid") || q.get("gbraid");
      if (id) {
        window.localStorage.setItem(KEY, JSON.stringify({ v: id.slice(0, 200), t: Date.now() }));
      }
    } catch (e) { /* private mode or no storage - attribution is best-effort */ }

    // Read back the stored click id, or "" when absent/expired/unreadable.
    window.hcClickId = function () {
      try {
        var raw = window.localStorage.getItem(KEY);
        if (!raw) return "";
        var o = JSON.parse(raw);
        if (!o || !o.v || !o.t) return "";
        if (Date.now() - o.t > MAX_AGE_MS) return "";
        return o.v;
      } catch (e) {
        return "";
      }
    };
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
    var MSG = "Hi! I saw your site - I’d like to hear more about a free walkthrough for my rental.";

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
      card.setAttribute("aria-label", "Free walkthrough offer");

      var x = el("button", "cp-close", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Dismiss");
      x.onclick = close;
      card.appendChild(x);

      card.appendChild(el("p", "cp-kicker", "Let’s Meet First"));
      card.appendChild(el("h2", null, "Free Walkthrough of Your Rental"));
      card.appendChild(el("p", null,
        "Before you hand over a key, meet the two people who’ll be in your property. We’ll walk it with you, learn how you like it set up, and answer anything — no charge, no obligation."));

      var actions = el("div", "cp-actions");
      var text = el("a", "button primary", "Text Us to Set It Up");
      text.href = "sms:" + PHONE + "?&body=" + encodeURIComponent(MSG);
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
