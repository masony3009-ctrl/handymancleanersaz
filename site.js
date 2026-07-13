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
})();
