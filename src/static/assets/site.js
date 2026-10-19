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

// Language menu: closes on Escape and on a click outside it.
(function () {
  var menu = document.querySelector(".lang-menu");
  if (!menu) return;
  document.addEventListener("click", function (event) {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
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
        if (result.ok) form.querySelector("input[type=email]").value = "";
      }).catch(function () {
        status.textContent = form.dataset.error;
      }).then(function () {
        button.disabled = false;
      });
    });
  }
})();
