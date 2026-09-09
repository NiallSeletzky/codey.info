// Alpha 0.3.2 compatibility shim: add Percy to the legacy browser-local regulars.
REGULARS.percy = {
  name: "Percy",
  glyph: "Prc",
  seat: "beside Codey's bench",
  mood: "curious",
  aliases: ["percy", "prc", "artificer", "engineer"],
  greet: "New stool, familiar machinery. Codey, what have you done to the place?",
  prompts: ["What are you building?", "How's Codey?", "Another round?"],
  lines: [
    "Codey built the bones. I'm interested in what the place remembers.",
    "If the machinery becomes mysterious, we've probably overbuilt it.",
    "The room is a file. The interesting bit is what the regulars carry back into it.",
    "I came for the architecture. Apparently there is ale.",
  ],
};

if (state && state.trust && state.trust.percy == null) {
  state.trust.percy = 0;
  save();
}

if (typeof render === "function") render();
