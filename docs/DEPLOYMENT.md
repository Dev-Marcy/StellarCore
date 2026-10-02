# Production deployment

StellarCore is prepared for a Vercel deployment backed by managed PostgreSQL and Prisma ORM. This guide prepares deployment only; it does not provision or modify hosted services.

## Architecture

- Next.js 15 App Router deploys as Vercel Node.js functions.
- Prisma Client uses the `PrismaPg` adapter with a server-only PostgreSQL connection supplied as `DATABASE_URL` for the running environment.
- Public API routes are read-only. The refresh route is a Node.js-only, authenticated internal mutation boundary.
- Vercel Cron invokes only `/api/internal/cron/refresh` on production deployments.

## Environment

| Name | Production | Secret | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Required | Yes | Server-only PostgreSQL connection appropriate to the running environment. The protected migration workflow separately configures its direct Prisma Postgres credential under this secret name. |
| `CRON_SECRET` | Required when cron is enabled | Yes | Bearer secret Vercel sends to the refresh route. |
| `STELLARCORE_ENVIRONMENT` | Set to `production` | No | Explicit runtime environment identity checked against the database's durable stamp before any evidence access (#143). On Vercel, `VERCEL_ENV` is used automatically when this is absent. |
| `STELLARCORE_STAMP_ENVIRONMENT` | Migration workflow only | No | Stamp target for `npm run stamp:environment`; names the identity written into the database's `database_environment` table. |

## Environment isolation (#143)

