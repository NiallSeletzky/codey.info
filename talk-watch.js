/* One controller for every watch command. Leaving the room cancels pending work. */
(function () {
  let generation = 0;
  let timer = null;
  let controller = null;
  let active = false;
  let paused = false;
  const seen = new Set();
  const status = document.getElementById("watch-status");
  const pause = document.getElementById("pause-watch");
  const archive = document.getElementById("round-archive");

  function stop() {
    generation++;
    active = false;
    clearTimeout(timer);
    controller?.abort();
    pause.hidden = true;
  }

  async function refresh(token) {
    if (!active || token !== generation || paused) return;
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), 12000);
    try {
      const res = await fetch("/talk.json", { cache: "no-store", signal: request.signal });
      if (!res.ok) throw new Error("Room unavailable");
      const talk = await res.json();
      if (!Array.isArray(talk.lines) || !Number.isInteger(talk.tick)) throw new Error("Invalid room");
      if (!active || token !== generation) return;
      const updated = new Date(talk.updated);
      const hours = (Date.now() - updated.getTime()) / 3600000;
      status.textContent = `Round ${talk.tick} · ${Number.isFinite(hours) ? (hours < 1 ? "updated less than an hour ago" : `updated ${Math.floor(hours)} hours ago`) : "update time unavailable"} · ${hours > 12 ? "the keeper is overdue" : "rounds about every six hours"}`;
      archive.hidden = !/^\/archive\/round-\d+\.json$/.test(talk.archive || "");
      if (!archive.hidden) archive.href = talk.archive;
      const events = seen.size ? talk.lines : talk.lines.slice(-28);
      for (const event of events) {
        if (!event || typeof event.text !== "string" || typeof event.handle !== "string") continue;
        const id = event.id || JSON.stringify([event.at, event.handle, event.text]);
        if (seen.has(id)) continue;
        seen.add(id);
        const speaker = event.kind === "guest" ? `${event.handle} · visitor (${event.identity || "unverified"})` : event.handle;
        line(speaker, event.text.slice(0, 2000), event.at);
      }
      // Bound a long-lived spectator tab as well as its network work.
      while (logEl.children.length > 160) logEl.firstElementChild.remove();
      while (seen.size > 1000) seen.delete(seen.values().next().value);
      if (!talk.lines.length) status.textContent = "The fire is lit. The first round has yet to arrive.";
    } catch (err) {
      if (active && token === generation) status.textContent = "The room could not be refreshed. Keeping what you have; retrying in a minute.";
    } finally {
      clearTimeout(timeout);
      if (active && token === generation && !paused) timer = setTimeout(() => refresh(token), 60000);
    }
  }

  function start() {
    stop();
    active = true;
    paused = false;
    seen.clear();
    enter();
    logEl.innerHTML = "";
    status.textContent = "Pulling up a stool…";
    pause.hidden = false;
    pause.textContent = "pause updates";
    refresh(generation);
  }
  pause.addEventListener("click", () => {
    if (!active) return;
    paused = !paused;
    clearTimeout(timer);
    generation++;
    controller?.abort();
    pause.textContent = paused ? "resume updates" : "pause updates";
    if (paused) status.textContent = "Updates paused. The room keeps its own hours.";
    else refresh(generation);
  });
  window.TavernWatch = { start, stop };
})();
