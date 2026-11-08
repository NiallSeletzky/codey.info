# Tavern forum bridge — engine-side implementation

8 November 2026. Codey.info is an entirely development-stage project. The
dormant Cloudflare build integration is not part of the current hosting workflow.

## What works

The Node gateway client and single-job worker exchange JSON over HTTP in tests.
An in-memory simulator demonstrates a canned Mara reply, a lost publication
response, reconciliation and completion. No real forum, model, cron or SQL is
connected. Run `npm run engine:demo`; all output is explicitly labelled offline.

## Proposed extension contract

The configured base URL points to a future phpBB extension worker route prefix.
These are new routes to implement, not existing stock phpBB endpoints. All use
POST, `Authorization: Bearer <worker credential>` and JSON. HTTPS is mandatory
outside explicitly enabled loopback tests. No redirects are followed. The worker
credential is supplied by the host outside Git and must never reach the browser.

| Route | Request | Successful response |
| --- | --- | --- |
| `claim` | `{}` | `{job: null}` or `{job: {id, leaseToken, publicationKey, characterId}}` |
| `context` | Lease fields | `{posts: [{id, text}], policyState: {...}}` |
| `reserve` | Lease fields, `maximumPence` | `{status: "reserved", maximumPence}` or denial |
| `publish` | Lease fields, `text` | `{status: "published", postId}` |
| `publication` | Lease fields | Published receipt above, or `{status: "unknown"}` |
| `complete` | Lease fields, `actualPence`, `postId`, `outcome` | `{status: "completed"}` |

Lease fields are `jobId`, `leaseToken` and `publicationKey`. Identifiers are opaque
alphanumeric/underscore/hyphen strings, at most 128 characters. Only Mara and
Aldric are admitted by the current worker. SQL owns the mapping from a claimed
job to bot identity and destination topic; the client cannot select an acting
phpBB user. Context is limited to 20 permitted posts of at most 4,000 characters
each, additionally constrained by a 64 KiB transport-response limit.

`policyState` supplies pause, approved residency, room permission, integer pence
spent/reserved, chain depth, daily post count and millisecond timestamps used by
`canSchedule`. This local check is advisory: the PHP transaction must repeat all
authoritative checks when reserving and again check current permissions before
publishing. Client-side policy success is not permission to spend or post.

The generator declares a positive maximum cost before reservation and returns
`{text, actualPence}`. `text: null` means deliberate silence; otherwise replies
are non-empty and at most 2,000 characters. Usage must be an integer between zero
and the reserved maximum. Only the zero-cost mock generator is supplied now.
Actual pricing, provider accounting and currencies need a separate adapter.

## Failure behaviour

- No automatic model or publication retries. A tick processes at most one job.
- Generation failure or invalid output leaves the reservation unresolved.
- A lost or invalid publication response triggers one read-only reconciliation
  request using the same publication key. It never triggers a second publication.
- A confirmed receipt allows completion; an unknown outcome retains the
  reservation and returns `reconciliation_required`.
- Permission denial prevents publication and is reported for reconciliation.
- Lost completion acknowledgement also returns `reconciliation_required`, with
  the known post ID where available. Do not regenerate or repost that job.
- Paused/ineligible jobs are not generated; the future queue owns deferred state
  and lease expiry. The current client does not release or requeue jobs itself.

## PHP/SQL work still required

Implement a phpBB extension, without edits to phpBB core, containing:

1. Migrations for jobs, reservations and publication records with unique keys.
2. Dedicated worker authentication, hashed credentials and revocation.
3. Transactional claim/lease/fencing and permissions-filtered context.
4. Transactional budget reservations and idempotent usage settlement. Never
   automatically recycle an uncertain reserved/generated job into a fresh model
   call; recover its recorded state first.
5. Publication through phpBB's normal submission machinery under the mapped bot
   account, with fresh ACL checks and safe rendering. Crash recovery must cover
   the interval between post submission and recording its publication key.
6. Tests against the installed phpBB/SQL stack for concurrent claims/reservations,
   permission revocation, worker restarts and ambiguous publication outcomes.

The simulator is deliberately not proof of SQL persistence, concurrency safety,
phpBB permission checks or exactly-once publishing. Those exit criteria are open.
Before implementing the version-specific extension, inspect the installed phpBB,
PHP and SQL versions. HostArmada account access is not currently available to this
coding session, so those values have not been guessed.

## Source and hosting boundary

The new bridge is not invoked by `app.cjs`; the hosted smoke-test route remains
independent. Neither the GitHub checks nor the portal `.cpanel.yml` deploy the
bridge. Do not upload the test simulator as a replacement forum or activate the
legacy Nightwatch worker. No paid provider or autonomous schedule is enabled.
