import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_EVIDENCE_MAX_AGE_MS,
  BACKUP_EVIDENCE_SCHEMA_VERSION,
} from "@/constants/migrationBackupGate";
import {
  evaluateBackupEvidence,
  parseBackupEvidence,
} from "@/lib/migrations/backupEvidence";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

type RawEvidence = Record<string, unknown>;

type ValidRaw = {
  schemaVersion: number;
  target: RawEvidence;
  backup: RawEvidence;
  restoreDrill: RawEvidence;
  recordedBy: string;
};

function validRaw(
  overrides: {
    schemaVersion?: number;
    target?: RawEvidence;
    backup?: RawEvidence;
    restoreDrill?: RawEvidence;
    recordedBy?: string;
    extra?: RawEvidence;
  } = {},
): ValidRaw {
  return {
    schemaVersion: overrides.schemaVersion ?? BACKUP_EVIDENCE_SCHEMA_VERSION,
    target: {
      environment: "production",
      databaseName: "stellarcore",
      ...overrides.target,
    },
    backup: {
      backupId: "stellarcore-20261001-0200",
      takenAt: "2026-10-01T02:00:00.000Z",
      method: "pg_dump --format=custom",
      scope: "full",
      ...overrides.backup,
    },
    restoreDrill: {
      result: "passed",
      completedAt: "2026-10-01T03:10:00.000Z",
      durationSeconds: 110,
      checks: {
        migrationState: "passed",
        rowCounts: "passed",
        applicationReads: "passed",
      },
      ...overrides.restoreDrill,
    },
    recordedBy: overrides.recordedBy ?? "restore-drill-run",
    ...overrides.extra,
  };
}

function parseOk(raw: unknown) {
  const parsed = parseBackupEvidence(JSON.parse(JSON.stringify(raw)));
  assert.equal(parsed.ok, true, `expected parse success, got ${JSON.stringify(parsed)}`);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.evidence;
}

type EvalContext = Partial<{
  now: number;
  intendedEnvironment: "production" | "preview" | "test";
  actualDatabaseName: string;
  maxAgeMs: number;
  maxFutureSkewMs: number;
}>;

function evalResult(raw: RawEvidence, context: EvalContext = {}) {
  const evidence = parseOk(raw);
  return evaluateBackupEvidence(evidence, {
    now: NOW,
    intendedEnvironment: "production",
    actualDatabaseName: "stellarcore",
    ...context,
  });
}

test("valid, fresh, correctly bound evidence passes", () => {
  const result = evalResult(validRaw());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.backupAgeMs > 0);
  assert.ok(result.drillAgeMs > 0);
  assert.ok(result.backupAgeMs < BACKUP_EVIDENCE_MAX_AGE_MS);
});

test("evidence with every field at the exact freshness boundary passes", () => {
  const boundary = new Date(NOW - BACKUP_EVIDENCE_MAX_AGE_MS).toISOString();
  const result = evalResult(
    validRaw({
      backup: { ...validRaw().backup, takenAt: boundary },
      restoreDrill: { ...validRaw().restoreDrill, completedAt: boundary },
    }),
  );
  assert.equal(result.ok, true);
});

test("backup one millisecond past the freshness window is rejected as stale", () => {
  const past = new Date(NOW - BACKUP_EVIDENCE_MAX_AGE_MS - 1).toISOString();
  const result = evalResult(
    validRaw({
      backup: { ...validRaw().backup, takenAt: past },
      restoreDrill: { ...validRaw().restoreDrill, completedAt: past },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_BACKUP_STALE");
});

test("failed restore drill is rejected", () => {
  const result = evalResult(
    validRaw({
      restoreDrill: { ...validRaw().restoreDrill, result: "failed" },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_DRILL_NOT_PASSED");
});

test("a single failed drill check is rejected", () => {
  const result = evalResult(
    validRaw({
      restoreDrill: {
        ...validRaw().restoreDrill,
        checks: {
          migrationState: "passed",
          rowCounts: "failed",
          applicationReads: "passed",
        },
      },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_DRILL_CHECK_FAILED");
});

test("evidence bound to another environment is rejected", () => {
  const result = evalResult(validRaw({ target: { environment: "preview" } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_TARGET_ENVIRONMENT_MISMATCH");
});

test("evidence bound to another database name is rejected", () => {
  const result = evalResult(
    validRaw({ target: { databaseName: "stellarcore_preview" } }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_TARGET_DATABASE_MISMATCH");
});

test("timestamps in the future beyond the clock-skew tolerance are rejected", () => {
  const future = new Date(NOW + 60 * 60 * 1000).toISOString();
  const result = evalResult(
    validRaw({
      backup: { ...validRaw().backup, takenAt: future },
      restoreDrill: { ...validRaw().restoreDrill, completedAt: future },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_TIMESTAMP_FUTURE");
});

test("a drill that predates its backup is rejected", () => {
  const result = evalResult(
    validRaw({
      restoreDrill: {
        ...validRaw().restoreDrill,
        completedAt: "2026-09-30T03:10:00.000Z",
      },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_DRILL_BEFORE_BACKUP");
});

test("evaluation injects the intended target, not the evidence's claim", () => {
  const result = evalResult(validRaw(), {
    intendedEnvironment: "preview",
    actualDatabaseName: "stellarcore",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_TARGET_ENVIRONMENT_MISMATCH");
});

test("unknown top-level fields are rejected", () => {
  const parsed = parseBackupEvidence(validRaw({ extra: { operatorNotes: "hi" } }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_SCHEMA_INVALID");
});

test("unknown nested fields are rejected", () => {
  const parsed = parseBackupEvidence(
    validRaw({ backup: { ...validRaw().backup, retentionDays: 30 } }),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_SCHEMA_INVALID");
});

test("wrong schema version is rejected", () => {
  const parsed = parseBackupEvidence(validRaw({ schemaVersion: 99 }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_SCHEMA_INVALID");
});

test("missing required fields are rejected", () => {
  const raw: RawEvidence = JSON.parse(JSON.stringify(validRaw()));
  delete raw.recordedBy;
  const parsed = parseBackupEvidence(raw);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_SCHEMA_INVALID");
});

test("credential-shaped fields are rejected as forbidden", () => {
  const parsed = parseBackupEvidence(validRaw({ extra: { password: "hunter2" } }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_FORBIDDEN_FIELD");
});

test("hash-like fields are rejected as forbidden", () => {
  const parsed = parseBackupEvidence(
    validRaw({ extra: { backupChecksum: "abc123" } }),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_FORBIDDEN_FIELD");
});

test("connection strings in values are rejected as secrets", () => {
  const parsed = parseBackupEvidence(
    validRaw({
      backup: {
        ...validRaw().backup,
        method: "postgresql://stellarcore:pw@db.internal:5432/stellarcore",
      },
    }),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_SECRET_VALUE");
});

test("oversized string values are rejected", () => {
  const parsed = parseBackupEvidence(
    validRaw({ backup: { ...validRaw().backup, method: "x".repeat(600) } }),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_SCHEMA_INVALID");
});

test("non-ISO timestamps are rejected", () => {
  const parsed = parseBackupEvidence(
    validRaw({
      backup: { ...validRaw().backup, takenAt: "October 1, 2026" },
    }),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "EVIDENCE_TIMESTAMP_INVALID");
});

test("custom freshness limits are honored", () => {
  const result = evalResult(validRaw(), { maxAgeMs: 1_000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EVIDENCE_BACKUP_STALE");
});

test("evaluation is deterministic for identical inputs", () => {
  const first = evalResult(validRaw());
  const second = evalResult(validRaw());
  assert.deepEqual(first, second);
});