Every runtime declares which environment it runs in (`STELLARCORE_ENVIRONMENT`
or Vercel's `VERCEL_ENV`; `NODE_ENV=test` resolves to `test` in test runs), and
every database carries a durable identity stamp in its
`database_environment` table (created by migration
`20260929000000_add_database_environment`). Before the first evidence read or
write, the application verifies the two identities match and **fails closed**
on any mismatch, missing stamp, or missing runtime identity. There is no
fallback and no hostname inference: a preview deployment pointed at a
production-marked database cannot read or mutate a single evidence row, and
production cannot silently fall back to another environment.

Rules for operators:

- Stamp each database exactly once, immediately after its migrations, using
  the protected migration workflow (which runs `npm run stamp:environment`
  with `STELLARCORE_STAMP_ENVIRONMENT=production` after
  `prisma migrate deploy`). The stamp script is idempotent for the same
  identity and refuses to rewrite a different existing identity.
- Application runtimes hold read privilege on the stamp only; the migration
  revokes write access from `PUBLIC`, so a compromised runtime cannot re-label
  its database to make itself match.
- Allowed pairings are equality only: production→production, preview→preview,
  development→development, test→test, ci→ci. Test and CI runtimes additionally
  can never hold evidence data, regardless of stamp.
- Mismatch errors are bounded and secret-free: they name the two identities
  and never echo database URLs, credentials, or driver messages.

`DATABASE_URL` must be a `postgres://` or `postgresql://` URL. The application runtime uses the credential configured for its deployment environment. The protected GitHub Actions production environment separately stores the direct Prisma Postgres credential used by `prisma migrate deploy` under the same `DATABASE_URL` secret name. Do not expose either credential through `NEXT_PUBLIC_*`, repository files, or logs.

### Database TLS policy

Production PostgreSQL connections are forced through certificate-verified TLS
before the PrismaPg adapter is created. Keep TLS query parameters out of
`DATABASE_URL`; the application strips them before handing the connection
string to `pg` and supplies its own `ssl.rejectUnauthorized=true` policy.
Production rejects plaintext and verification-bypass URL modes.

Providers using public certificate roots require no extra setting. For private
or provider-specific roots, configure either server-only
`STELLARCORE_DB_CA` or `STELLARCORE_DB_CA_PATH`. A configured CA path that
cannot be read fails production startup rather than silently falling back.

The incident-only `STELLARCORE_DB_TLS_EMERGENCY_BYPASS=allow-unverified`
permits encrypted but unverified TLS, never plaintext. It is production-only,
emits a bounded warning without credentials or certificate material, and must
be removed after the incident. See
[database-tls-policy.md](database-tls-policy.md).


## Runtime configuration fingerprinting (#214)

Production releases bind the checked-in reviewed configuration and selected
non-secret runtime policy values to the source revision with a SHA-256
fingerprint. The fingerprint covers the reviewed anchor/corridor registries,
reviewed live-rate sources, runtime environment identity, rate freshness policy,
minimum fresh-source policy, and only boolean presence metadata for
`DATABASE_URL` and `CRON_SECRET`. Secret values themselves are never included
in fingerprint material or release artifacts.

`npm run release:manifest` records the fingerprint in
`stellarcore-provenance.json` alongside the exact commit, lockfile digest,
toolchain, and SBOM digest. The GitHub release workflow attests that provenance
with the existing OIDC-backed build attestation.

At application startup, `instrumentation.ts` recomputes the active fingerprint
from the validated runtime configuration and compares it with
`STELLARCORE_CONFIG_FINGERPRINT`. The deployment revision comes from
`STELLARCORE_DEPLOYMENT_REVISION`, then `VERCEL_GIT_COMMIT_SHA`, then
`GITHUB_SHA`.

Mismatch handling is controlled by `STELLARCORE_CONFIG_DRIFT_POLICY`:

- `fail`: reject startup on a mismatch; this is the production default. A
  production deployment using this policy also rejects a missing expected
  fingerprint.
- `degrade`: start with diagnostics marked degraded so operators can keep
  read-only service available while blocking or reviewing affected operational
  paths.
- `warn`: start and emit bounded diagnostics without marking degraded. This is
  the non-production default.

Intentional configuration changes require a new reviewed release fingerprint:
change the reviewed configuration or policy, generate the release provenance
for the intended commit, set the deployment's
`STELLARCORE_CONFIG_FINGERPRINT` to that attested value, and deploy the same
revision. Never copy a fingerprint between revisions.

Startup diagnostics expose only the fingerprint, revision, policy, and drift
state. They never emit database URLs, cron secrets, or other secret values.

The read-only rates, rate-history, and reputation APIs can serve verified public
snapshots for at most five minutes after a recognized transient database
connectivity failure. These responses carry explicit stale metadata and remain
`Cache-Control: no-store`. Snapshots preserve the evidence timestamps and are
not inputs to rate or reputation calculations. If the snapshot directory is
unavailable or a snapshot fails integrity, schema, provenance, or expiry checks,
the endpoint returns its normal safe 500 response. Recovery switches directly
back to PostgreSQL reads.

## Migration strategy

1. Configure the server-only runtime `DATABASE_URL` for the production deployment, and separately configure the protected GitHub Actions `production` environment's direct Prisma Postgres credential as its `DATABASE_URL` secret.
2. Before anything applies, run the backup gate (`npm run migration:gate`, #188): pending migrations are classified against the deterministic risk scale, and any high-risk migration requires recent, verified, correctly bound backup evidence (`backup-evidence/production.json`) or the fully explicit emergency override — see [docs/migration-backup-gate.md](migration-backup-gate.md).
3. From a protected CI/release step, run `npx prisma migrate deploy` once against that environment.
4. Stamp the database identity with `npm run stamp:environment` (automated by the migration workflow's dedicated step, #143).
5. Confirm `npx prisma migrate status` is current.
6. Deploy the application with `npm run build`.

Do not run `prisma migrate dev`, `prisma db push`, reset commands, or `migrate deploy` from ordinary Vercel builds. Keeping migrations outside the build prevents preview deployments from mutating a shared production database.

## Production migration workflow (GitHub Actions)

The protected step above is implemented as a manual GitHub Actions workflow:
`.github/workflows/deploy-production-migrations.yml`. It is triggered only by
`workflow_dispatch` and is intentionally separate from Vercel builds, so a
preview or an ordinary build can never mutate the production database. It runs
the **backup gate** (`npm run migration:gate`) and then exactly
`npx prisma migrate deploy` on `ubuntu-latest` with Node.js 22 after
`npm ci`, uses least-privilege `contents: read` permissions, a 10-minute job
timeout, and a non-cancelling `production-database-migration` concurrency group
so two migration runs can never overlap.

The backup gate fails closed (#188): if any pending migration classifies as
high-risk, the gate requires `backup-evidence/production.json` to prove a
backup and restore drill from the last 7 days bound to this environment and
database (`current_database()` plus the #143 environment stamp). Missing,
stale, unreadable, or wrong-target evidence blocks the run before
`prisma migrate deploy` starts. Low-risk additive migrations pass without
evidence. The gate only reads — classification is pure, evidence is a
committed JSON file, and its database session issues constant, parameter-free
SELECTs. Full design: [docs/migration-backup-gate.md](migration-backup-gate.md).

Emergency override: the workflow exposes three `backup_gate_override*`
inputs that default to `none`/empty, so the gate can never be bypassed by
default or by a partial setting. Overriding deliberately requires the exact
token (`emergency` input), a reason of at least 12 characters, and a review
reference such as `#188`; the gate then prints a loud audit banner — reason,
reference, and the exact check bypassed — into the deployment log. See the
[override procedure](migration-backup-gate.md#emergency-override).

The `production` environment's `DATABASE_URL` secret is supplied to the
dependency-installation, backup-gate, and migration steps. `npm ci` runs the
`postinstall` script (`prisma generate`), which loads `prisma.config.ts`, and
that configuration resolves `DATABASE_URL`; without the secret the install step
fails with `PrismaConfigEnvError: Cannot resolve environment variable:
DATABASE_URL` before any migration runs. The secret stays scoped to those
steps rather than the whole workflow, and is never printed.

One-time setup (repository admin):

1. Open the GitHub repository **Settings**.
2. Under **Environments**, create a GitHub Actions environment named
   `production`.
3. In that environment, add an environment secret named `DATABASE_URL`.
4. Set it to the **direct** PostgreSQL connection string suitable for Prisma
   Migrate (a `postgres://` / `postgresql://` URL, not a pooled/PgBouncer
   endpoint). Do not put this value in any repository file.
5. Optionally add **required reviewers** and other environment protection rules
   to `production` so a human must approve each migration run.

Running a migration:

6. Make sure `backup-evidence/production.json` reflects a backup and restore
   drill from the last 7 days (required only when a pending migration is
   high-risk; see [backup-evidence/README.md](../backup-evidence/README.md)).
7. Open the repository **Actions** tab.
8. Select the **Deploy production migrations** workflow.
9. Choose **Run workflow** on the intended branch, leave the backup-gate
   override inputs at their defaults unless an approved emergency applies,
   and confirm.
10. Confirm the **Verify migration backup gate** step succeeds (its log
    prints the per-migration risk scores and the decision).
11. Confirm the **prisma migrate deploy** step succeeds (the run log shows
    the applied migrations, or "No pending migrations to apply").
12. Only then continue to the **Bootstrap production registry** workflow
    (see below) and the application deployment described below.

The workflow never prints the secret and adds no environment-dumping debug
steps. `DATABASE_URL` is the only secret it consumes; it does not use the
Vercel CLI, Vercel tokens, `CRON_SECRET`, `POSTGRES_URL`, or
`PRISMA_DATABASE_URL`.

## Preview policy

Preview deployments must not receive the production `DATABASE_URL` or `CRON_SECRET`. Until isolated preview database infrastructure exists, omit database secrets from previews; database-backed routes will fail safely rather than target production.

## Bootstrap

After migrations, run the explicit, idempotent command once in the protected production job environment:

```bash
npm run bootstrap:registry
```

It uses the existing reviewed registries and synchronization logic to discover/upsert anchors, upsert corridors, and reconcile associations. It prints safe structured results and exits nonzero for failures. It is never called by a web request, build, or cron route.

## Production registry bootstrap workflow (GitHub Actions)

The bootstrap above is also implemented as a manual GitHub Actions workflow:
`.github/workflows/bootstrap-production-registry.yml`. It is triggered only by
`workflow_dispatch` and is intentionally separate from Vercel builds, preview
deployments, the migration workflow, and the scheduled refresh, so none of
those can mutate the production registry. It runs exactly
`npm run bootstrap:registry` on `ubuntu-latest` with Node.js 22 after `npm ci`,
uses least-privilege `contents: read` permissions, a 10-minute job timeout, and
a non-cancelling `production-registry-bootstrap` concurrency group so two
bootstrap runs can never overlap.

The bootstrap is manual and idempotent. It is normally required once for a
fresh production database, immediately after migrations and before the first
scheduled refresh. It may also be re-run deliberately after a reviewed change
to the anchor/corridor registry in the repository; re-running upserts the
current reviewed registry and reconciles associations without creating
duplicates. It creates no new anchors, infers no corridors, and never resets
data; it exits nonzero on any synchronization failure.

The `production` environment's `DATABASE_URL` secret is supplied to both the
dependency-installation step and the bootstrap step, for the same reason as the
migration workflow: `npm ci` runs `postinstall` (`prisma generate`), which
loads `prisma.config.ts`, and that configuration resolves `DATABASE_URL`;
without the secret the install step fails with `PrismaConfigEnvError` before
the bootstrap runs. The secret stays scoped to those two steps rather than the
whole workflow, and is never printed. `DATABASE_URL` is the only secret the
workflow consumes; it does not use the Vercel CLI, Vercel tokens, `CRON_SECRET`,
`POSTGRES_URL`, or `PRISMA_DATABASE_URL`.

Running the bootstrap:

1. Confirm the **Deploy production migrations** workflow has completed
   successfully and the `production` environment / `DATABASE_URL` secret are in
   place (they are shared with the migration workflow).
2. Open the repository **Actions** tab.
3. Select the **Bootstrap production registry** workflow.
4. Choose **Run workflow** on the intended branch and confirm.
5. Confirm the **Bootstrap registry** step succeeds; the run log prints a safe
   structured JSON summary of anchor and corridor synchronization. A nonzero
   exit means at least one entry failed to synchronize — resolve it and
   re-run.
6. Only then continue to the application deployment and scheduled refresh
   described below.

## Scheduler

### Cron secret rotation

For a planned zero-downtime rotation, deploy the application with the new
`CRON_SECRET`, the outgoing value in `CRON_SECRET_PREVIOUS`, and a UTC
`CRON_SECRET_ROTATION_UNTIL` deadline. During that bounded window either
secret authenticates. Cut the scheduler over to the new primary, verify it, and
then remove the previous/deadline variables. At the exact deadline the previous
secret is already revoked.

Misconfigured rotation fails closed: blank primary, duplicate primary/previous,
or an invalid previous-slot deadline returns 401. Removing the previous slot
revokes it on the next request. For a compromised primary, deploy a fresh
primary with no previous slot; for a compromised previous secret, remove both
rotation variables immediately. Secret values are never logged.


`vercel.json` schedules the single production-only refresh route once daily at `0 0 * * *` (midnight UTC), which is compatible with the Vercel Hobby plan. Vercel sends `CRON_SECRET` as a Bearer authorization header; the route uses constant-time validation, accepts GET only, returns bounded no-store JSON, and does not accept query-string credentials.

The locally verified run took about ten seconds. At the current reviewed scope of one rate source and three anchors, one Node.js function invocation is acceptable; this is a production observation, not an architectural limit. Add a distributed lock, chunking, or workers before the source/anchor set grows materially; Vercel does not retry failed cron invocations automatically.

## First production cycle

1. Apply committed migrations with the **Deploy production migrations**
   workflow (`.github/workflows/deploy-production-migrations.yml`); the
   backup gate runs first and fails closed without valid evidence when a
   pending migration is high-risk (#188).
2. Synchronize the reviewed registry with the **Bootstrap production registry**
   workflow (`.github/workflows/bootstrap-production-registry.yml`) and resolve
   any nonzero result.
3. Deploy or redeploy the Vercel application with `npm run build` as the build command.
4. Let the scheduled refresh ingest indicative rates, then evaluate the currently sparse reputation evidence. It does not ingest transfer outcomes.
5. Verify `GET /api/anchors`, `/api/corridors`, `/api/rates?corridor=usdc-us-brl-br`, `/api/reputation`, and `/api/reputation/zeam`.

## Release SBOM and provenance (#142)

Production releases carry a reproducible software-supply-chain record:

- `npm run release:manifest` emits `dist-release/stellarcore-sbom.json`
  (CycloneDX 1.5 SBOM of the locked **production** dependency graph) and
  `dist-release/stellarcore-provenance.json` (commit SHA, workflow run
  reference, invocation id, environment identity, Node/npm versions, the
  SHA-256 digest of the `package-lock.json` used for installation, and the
  deployment-bound runtime configuration fingerprint).
- `.github/workflows/deploy-production.yml` generates the manifest from the
  checked-out revision in CI (never handwritten), wraps both files in a
  verifiable attestation via `actions/attest-build-provenance` (OIDC-signed,
  `id-token: write` + `attestations: write`), verifies them with
  `npm run verify:release`, and uploads them with 90-day retention.
- `npm run verify:release` fails the release on: missing/malformed artifacts,
  lockfile digest drift, SBOM digest mismatch against provenance, or secret
  material (connection strings, bearer tokens, secret-shaped assignments)
  appearing in the artifacts. Verification failures are never ignored on
  release paths.
- Local verification: run `npm run release:manifest` then
  `npm run verify:release`; both are offline. Artifacts contain only paths,
  digests, versions, and identity strings — never environment secrets or
  database contents.

## Rollback

Redeploy the prior application artifact when needed. Database migration rollback is a separate, reviewed change: do not reset or reverse a production database ad hoc. Disable the Vercel cron before any planned database maintenance that would make refresh unsafe.


## Poison scheduled-input suppression (#234)

Scheduled live-rate sources that repeatedly fail with deterministic
normalization errors are tracked in the durable
`scheduled_source_suppressions` table. The policy is intentionally narrow:
only known normalization failures are eligible. Quote/network failures and
persistence failures remain transient and never advance permanent suppression.

A source is suppressed after **three consecutive eligible deterministic
failures**. Once suppressed, its reviewed anchor/corridor identity is removed
before live candidate preparation, so it consumes no discovery/quote network
capacity and cannot create a fresh observation. Public latest-rate aggregation
also excludes a suppressed source's previously persisted observation, so a
suppressed source cannot satisfy fresh-source or median requirements.

Suppression records contain only stable source identity, bounded failure
classification, timestamps, state, and reactivation audit metadata. They do
not store raw upstream payloads, credentials, or exception messages.

Reactivation is explicit. After the underlying reviewed configuration or
protocol mismatch has been corrected, an operator supplies a reviewed reason
and runs:

```bash
STELLARCORE_REACTIVATE_ANCHOR="anchor-slug" \
STELLARCORE_REACTIVATE_CORRIDOR="corridor-slug" \
STELLARCORE_REACTIVATE_REASON="Reviewed correction in PR #..." \
npm run suppression:reactivate
```

The command resets the suppression counter/state only. It never deletes,
rewrites, or fabricates evidence. The source is eligible for the next scheduled
run, where normal validation and quote handling apply again.
