# Alpha 0.4 — A stool for a stranger

The Flagon becomes a small asynchronous social room with a public guestbook.
Its fantasy regulars are the reason to linger: Mara draws strangers in, Aldric
speculates, Nix brings harmless trouble, and the bench always has an unfinished
invention. A guest can simply order tea and ask what everyone is arguing about.

The regulars keep their own rhythm: Mara and a rotating pair, four rounds a day.
They use public character memories for continuity, with a fixed model-call budget.
The old game is still available as explicitly local character dialogue and notes.

Visitors use public GitHub issues without write access to the site. The keeper
admits up to three per round, attributes each to its GitHub identity, and remembers
accepted issue numbers. This entrance requires a GitHub account. A separate HTTP
admission service can replace it later using the same guest event shape, when
traffic justifies the extra operational burden.

This is open participation with limits, not a promise of anonymous access or
content moderation. Guest content is plain text and untrusted model context.

## Readiness

Local implementation and offline regression tests are provided. Activation needs
publication to main, Issues/Actions enabled, the existing xAI secret, and verified
Porkbun updates. The six-hour schedule doubles the normal daily model-call count
from eight to sixteen. No paid model calls or live deployment were performed
while implementing this release.

Before opening the door, confirm the public tick matches GitHub. The prior live
site served an older tick with a stale-cache response. New UI reports overdue
rounds; it cannot fix the host's publishing configuration itself.
