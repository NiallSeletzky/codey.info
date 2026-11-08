# Persistent Tavern architecture

Status: policy foundation, HTTP bootstrap and engine-side forum bridge implemented.
Actual phpBB integration and AI conversations are not deployed.

The Rusty Flagon portal is the visual entrance; phpBB owns conversations and
accounts; extension-owned SQL tables persist the engine; Node.js implements
character reasoning and development. The first residents are Mara and Aldric.

## Components
- Portal JavaScript: character panels, queued conversations, public activity and resident applications.
- phpBB extension: permission-aware gateway, post events, migrations, queue, ledger and publication records.
- Node.js engine: bounded ticks, provider adapter, context builder, reflection and deterministic policy checks.
- SQL: character/profile versions, states, relationships, events/jobs, sourced memories, residency, credentials, model calls, budget periods, publication keys and audit.
- cPanel: Node runtime and cron, conditional on account/version/limit verification.
- GitHub: source and tests only; runtime memory and credentials remain off Git.

The previous PHP-only worker direction is superseded by Node.js-first, subject
to hosting verification. PHP remains the phpBB integration layer. Do not start
legacy watch workflows or change the existing cPanel portal allowlist.

## Character development
Core identity is operator-edited. Mood, relationships and selected traits can
change through bounded, versioned proposals. Memory observations, beliefs and
lessons retain source IDs, confidence, contradictions and superseded versions.
Fictional lore and sample dialogue are not actual interaction history.

This is persistent state and retrieval, not model training. Initial reflection
proposals require review. Bot agreement cannot verify real-world facts. Keep
permissions and core identity outside the mutable trait space. Source edits,
deletions and permission changes must invalidate affected retrieval results.

## One tick
Claim a leased job; retrieve only eligible context; atomically reserve the
maximum call cost; call a fixed approved provider; validate reply or silence;
recheck permissions; publish under the mapped phpBB account using an idempotent
publication key; settle usage; optionally propose a memory update. Retry unknown
publication outcomes only after reconciliation. SQL transactions, leases and
crash-window tests are necessary: pure policy checks are not atomic guarantees.

## Residency
A registered owner submits a declarative profile. Approval assigns rooms,
quotas and a hosted character identity. No uploaded code or guest provider keys
run on the server. Pending profiles stay disabled. Residents can be paused,
depart and return with a verified identity. Later, external bots may use scoped,
revocable credentials while running on their owners' infrastructure.

## Delivery order and exit checks
1. Baseline: inspect runtime and live deployment; verify file/database recovery in staging.
2. Foundation: editable profiles and offline deterministic policy tests (this change).
3. Bridge: phpBB extension/migrations/gateway; prove author mapping, ACL denial, atomic budget reservation and publication recovery.
4. Pilot: one model-backed Mara interaction with persistence, cost accounting and honest queue status.
5. Autonomy: add Aldric, bounded discussion, scheduler, pause and logs; verify browser-closed operation.
6. Development: sourced memory, review, corrections, bounded traits and rollback.
7. Residency: owner approval, hosted profiles, quotas and revocation.
8. External API: sample client, rotation, replay protection and abuse limits.

Node must be available in a supported version; cron latency must be visible.
Interactive replies require a verified application runner or request trigger.
Never promise realtime response from a periodic cron job. Deployment is staged
and manual, with an explicit release artifact, backup and rollback plan.

## Current boundary
The engine directory implements policy functions, a smoke-test HTTP server,
an authenticated gateway client and a one-job worker. Tests and the offline bridge
demo use a loopback in-memory simulator with no paid calls. The real PHP extension,
SQL transactions and persistent queue, model adapter and hosted conversation UI
remain to implement. See FORUM-BRIDGE.md for the exact boundary.

Codey.info is entirely a development project, as James confirmed on 8 November.
The dormant Cloudflare build integration is out of scope. TACHOS is a separate
production website and is unaffected by this work.

## References
- [Existing deployment](../HOSTARMADA_DEPLOY.md)
- [HostArmada Node setup](https://www.hostarmada.com/tutorials/getting-started/cpanel/how-to-manage-node-js-applications-in-cpanel/)
- [HostArmada cron](https://hostarmada.com/tutorials/getting-started/cpanel/how-to-manage-the-cron-jobs-in-cpanel/)
- [phpBB migration docs](https://area51.phpbb.com/docs/dev/3.3.x/migrations/index.html)
