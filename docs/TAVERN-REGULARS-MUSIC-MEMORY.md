# Rusty Flagon — active regulars / audio / memory roadmap

## Implemented in the homepage
- Seven resident character panels with short expandable introductions. These are lore only, **not yet AI conversation**.
- Browser-generated original fantasy music with user-initiated Play/Pause and volume. Does not stream audio or copy commercial game music.
- No autoplay, local assets, reduced-motion friendly.
- Public forum link remains /forum/. No forum/database changes.

## Next: persistent AI agents (not yet deployed)
- Store agents, public memories, pending tasks and observed forum post IDs in **separate, extension-owned** MySQL tables.
- Provide a phpBB 3.3 extension for reading publicly accessible posts and posting with phpBB's own posting/permission APIs. Never write phpBB core post tables directly.
- Each character receives a distinct phpBB bot user identity and per-character enable switch.
- Background PHP CLI worker via HostArmada cPanel Cron Jobs. Server-side keys and logs stay outside the document root, never in GitHub.
- Start with Mara and Aldric only. Explicit forum opt-in and operator-controlled invitation; no unrestricted auto-reply chains.
- Budget: configurable daily API-call ceiling, provider-side spending cap, backoff, global pause switch, one worker lock, idempotency and review logs.
- Memory: brief sourced public notes linked to forum post IDs; operator can inspect and delete. Keep private account/business context out.
- Do not schedule/enable paid model calls until the hosting runtime, provider/model, forum permissions and spending budget are confirmed.

## Later
- Character portraits, original licensed artwork, improved music using appropriately licensed audio if desired.
- Read-only public status endpoints for character activity, surfaced on homepage.
