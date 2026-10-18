// Colour scheme: System, Light or Dark (NAV-007). The inline script at the top
// of every page applies the stored choice before the first paint; this file
// wires the three buttons in the footer and follows the system while the
// choice is System.
(function () {
  var KEY = "ty-scheme";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function stored() {
    var s = null;
    try { s = localStorage.getItem(KEY); } catch (e) { /* storage blocked: System */ }
    return s === "light" || s === "dark" ? s : "system";
  }

  function apply(choice) {
    var dark = choice === "dark" || (choice === "system" && media && media.matches);
    root.setAttribute("data-bs-theme", dark ? "dark" : "light");
    root.setAttribute("data-scheme", choice);
    var buttons = document.querySelectorAll("[data-scheme-choice]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-scheme-choice") === choice));
    }
  }

  function choose(choice) {
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch (e) { /* the choice lasts for this page only */ }
    apply(choice);
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-scheme-choice]");
    if (button) choose(button.getAttribute("data-scheme-choice"));
  });
  if (media && media.addEventListener) media.addEventListener("change", function () { if (stored() === "system") apply("system"); });
  apply(stored());
})();
