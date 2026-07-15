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

  // Legacy anchors from the old single-page site -> their new homes.
  if (location.pathname === "/") {
    var moved = {
      "#request": "/request-service/",
      "#checklist": "/services/vacation-rental-turnover-cleaning/#checklist"
    };
    var dest = moved[location.hash];
    if (dest) location.replace(dest);
  }

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
