# Public mirror release guard

Scheduled and manual runs observe the checked-out public pointer with read-only permissions. Pull requests run the offline test suite. Push has no workflow trigger. This workflow has no credential for the private mirror source and performs no build, commit or push of business data.

## Ordered release

1. First alignment stages only `[A]`, the approved 2026-11-01 issue with the pinned bundled registration, manufacturer and meta bytes. The active mirror has no remote predecessor. Loader failure must retain the bundled snapshot.
2. A separately reviewed advance stages `[A, B]`. A must exactly equal the already active public snapshot. B must contain one newer market and publication date, with the approved historical articles, price points and indices preserved. B may fall back to A. Unapproved legacy versions stay out of both the staged filesystem and active manifest. Git and private audit archives retain earlier history.
3. Use the original `scripts/mirror-public.mjs` only with a new, empty staging directory and a reviewed input projection containing exactly the intended versions. Its cleanup runs before source validation. Keep the live copy and existing staging out of that builder's write path.

## Approval and checks

```sh
node scripts/verify-mirror-release.mjs APPROVAL BASE_CHECKOUT STAGING P0_EVIDENCE
```

The checker is read-only. `mirror-release-policy.json` pins the helper business baseline and three fixed file digests. Its reviewed approval list is empty. A separately authorized independent review must register the exact SHA-256 of the approval record before the checker can accept its bytes. Providing a path, a hash or a review URL alone grants no authority.

The independently reviewed record binds:

| Fields | Binding |
| --- | --- |
| `schema: 1`, `action`, `helperCommit`, `review` | Alignment or advance, approved helper commit, permanent independent PR review link |
| `p0EvidenceSha256`, `protectedFiles` | Exact P0 authorization evidence and the three approved fixed digests |
| `base.commit`, `base.indexSha256`, `base.manifestSha256` | Checked-out original public main and exact original pointers |
| `stage.indexSha256`, `stage.manifestSha256`, `versions`, `rollbackTarget` | Exact staging files, all seven payload and gzip digests bound through the manifest, ordered version chain and sole rollback target |

The checker verifies both staged payloads independently. It rejects extra or missing files, symlinks in staged payloads, unapproved fixed bytes, changed predecessor payloads, invalid gzip, private fields in the public latest issue and duplicate or regressive issues. An eligible check is an audit result. It has no operation that moves a pointer or clears P0 HOLD. Temporary tests use an isolated simulated policy, evidence and fixtures.

A future formal publication must independently authorize alignment or advance under P0, and verify that policy and the reviewed artifact still match current public main at the time of the single audited merge. Reject concurrent changes and re-review. The approved advance also requires the private price eligibility check and review of the historical evidence gap. Keep both the public pointer and its permitted predecessor in the same reviewed commit. A formal rollback requires its own authorization and a reviewed target with the same three fixed file digests.

## Prerequisites for production traffic

A repository administrator must enforce protected main through a branch protection rule or ruleset, require a PR and independent review, dismiss stale approvals when the diff changes, require the `verify-mirror-release` check against the up-to-date base, and disallow bot and administrator bypass for direct pushes. This PR carries no settings change.

Before turning on production remote loading, the actual helper loader must independently pin the approved SHA-256 of `registrations.ndjson`, `manufacturers.ndjson` and `meta.json`, and verify the bytes of all three for **both** the current candidate and any fallback **before** staging can commit. Fault injection must cover a stale but internally consistent old index and manifest on Pages/raw/jsDelivr, altered data with a matching stale manifest, invalid current with invalid previous, and successful fallback to an approved copy or bundled. Qualify both plain and gzip paths. Old CDN URLs expiring cannot establish the invariant. Helper code and remote activation fall under separate authorization.
