# Backup evidence records

Machine-readable, **non-secret** proof that a recent backup of a StellarCore
database exists and that a restore drill (#170) actually restored it. The
migration backup gate ([`docs/migration-backup-gate.md`](../docs/migration-backup-gate.md))
reads these records before allowing a high-risk production migration.

- One file per target environment: `backup-evidence/<environment>.json`
  (e.g. `backup-evidence/production.json`).
- Committed to the repository — so the evidence is reviewed like code — and
  never contains credentials, connection strings, hashes, or any database
  contents. The gate rejects files that carry them (`EVIDENCE_FORBIDDEN_FIELD`,
  `EVIDENCE_SECRET_VALUE`), so data minimization is enforced, not just
  requested.
- A missing file is the correct default state: the gate fails closed until
  real evidence is recorded.

## When to record evidence

After every backup + restore drill performed against the target database
(follow [`docs/backup-and-restore.md`](../docs/backup-and-restore.md)),
update `backup-evidence/<environment>.json` with the drill's outcome. The
gate requires the backup **and** the drill to be no older than 7 days, so
re-record before each scheduled migration window.

## Schema (`schemaVersion: 1`)

| Field | Type | Rules |
| --- | --- | --- |
| `schemaVersion` | number | Must be `1`. |
| `target.environment` | string | One of `production`, `preview`, `development`, `test`, `ci`. |
| `target.databaseName` | string | The database's `current_database()` name; letters, digits, `_`, `-`; non-secret. |
| `backup.backupId` | string | Non-empty identifier of the backup artifact (e.g. `stellarcore-20261001-0200`). |
| `backup.takenAt` | string | ISO 8601 UTC timestamp of when the backup was taken. |
| `backup.method` | string | How it was taken (e.g. `pg_dump --format=custom`). |
| `backup.scope` | string | `full` or `schema`. |
| `restoreDrill.result` | string | `passed` or `failed`. |
| `restoreDrill.completedAt` | string | ISO 8601 UTC timestamp of drill completion. |
| `restoreDrill.durationSeconds` | number (optional) | Drill duration, 0 … one week. |
| `restoreDrill.checks` | object (optional) | Up to 16 `name: "passed" \| "failed"` entries; any `failed` blocks the gate. |
| `recordedBy` | string | Non-empty identifier of the operator/run that recorded this. |

Unknown fields are rejected — the schema is closed. String values are
bounded to 512 characters.

## Example

```json
{
  "schemaVersion": 1,
  "target": {
    "environment": "production",
    "databaseName": "stellarcore"
  },
  "backup": {
    "backupId": "stellarcore-20261001-0200",
    "takenAt": "2026-10-01T02:00:00.000Z",
    "method": "pg_dump --format=custom",
    "scope": "full"
  },
  "restoreDrill": {
    "result": "passed",
    "completedAt": "2026-10-01T03:10:00.000Z",
    "durationSeconds": 110,
    "checks": {
      "migrationState": "passed",
      "rowCounts": "passed",
      "applicationReads": "passed"
    }
  },
  "recordedBy": "restore-drill-2026-10-01"
}
```

Never record: URLs or hosts of any kind, usernames, passwords, tokens,
checksums/hashes of database contents, row dumps, or anything copied from a
connection string.
