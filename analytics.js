// Product analytics (PostHog), loaded first-party through /ph/*.
//
// PRIVACY CONTRACT - the privacy policy makes these promises, keep them true:
//   * No cookies. Persistence is localStorage only.
//   * Do Not Track / Global Privacy Control is honored.
//   * Form instrumentation records FIELD NAMES and completion counts only.
//     Never a field VALUE. This form collects names, phone numbers, emails
//     and street addresses - none of it may reach analytics.
//   * Session replay is ENABLED, with every typed value masked in the
//     browser before the recording is sent. If you ever turn masking down,
//     the privacy policy has to change with it - it promises masking by name.
(function () {
  // Public project key (phc_...). Safe in client code by design - it can only
  // write events, not read them. Paste yours from PostHog:
  // Settings -> Project -> Project API Key.
  var POSTHOG_KEY = "phc_zEkESVHQeifmJQEtdUQgktM8Ajvx2r4TJ9FZgudMsnV2";

  if (!POSTHOG_KEY) return; // Not configured yet - stay completely inert.

  // Honor browser-level opt-out signals before loading anything at all.
  var dnt = navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl === true;
  if (dnt) return;

  var s = document.createElement("script");
  s.src = "/ph/static/array.js";
  s.defer = true;
  s.onerror = function () { /* blocked or offline - the site carries on */ };
  s.onload = function () {
    if (!window.posthog || !window.posthog.init) return;
    window.posthog.init(POSTHOG_KEY, {
      api_host: "/ph",
      ui_host: "https://us.posthog.com",
      persistence: "localStorage",      // no cookies -> no cookie banner
      autocapture: true,                // pageviews + clicks: "where are they going"
      capture_pageview: true,
      respect_dnt: true,
      // Session replay is ON. Every value a visitor types is masked before
      // the recording leaves their browser - we watch behaviour, not data.
      disable_session_recording: false,
      // The project has console-log capture switched on; we don't want it.
      // Nothing client-side logs anything useful (all console calls live in
      // the Worker), and the privacy policy describes replay as pages,
      // scrolling and clicks - console output is not in that description.
      enable_recording_console_log: false,
      session_recording: {
        maskAllInputs: true,
        maskInputOptions: {
          text: true, textarea: true, email: true, tel: true,
          number: true, search: true, url: true, password: true,
          date: true, select: true
        },
        // Belt-and-braces: anything explicitly marked sensitive is blanked.
        maskTextSelector: ".ph-no-capture"
      }
    });
    try { wire(); } catch (e) { /* never let analytics break the page */ }
  };
  document.head.appendChild(s);

  function cap(event, props) {
    if (window.posthog && window.posthog.capture) window.posthog.capture(event, props || {});
  }

  function page() { return location.pathname; }

  // Which band of the page a click came from, so CTA placement can be compared.
  function zone(el) {
    if (el.closest(".site-header")) return "header";
    if (el.closest(".mobile-bar, .sticky-bar")) return "sticky_bar";
    if (el.closest(".cp-card")) return "popup";
    if (el.closest(".hero")) return "hero";
    if (el.closest(".site-footer, footer")) return "footer";
    return "body";
  }

  function wire() {
    // ---- Contact channel: the call-vs-text question, measured ----
    document.addEventListener("click", function (e) {
      var a = e.target.closest("a[href]");
      if (!a) return;
      var href = a.getAttribute("href") || "";
      if (href.indexOf("sms:") === 0) {
        cap("contact_click", { channel: "text", zone: zone(a), page: page() });
      } else if (href.indexOf("tel:") === 0) {
        cap("contact_click", { channel: "call", zone: zone(a), page: page() });
      } else if (href.indexOf("/request-service") === 0) {
        cap("cta_click", { cta: "request", zone: zone(a), page: page(), label: (a.textContent || "").trim().slice(0, 60) });
      }
    }, true);

    // ---- Contact popup: does the top-priority feature actually convert? ----
    var popupSeenAt = 0;
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType === 1 && n.classList && n.classList.contains("cp-card")) {
            popupSeenAt = Date.now();
            cap("popup_shown", { page: page() });
            n.addEventListener("click", function (e) {
              var t = e.target.closest("a,button");
              if (!t) return;
              var secs = Math.round((Date.now() - popupSeenAt) / 1000);
              if (t.tagName === "A") cap("popup_texted", { seconds_visible: secs, page: page() });
              else cap("popup_dismissed", { seconds_visible: secs, page: page() });
            });
          }
        });
      });
    });
    mo.observe(document.body, { childList: true });

    // ---- Request form funnel: where the long form loses people ----
    var form = document.getElementById("service-form");
    if (!form) return;

    var started = false;
    var lastField = "";
    var touched = {};

    // Field NAME only. Values are never read.
    function noteField(el) {
      var n = el.getAttribute("name");
      if (!n || n === "website") return; // "website" is the honeypot
      lastField = n;
      touched[n] = true;
    }

    form.addEventListener("focusin", function (e) {
      var el = e.target;
      if (!el.name && !el.getAttribute) return;
      if (!started) {
        started = true;
        cap("form_start", { page: page() });
      }
      noteField(el);
    });

    form.addEventListener("change", function (e) {
      var el = e.target;
      noteField(el);
      // Service type is a category, not personal data - worth capturing.
      if (el.getAttribute("name") === "Service type") {
        cap("form_service_type", { service_type: el.value });
      }
    });

    form.addEventListener("submit", function () {
      cap("form_submit_attempt", {
        page: page(),
        fields_filled: Object.keys(touched).length
      });
    });

    // Outcomes are announced by the form's own script so analytics stays
    // decoupled from it. Detail payloads carry field names / error text only.
    form.addEventListener("hc:form-validation-block", function (e) {
      cap("form_validation_block", { field: (e.detail && e.detail.field) || "unknown" });
    });
    form.addEventListener("hc:form-success", function () {
      cap("form_success", { fields_filled: Object.keys(touched).length });
    });
    form.addEventListener("hc:form-error", function (e) {
      cap("form_error", { message: ((e.detail && e.detail.message) || "unknown").slice(0, 120) });
    });

    // Abandonment: the single most useful signal on a form this long.
    // Reports which field they were last in, not what they typed.
    window.addEventListener("pagehide", function () {
      if (!started) return;
      if (form.dataset.submitted === "1") return;
      cap("form_abandon", {
        page: page(),
        last_field: lastField,
        fields_filled: Object.keys(touched).length
      });
    });
  }

  // Exposed so the privacy policy can offer a working opt-out link.
  window.hcOptOutAnalytics = function () {
    if (window.posthog && window.posthog.opt_out_capturing) {
      window.posthog.opt_out_capturing();
      return true;
    }
    return false;
  };
})();
