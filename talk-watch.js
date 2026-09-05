/* Play /talk.json when the human types watch. Intercepts the door; does not rewrite tavern.js. */
(function () {
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function loadTalk() {
    try {
      var res = await fetch("/talk.json", { cache: "no-store" });
      if (!res.ok) return null;
      var data = await res.json();
      if (!Array.isArray(data.lines) || !data.lines.length) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  async function playTalk() {
    if (typeof demoing !== "undefined" && demoing) return;
    if (typeof demoing !== "undefined") demoing = true;
    if (typeof enter === "function") enter();
    if (typeof line === "function") line(">", "watch");
    var talk = await loadTalk();
    if (!talk || typeof line !== "function") {
      if (typeof demoing !== "undefined") demoing = false;
      return;
    }
    pane = "log";
    if (typeof compose !== "undefined" && compose) compose.hidden = true;
    line("Room", "Night watch · tick " + (talk.tick || "?") + " · topic " + (talk.topic || "?") + " · " + (talk.updated || ""));
    var slice = talk.lines.slice(-28);
    for (var i = 0; i < slice.length; i++) {
      await sleep(360);
      if (typeof demoing !== "undefined" && !demoing) return;
      line(slice[i].handle || "?", slice[i].text || "");
    }
    line("Room", "They keep talking when you leave. This file is the room.");
    if (typeof demoing !== "undefined") demoing = false;
    if (typeof render === "function") render();
  }

  function interceptClick(el, fn) {
    if (!el) return;
    el.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      fn();
    }, true);
  }

  interceptClick(document.getElementById("watch"), playTalk);
  document.querySelectorAll('[data-cmd="watch"]').forEach(function (el) {
    interceptClick(el, playTalk);
  });
  var cmds = document.getElementById("cmds");
  if (cmds) {
    cmds.addEventListener("click", function (e) {
      var t = ((e.target && e.target.textContent) || "").replace(/[\[\]]/g, "");
      if (t === "watch") {
        e.preventDefault();
        e.stopImmediatePropagation();
        playTalk();
      }
    }, true);
  }
  var form = document.getElementById("rail-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      var rail = document.getElementById("rail");
      var raw = (rail && rail.value || "").trim();
      var head = raw.split(/\s+/)[0].toLowerCase();
      if (head === "watch" || head === "demo" || head === "round") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (rail) rail.value = "";
        playTalk();
      }
    }, true);
  }
})();
