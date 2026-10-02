# Migration backup gate

How StellarCore gates high-risk production migrations on recent, verified
backup evidence (#188). The gate runs in the protected **Deploy production
migrations** workflow before `npx prisma migrate deploy` and fails closed:
without valid, recent, correctly bound evidence, a high-risk migration does
not run.

- Configuration manifest: [`constants/migrationBackupGate.ts`](../constants/migrationBackupGate.ts)
- Decision logic: [`lib/migrations/`](../lib/migrations/)
- CLI: `npm run migration:gate` ([`scripts/migration-backup-gate.ts`](../scripts/migration-backup-gate.ts))
- Evidence records: [`backup-evidence/`](../backup-evidence/)
- CI: `.github/workflows/audit-migration-backup-gate.yml`

Out of scope by design: the gate does not take or verify backups itself
(see the backup runbook [`docs/backup-and-restore.md`](backup-and-restore.md)
and the restore-drill work in #170). It verifies *evidence records* about
backups, and it never writes to any database.

## Decision flow

```
1. Override channel
   - any override variable set? all three must be present and valid,
     otherwise BLOCK (FAIL_OVERRIDE_INCOMPLETE) — partial never counts
   - fully valid override? ALLOW with the emergency audit banner
     (PASS_EMERGENCY_OVERRIDE), regardless of steps below
2. Intended target environment declared (STELLARCORE_ENVIRONMENT)? else BLOCK
3. Target database readable (applied migrations, identity)? else BLOCK
4. Pending = committed migrations − applied migrations (read-only)
   - none pending → ALLOW (PASS_NOTHING_PENDING)
   - all low-risk  → ALLOW (PASS_LOW_RISK)   ← low-risk never blocked
5. High-risk pending → the backup gate:
   a. database identity: current_database() + environment stamp (#143)
      must verify and match the intended environment, else BLOCK
   b. backup-evidence/<environment>.json must exist, parse, and evaluate:
      recent, drill passed, bound to this environment and database, else BLOCK
   c. all checks pass → ALLOW (PASS_EVIDENCE_VALID)
```

Every failure path returns a stable code, a bounded secret-free detail
string, and printable audit lines. The CLI exits nonzero whenever the gate
does not allow.

## Risk classification (deterministic scale)

Classification is a pure function of the committed SQL text — no clock, no
database, no randomness. Before matching, line comments, block comments,
single-quoted literals, and dollar-quoted bodies are stripped, so a
commented-out `DROP TABLE`, a string containing SQL text, and permission
statements such as `REVOKE … TRUNCATE` never inflate a score.

Each factor below is **presence-based**: it contributes its weight at most
once per migration. The migration's score is the sum of matched weights,
and `score >= 50` is **high-risk**.

| Factor | Weight | Trigger (comment/literal-stripped SQL) |
| --- | ---: | --- |
| `TABLE_DROP` | 100 | `DROP TABLE` |
| `TABLE_TRUNCATE` | 100 | `TRUNCATE` statement |
| `ROW_DELETE` | 90 | `DELETE FROM` |
| `COLUMN_DROP` | 80 | `DROP COLUMN` |
| `COLUMN_TYPE_CHANGE` | 70 | `ALTER COLUMN … TYPE`, `SET DATA TYPE` |
| `OBJECT_RENAME` | 60 | `RENAME TO / COLUMN / CONSTRAINT` |
| `CONSTRAINT_DROP` | 60 | `DROP CONSTRAINT` |
| `ROW_UPDATE` | 60 | `UPDATE … SET` (bulk data transformation) |
| `NOT_NULL_ENFORCE` | 50 | `SET NOT NULL` |
| `INDEX_DROP` | 40 | `DROP INDEX` |
| `DEFAULT_CHANGE` | 20 | `SET DEFAULT`, `DROP DEFAULT` |
| `UNIQUE_CONSTRAINT_ADD` | 15 | `CREATE UNIQUE INDEX`, `ADD CONSTRAINT … UNIQUE` |

Notes:

- Additive schema extensions — `CREATE TABLE`, `ADD COLUMN`, `CREATE INDEX`,
  foreign-key additions, `CHECK` constraints, permission changes — match no
  factor and are never blocked. The current committed chain classifies all
  low-risk (asserted in `tests/unit/migrations/riskClassification.test.ts`).
- Individual low factors can sum past the threshold (for example
  `DROP INDEX` + `DROP DEFAULT` = 60): cumulative structural change is
  treated as high-risk by design.
- The weights and threshold live only in
  `constants/migrationBackupGate.ts` and changing them changes this table in
  the same pull request.

## Backup evidence records

Evidence is a small JSON file committed at `backup-evidence/<environment>.json`
(for example `backup-evidence/production.json`), produced after a backup and
restore drill. The full schema, example, and rules are in
[`backup-evidence/README.md`](../backup-evidence/README.md). Summary:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `target.environment` | Database environment id the evidence is bound to (`production`, …). |
| `target.databaseName` | Non-secret `current_database()` name of the backed-up instance. |
| `backup.backupId`, `backup.takenAt` | Identifier and UTC timestamp of the backup. |
| `backup.method`, `backup.scope` | How the backup was taken (`pg_dump`-style method, `full`/`schema`). |
| `restoreDrill.result` | `passed` or `failed`. |
| `restoreDrill.completedAt` | UTC timestamp the drill finished. |
| `restoreDrill.durationSeconds`, `restoreDrill.checks` | Optional drill metadata; any `failed` check blocks. |
| `recordedBy` | Who/what recorded the evidence. |

Verification at gate time (checks run in this fixed order, so the reported
code is deterministic):

1. Schema: closed/strict — unknown fields, wrong types, non-ISO timestamps
   are rejected (`EVIDENCE_SCHEMA_INVALID`, `EVIDENCE_TIMESTAMP_INVALID`).
2. Data minimization: any credential/secret/hash-shaped **key** (password,
   token, connection string, checksum, …) is rejected
   (`EVIDENCE_FORBIDDEN_FIELD`); any value containing connection material
   (`postgres://…`, `user@host`, `password=…`, PEM headers) or longer than
   512 characters is rejected (`EVIDENCE_SECRET_VALUE`). Evidence files can
   therefore never carry credentials, connection strings, hashes, or
   database contents.
3. Clock: timestamps beyond the allowed future skew (5 min) are rejected
   (`EVIDENCE_TIMESTAMP_FUTURE`).
4. Target binding: `target.environment` must equal the workflow's declared
   environment, and `target.databaseName` must equal `current_database()` of
   the database being migrated; the durable environment stamp (#143) must
   also match. Mismatches are rejected (`EVIDENCE_TARGET_ENVIRONMENT_MISMATCH`,
   `EVIDENCE_TARGET_DATABASE_MISMATCH`, `FAIL_DATABASE_STAMP_MISMATCH`).
5. Drill: `result` must be `passed`, every entry in `checks` must be
   `passed`, and the drill must not predate its backup.
6. Freshness: both `backup.takenAt` and `restoreDrill.completedAt` must be
   no older than **7 days** at gate time (`EVIDENCE_BACKUP_STALE`,
   `EVIDENCE_DRILL_STALE`).

Fail-closed codes also include `EVIDENCE_MISSING` (no file),
`EVIDENCE_UNREADABLE` (invalid JSON), `FAIL_DATABASE_READ` (target
unreadable — note `prisma migrate deploy` would fail on the same database
anyway), `FAIL_DATABASE_IDENTITY_UNVERIFIED` (no stamp, e.g. a brand-new
database), and `FAIL_TARGET_ENVIRONMENT_MISSING`.

## Emergency override

The override is never the default: the workflow inputs default to
`none`/empty, empty values count as *absent*, and a partial override (any of
the three variables set but invalid) **blocks** with
`FAIL_OVERRIDE_INCOMPLETE` rather than falling through.

To override deliberately, a maintainer dispatches **Deploy production
migrations** with:

| Input / variable | Requirement |
| --- | --- |
| `backup_gate_override` / `STELLARCORE_BACKUP_GATE_OVERRIDE` | `emergency` — sets the exact token `emergency-acknowledge-unverified-backup`. |
| `backup_gate_override_reason` / `…_REASON` | At least 12 characters of justification. |
| `backup_gate_override_review` / `…_REVIEW` | A review reference containing an issue/PR number, e.g. `#188` or `PR #314`. |

When used, the gate prints this banner directly into the deployment log —
the audit record for the run:

```
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!! STELLARCORE MIGRATION BACKUP GATE — EMERGENCY OVERRIDE ACTIVE
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!! This migration is proceeding WITHOUT verified backup evidence.
!! bypassed check : EVIDENCE_MISSING
!! reason         : <the supplied reason>
!! review         : #188
!! evaluated at   : 2026-10-02T12:00:00.000Z
!! This block is the audit record and is printed to the deployment log.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
decision: ALLOW code=PASS_EMERGENCY_OVERRIDE (explicit emergency override)
```

The banner includes the exact check that was bypassed, and the run's JSON
summary reports `override: "active"` and `bypassedCode` for machine
consumers.

## Commands

```bash
# Offline dry-run: classify the committed migration chain (no DB, no secrets)
npm run migration:gate -- --classify-only

# Full gate (requires DATABASE_URL and STELLARCORE_ENVIRONMENT; exits 1 on BLOCK)
npm run migration:gate

# Unit + integration coverage: valid, stale, missing, mismatched target,
# unreadable, secret-bearing evidence, override, fail-closed DB reads
npm test -- tests/unit/migrations
npx tsx --test tests/integration/migrations/gateDatabase.integration.test.ts
```

## Relationship to other issues

- **#170 (restore drills):** drills produce the evidence this gate verifies;
  the gate consumes metadata only and never performs restores.
- **#139 (migration compatibility):** expand-contract compatibility is
  orthogonal; this gate answers "is there verified recovery proof before we
  change structure", not "can old and new revisions coexist".
- **#143 (environment identity):** the gate reuses the durable
  `database_environment` stamp so evidence cannot be replayed against a
  differently-labeled database.
