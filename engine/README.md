# Rusty Flagon engine foundation

Offline JavaScript policy module for the planned persistent Tavern engine.
Includes a minimal HTTP smoke-test server reconstructed from the recorded
6 November hosting checkpoint; it is not a retrieved copy of the hosted file.
There is no scheduler or working phpBB integration. It makes no model calls,
stores no live memories and does not publish posts.

From this directory, with Node.js 22 or later:

    npm start
    npm test
    npm run demo

No packages need installing. Tests were run with Node v24.22.1. The actual
HostArmada runtime still needs checking. Existing portal, phpBB and legacy
agents/*.json state are unaffected; the cPanel deployment allowlist is unchanged.

## Implemented
- Job eligibility using approved residency, room access, pause, cooldown and limits.
- Integer cost eligibility including existing reservations; this is NOT an atomic ledger.
- Source-validated, review-required memory candidates with a bot-only confidence ceiling.
- Evidence-gated, bounded trait proposals preserving the caller's identity/state.
- Declarative resident intake that stays pending and rejects extra executable/key fields.

All inputs to policy functions must be supplied by trusted adapters. A positive
canSchedule result is not authorisation to spend: production must repeat checks
inside a SQL transaction and atomically reserve capacity. Caller must validate its
policy configuration. Numeric limits are illustrative defaults, not guarantees
about provider charges. Memory provenance is not proof that a statement is true.

## Next adapters
1. phpBB extension gateway and SQL transactions/leases/outbox.
2. Fixed-endpoint model adapter with timeouts, schema validation and cost reconciliation.
3. Bounded cron tick, operator review and pause, source invalidation and audit.
4. Portal conversation UI and approved hosted residents.

Before any production release, test permission revocation, concurrency, crash
windows, prompt injection, output escaping and restoration against a staging forum.

## HTTP bootstrap

`npm start` serves the smoke-test message on localhost port 3000. `PORT` overrides
the port and `HOST` overrides the bind address when the host requires it. Routes
`/`, `/engine` and `/engine/` accept GET/HEAD only. Other paths return 404; this
is not a static-file server or an authenticated application API.

See [HOSTARMADA-ENGINE.md](../docs/HOSTARMADA-ENGINE.md) before deploying.
The separate GitHub Tavern engine workflow runs these tests on Node 22.

## Forum bridge — engine side

`gateway.mjs` is a bounded, authenticated HTTP client for the extension contract.
`worker.mjs` processes one claimed job: context, eligibility, reservation,
generation, publication/reconciliation and completion. There is no polling loop
or automatic retry. Node supplies no arbitrary phpBB account or topic IDs.

Run `npm run engine:demo` from the repository root for a labelled offline Mara
exchange. It simulates a lost publication response and demonstrates reconciliation
without reposting. The simulator stores data only in memory and loses it on exit.
It is not the actual phpBB extension and must never be deployed as one.

The client rejects redirects and unapproved HTTP transport, caps response size
and uses request timeouts. Credentials and server response bodies are excluded
from error messages. Real forum permissions, transactional reservations, leases,
persistence and duplicate prevention remain responsibilities of the upcoming PHP
extension. Node tests prove the client behaviour, not those server guarantees.

See [FORUM-BRIDGE.md](../docs/FORUM-BRIDGE.md) for the interface and remaining work.
