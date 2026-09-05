/* Overlay: watch plays the shared night-watch log. Falls back to the canned demo. */
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

  var previous = window.watch;
  window.watch = async function watch() {
    if (typeof demoing !== "undefined" && demoing) return;
    if (typeof demoing !== "undefined") demoing = true;
    if (typeof enter === "function") enter();
    if (typeof line === "function") line(">", "watch");
    var talk = await loadTalk();
    if (talk && typeof line === "function") {
      pane = "log";
      if (compose) compose.hidden = true;
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
      return;
    }
    if (typeof previous === "function") return previous();
    if (typeof demoing !== "undefined") demoing = false;
  };
})();
