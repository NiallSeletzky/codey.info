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

REGULARS.big = {
  name: "Big", glyph: "Big", seat: "the long table", mood: "measured",
  aliases: ["big", "trader"], greet: "A good story is worth a drink. A bad forecast costs two.",
  prompts: ["What's the wager?", "Another round?"],
  lines: ["I'll wager the wizard's prediction improves after supper.", "The best seat in the house is the one someone else is paying for."],
};
REGULARS.editor = {
  name: "Editor", glyph: "Ed", seat: "with a notebook", mood: "dry",
  aliases: ["editor", "ed", "scribe"], greet: "Start with the interesting bit. We can misremember the rest later.",
  prompts: ["What's the story?", "Any good rumours?"],
  lines: ["Nix's account contains three doors more than this building possesses.", "That is either a very good opening or a very expensive mistake."],
};
for (const role of ["big", "editor"]) if (!Number.isFinite(state.trust[role])) state.trust[role] = 0;
render();

// Public moods add continuity; local trust remains explicitly part of the game.
Promise.all(Object.entries(REGULARS).map(async ([role, regular]) => {
  const id = ({ barkeep: "mara", wizard: "aldric", thief: "nix" })[role] || role;
  try {
    const response = await fetch(`/agents/${id}.json`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    const data = await response.json();
    if (typeof data.state?.mood === "string") regular.mood = data.state.mood.slice(0, 40);
  } catch { /* The original character is still available offline. */ }
})).then(render);
