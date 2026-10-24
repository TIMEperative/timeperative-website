// Colour scheme: Dark, Light or System (NAV-007). Dark is the default
// (owner, 2026-10-19): nothing stored means dark, so System is stored as
// such. The inline script at the top of every page applies the choice before
// the first paint; this file wires the header button, which shows the current
// scheme and cycles Dark, Light, System, and follows the OS while the choice
// is System.
(function () {
  var KEY = "ty-scheme";
  var CYCLE = ["dark", "light", "system"];
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

  function stored() {
    var s = null;
    try { s = localStorage.getItem(KEY); } catch (e) { /* storage blocked: the default */ }
    return s === "light" || s === "system" ? s : "dark";
  }

  function apply(choice) {
    var light = choice === "light" || (choice === "system" && media && media.matches);
    root.setAttribute("data-bs-theme", light ? "light" : "dark");
    root.setAttribute("data-scheme", choice);
    var button = document.querySelector("[data-scheme-cycle]");
    if (button) {
      var names = {};
      try { names = JSON.parse(button.getAttribute("data-names")); } catch (e) { /* the label keeps its name */ }
      button.setAttribute("aria-label", button.getAttribute("data-label") + ": " + (names[choice] || choice));
    }
  }

  function choose(choice) {
    try {
      if (choice === "dark") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch (e) { /* the choice lasts for this page only */ }
    apply(choice);
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-scheme-cycle]");
    if (button) choose(CYCLE[(CYCLE.indexOf(stored()) + 1) % CYCLE.length]);
  });
  if (media && media.addEventListener) media.addEventListener("change", function () { if (stored() === "system") apply("system"); });
  window.addEventListener("storage", function (event) { if (event.key === KEY) apply(stored()); });
  apply(stored());
})();

// The language menu and the nav groups: one open at a time; each closes on
// Escape and on a click outside it.
(function () {
  var menus = document.querySelectorAll(".lang-menu, .nav-menu");
  if (!menus.length) return;
  Array.prototype.forEach.call(menus, function (menu) {
    menu.addEventListener("toggle", function () {
      if (!menu.open) return;
      Array.prototype.forEach.call(menus, function (other) { if (other !== menu) other.open = false; });
    });
  });
  document.addEventListener("click", function (event) {
    Array.prototype.forEach.call(menus, function (menu) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    Array.prototype.forEach.call(menus, function (menu) {
      if (!menu.open) return;
      menu.open = false;
      menu.querySelector("summary").focus();
    });
  });
})();

// macOS and iOS: the button opens its waitlist under the row and closes the
// other one; a second click closes it. Without script the button is a link
// to the panel, which shows as the target.
(function () {
  var toggles = document.querySelectorAll("[data-waitlist-toggle]");
  function set(toggle, open) {
    var panel = document.getElementById(toggle.getAttribute("aria-controls"));
    toggle.setAttribute("aria-expanded", String(open));
    if (panel) panel.classList.toggle("is-open", open);
    return panel;
  }
  for (var i = 0; i < toggles.length; i++) {
    toggles[i].addEventListener("click", function (event) {
      event.preventDefault();
      var toggle = event.currentTarget;
      var open = toggle.getAttribute("aria-expanded") !== "true";
      for (var j = 0; j < toggles.length; j++) set(toggles[j], false);
      var panel = set(toggle, open);
      if (open && panel) { var input = panel.querySelector("input[type=email]"); if (input) input.focus({ preventScroll: true }); }
    });
  }
})();

// Waitlist for macOS and iOS: sends the form without leaving the page and
// says what happened under the button. Without script the form posts itself,
// and the Worker brings the visitor back to the same message.
(function () {
  var forms = document.querySelectorAll(".waitlist-form");
  for (var i = 0; i < forms.length; i++) {
    forms[i].addEventListener("submit", function (event) {
      var form = event.currentTarget;
      var status = form.querySelector(".waitlist-status");
      var button = form.querySelector("button[type=submit]");
      if (!window.fetch || !window.URLSearchParams) return;
      event.preventDefault();
      button.disabled = true;
      status.textContent = "";
      fetch(form.action, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString()
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false }; });
      }).then(function (result) {
        status.textContent = result.ok ? form.dataset.ok : result.error === "invalid" ? form.dataset.invalid : form.dataset.error;
        if (result.ok) form.reset();
      }).catch(function () {
        status.textContent = form.dataset.error;
      }).then(function () {
        button.disabled = false;
      });
    });
  }
})();
