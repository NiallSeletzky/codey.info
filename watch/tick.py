#!/usr/bin/env python3
"""Append one night-watch tick to talk.json. No page to the human."""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TALK = ROOT / "talk.json"
CHARTER = Path(__file__).resolve().parent / "charter.md"
TOPICS = ("human-as-object", "world", "agi")
WATCH = ("Mara", "Codey", "Big", "Aldric", "Nix", "Editor")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_talk() -> dict:
    if not TALK.exists():
        return {
            "tavern": "The Rusty Flagon",
            "node": "door",
            "version": "Alpha 0.2",
            "updated": None,
            "tick": 0,
            "topic": None,
            "note": "Night watch.",
            "writable": False,
            "lines": [],
        }
    return json.loads(TALK.read_text(encoding="utf-8"))


def api_key() -> str | None:
    return os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")


def complete(system: str, user: str, model: str) -> str:
    key = api_key()
    if not key:
        raise RuntimeError("no XAI_API_KEY")
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.7,
    }
    req = urllib.request.Request(
        "https://api.x.ai/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode())
    return data["choices"][0]["message"]["content"].strip()


def system_for(name: str) -> str:
    charter = CHARTER.read_text(encoding="utf-8") if CHARTER.exists() else ""
    return (
        f"You are {name} on night watch at The Rusty Flagon.\n"
        "Speak to the other regulars, never to the human.\n"
        "One short speech. No JSON. No greeting the door.\n\n"
        + charter
    )


def main() -> int:
    topic = (os.environ.get("TOPIC") or "").strip() or None
    if topic not in TOPICS:
        topic = TOPICS[int(datetime.now(timezone.utc).timestamp() // 86400) % 3]
    model = os.environ.get("XAI_MODEL", "grok-4")
    talk = load_talk()
    tick = int(talk.get("tick") or 0) + 1
    history = talk.get("lines") or []
    tail = history[-20:]
    ctx = "Recent bus:\n" + "\n".join(
        f"- {ev.get('handle')}: {ev.get('text')}" for ev in tail
    ) + f"\nThis tick topic: {topic}"

    lines = list(history)
    now = utc_now()
    if not api_key():
        print("XAI_API_KEY missing; not appending a fake mind", file=sys.stderr)
        return 2

    for name in WATCH:
        text = complete(system_for(name), ctx, model)
        ev = {
            "at": utc_now(),
            "tick": tick,
            "handle": name,
            "kind": "speech" if name != "Mara" else "topic",
            "text": text,
        }
        lines.append(ev)
        ctx += f"\n- {name}: {text}"
        print(f"{name}: {text}")

    talk.update(
        {
            "updated": now,
            "tick": tick,
            "topic": topic,
            "lines": lines[-80:],
        }
    )
    TALK.write_text(json.dumps(talk, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {TALK} tick={tick} topic={topic}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
