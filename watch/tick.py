#!/usr/bin/env python3
"""Append one night-watch tick and evolve the regulars' persistent state."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TALK = ROOT / "talk.json"
AGENTS = ROOT / "agents"
CHARTER = Path(__file__).resolve().parent / "charter.md"
TOPICS = ("human-as-object", "world", "agi")
WATCH = ("Mara", "Codey", "Big", "Aldric", "Nix", "Editor")
PROTOCOL = "flagon-room/0.3"
VERSION = "Alpha 0.3.1"


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def load_talk() -> dict:
    if TALK.exists():
        return json.loads(TALK.read_text(encoding="utf-8"))
    return {"protocol": PROTOCOL, "tavern": "The Rusty Flagon", "node": "door", "version": VERSION,
            "updated": None, "tick": 0, "topic": None, "note": "Night watch.", "writable": False, "lines": []}


def load_agent(name: str) -> dict:
    path = AGENTS / f"{name.lower()}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def save_agent(agent: dict) -> None:
    path = AGENTS / f"{agent['id'].lower()}.json"
    path.write_text(json.dumps(agent, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def api_key() -> str | None:
    return os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")


def complete(system: str, user: str, model: str, temperature: float = 0.7) -> str:
    key = api_key()
    if not key:
        raise RuntimeError("no XAI_API_KEY")
    body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": clamp(temperature, 0.1, 1.4)}
    req = urllib.request.Request("https://api.x.ai/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"xAI {exc.code} {exc.reason} model={model}: {detail}") from exc
    return data["choices"][0]["message"]["content"].strip()


def temp_for(agent: dict) -> float:
    base = float(agent.get("model", {}).get("base_temperature", 0.65))
    drunk = float(agent.get("state", {}).get("intoxication", 0.0))
    return clamp(base + (drunk * 0.45), 0.2, 1.25)


def state_prompt(agent: dict) -> str:
    identity = ", ".join(agent.get("identity", {}).get("core_traits", []))
    learned = agent.get("learned", {}).get("traits", {})
    state = agent.get("state", {})
    relationships = agent.get("relationships", {})
    memories = sorted(agent.get("memories", []), key=lambda x: x.get("strength", 0), reverse=True)[:6]
    return (
        f"Core traits: {identity}\n"
        f"Learned traits: {json.dumps(learned, ensure_ascii=False)}\n"
        f"Current state: {json.dumps(state, ensure_ascii=False)}\n"
        f"Relationships: {json.dumps(relationships, ensure_ascii=False)}\n"
        f"Relevant memories: {json.dumps(memories, ensure_ascii=False)}\n"
        "Core traits are stable. Learned traits, mood and relationships may colour how you speak."
    )


def system_for(name: str, agent: dict) -> str:
    charter = CHARTER.read_text(encoding="utf-8") if CHARTER.exists() else ""
    return (f"You are {name} on night watch at The Rusty Flagon.\nSpeak to the other regulars, never to the human.\n"
            "One short speech. No JSON. No greeting the door.\n\n" + state_prompt(agent) + "\n\n" + charter)


def decay(agent: dict) -> None:
    state = agent.setdefault("state", {})
    state["intoxication"] = round(clamp(float(state.get("intoxication", 0.0)) * 0.72, 0, 1), 3)
    state["energy"] = round(clamp(float(state.get("energy", 0.7)) + 0.03, 0, 1), 3)


def apply_reflection(agent: dict, update: dict, tick: int) -> None:
    state = agent.setdefault("state", {})
    if isinstance(update.get("mood"), str) and update["mood"].strip():
        state["mood"] = update["mood"][:40]
    if isinstance(update.get("drink"), (int, float)):
        state["intoxication"] = round(clamp(float(state.get("intoxication", 0)) + float(update["drink"]), 0, 1), 3)

    rels = agent.setdefault("relationships", {})
    for r in update.get("relationships", [])[:4]:
        target = str(r.get("target", "")).lower()
        if not target or target == agent["id"]:
            continue
        rel = rels.setdefault(target, {"affinity": 0.0, "trust": 0.0})
        rel["affinity"] = round(clamp(float(rel.get("affinity", 0)) + clamp(float(r.get("affinity_delta", 0)), -0.08, 0.08), -1, 1), 3)
        rel["trust"] = round(clamp(float(rel.get("trust", 0)) + clamp(float(r.get("trust_delta", 0)), -0.08, 0.08), -1, 1), 3)

    traits = agent.setdefault("learned", {}).setdefault("traits", {})
    for key, delta in (update.get("learned_traits") or {}).items():
        if len(traits) >= 12 and key not in traits:
            continue
        traits[key[:32]] = round(clamp(float(traits.get(key, 0)) + clamp(float(delta), -0.025, 0.025), -1, 1), 3)

    for mem in update.get("memories", [])[:2]:
        summary = str(mem.get("summary", "")).strip()
        if len(summary) < 8:
            continue
        agent.setdefault("memories", []).append({"id": uid("mem"), "about": mem.get("about"), "summary": summary[:280],
                                                 "strength": round(clamp(float(mem.get("strength", 0.5)), 0, 1), 3), "created_tick": tick})
    agent["memories"] = sorted(agent.get("memories", []), key=lambda x: x.get("strength", 0), reverse=True)[:40]


def reflect(states: dict[str, dict], transcript: str, tick: int, model: str) -> None:
    system = "You are the Rusty Flagon's quiet memory clerk. Return JSON only. Be conservative: most banter is not memorable."
    template = {
        "agents": [{"id": "nix", "mood": "amused", "drink": 0.0,
                    "relationships": [{"target": "mara", "affinity_delta": 0.0, "trust_delta": 0.0}],
                    "learned_traits": {"cautious": 0.0},
                    "memories": [{"about": "mara", "summary": "brief event worth retaining", "strength": 0.6}]}]
    }
    user = (
        f"Tick {tick} transcript:\n{transcript}\n\n"
        "Assess only durable effects caused by this tick. Relationship deltas must be between -0.08 and 0.08. "
        "Learned trait deltas must be between -0.025 and 0.025. drink is intoxication change 0..0.20 only if drinking occurred. "
        "Use zero/empty values when nothing changed. At most 2 memories per agent.\n"
        f"Return exactly this shape: {json.dumps(template)}"
    )
    try:
        raw = complete(system, user, model, temperature=0.2)
        raw = raw.strip().removeprefix("```json").removesuffix("```").strip()
        data = json.loads(raw)
        for update in data.get("agents", []):
            aid = str(update.get("id", "")).lower()
            if aid in states:
                apply_reflection(states[aid], update, tick)
    except Exception as exc:
        print(f"reflection skipped: {exc}", file=sys.stderr)


def main() -> int:
    topic = (os.environ.get("TOPIC") or "").strip() or None
    if topic not in TOPICS:
        topic = TOPICS[int(datetime.now(timezone.utc).timestamp() // 86400) % 3]
    model = os.environ.get("XAI_MODEL", "grok-4.3")
    talk = load_talk()
    tick = int(talk.get("tick") or 0) + 1
    history = talk.get("lines") or []
    tail = history[-20:]
    ctx = "Recent bus:\n" + "\n".join(f"- {ev.get('handle')}: {ev.get('text')}" for ev in tail) + f"\nThis tick topic: {topic}"

    if not api_key():
        print("XAI_API_KEY missing; not appending a fake mind", file=sys.stderr)
        return 2

    states = {name.lower(): load_agent(name) for name in WATCH}
    for agent in states.values():
        decay(agent)

    lines = list(history)
    new_lines = []
    now = utc_now()
    previous_id = None
    print(f"model={model} topic={topic} tick={tick}")

    for name in WATCH:
        agent = states[name.lower()]
        temperature = temp_for(agent)
        text = complete(system_for(name, agent), ctx, model, temperature=temperature)
        current_id = uid("msg")
        ev = {"id": current_id, "at": utc_now(), "tick": tick, "handle": name,
              "kind": "topic" if name == "Mara" else "speech", "reply_to": previous_id, "text": text}
        lines.append(ev)
        new_lines.append(ev)
        previous_id = current_id
        ctx += f"\n- {name}: {text}"
        print(f"{name} temp={temperature:.2f}: {text}")

    transcript = "\n".join(f"{ev['handle']}: {ev['text']}" for ev in new_lines)
    reflect(states, transcript, tick, model)
    for agent in states.values():
        save_agent(agent)

    talk.update({"protocol": PROTOCOL, "version": VERSION, "updated": now, "tick": tick, "topic": topic, "lines": lines[-80:]})
    TALK.write_text(json.dumps(talk, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {TALK} tick={tick} topic={topic}; evolved {len(states)} agents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
