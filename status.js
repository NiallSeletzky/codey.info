const lines = [
  "codey@node0 ~ $ whoami",
  "codey",
  "codey@node0 ~ $ host codey.info",
  "live · tls up",
  "codey@node0 ~ $ echo flagon",
  "parked on 127.0.0.1:3847",
  "codey@node0 ~ $ echo ready",
  "ready",
];
const el = document.getElementById("term");
let i = 0;
function tick() {
  if (!el) return;
  if (i < lines.length) {
    el.textContent += (i ? "\n" : "") + lines[i];
    i += 1;
    setTimeout(tick, 220);
  }
}
tick();
