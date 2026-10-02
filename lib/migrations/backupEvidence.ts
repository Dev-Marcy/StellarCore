/**
 * Backup-evidence schema and evaluation (#188).
 *
 * Evidence files are small, non-secret JSON records committed under
 * `backup-evidence/<environment>.json`. They prove that a recent backup of
 * the intended database exists and that a restore drill (#170) actually
 * restored it. This module is pure logic:
 *
 * - parseBackupEvidence() enforces a strict, closed schema and rejects any
 *   field or value that could carry a credential, connection string, hash,
 *   or other secret (data minimization).
 * - evaluateBackupEvidence() checks freshness, drill success, and target
 *   binding against the database the migration is about to touch.
 *
 * Every failure is a stable machine-readable code plus a bounded,
 * secret-free detail string. The evaluation never reads a clock by itself:
 * `now` is always an explicit input, so behavior is deterministic in tests.
 */

import {
  BACKUP_EVIDENCE_MAX_AGE_MS,
  BACKUP_EVIDENCE_MAX_FUTURE_SKEW_MS,
  BACKUP_EVIDENCE_SCHEMA_VERSION,
} from "@/constants/migrationBackupGate";
import {
  isDatabaseEnvironmentId,
  type DatabaseEnvironmentId,
} from "@/lib/config/environmentGuard";

export type EvidenceParseResult =
  | Readonly<{ ok: true; evidence: BackupEvidence }>
  | Readonly<{ ok: false; code: EvidenceFailureCode; detail: string }>;

export type EvidenceEvaluationResult =
  | Readonly<{
      ok: true;
      backupAgeMs: number;
      drillAgeMs: number;
    }>
  | Readonly<{ ok: false; code: EvidenceFailureCode; detail: string }>;

export type EvidenceFailureCode =
  | "EVIDENCE_UNREADABLE"
  | "EVIDENCE_SCHEMA_INVALID"
  | "EVIDENCE_FORBIDDEN_FIELD"
  | "EVIDENCE_SECRET_VALUE"
  | "EVIDENCE_TARGET_ENVIRONMENT_MISMATCH"
  | "EVIDENCE_TARGET_DATABASE_MISMATCH"
  | "EVIDENCE_DRILL_NOT_PASSED"
  | "EVIDENCE_DRILL_CHECK_FAILED"
  | "EVIDENCE_DRILL_BEFORE_BACKUP"
  | "EVIDENCE_TIMESTAMP_INVALID"
  | "EVIDENCE_TIMESTAMP_FUTURE"
  | "EVIDENCE_BACKUP_STALE"
  | "EVIDENCE_DRILL_STALE";

export type BackupEvidence = Readonly<{
  schemaVersion: typeof BACKUP_EVIDENCE_SCHEMA_VERSION;
  target: Readonly<{
    environment: DatabaseEnvironmentId;
    /** Non-secret logical name of the database instance (e.g. `stellarcore`). */
    databaseName: string;
  }>;
  backup: Readonly<{
    backupId: string;
    takenAt: string;
    method: string;
    scope: "full" | "schema";
  }>;
  restoreDrill: Readonly<{
    result: "passed" | "failed";
    completedAt: string;
    durationSeconds?: number;
    checks?: Readonly<Record<string, "passed" | "failed">>;
  }>;
  recordedBy: string;
}>;

export type EvidenceEvaluationContext = Readonly<{
  /** Evaluation instant (epoch ms); injected so tests are deterministic. */
  now: number;
  /** Environment the migration workflow declares as its intended target. */
  intendedEnvironment: DatabaseEnvironmentId;
  /** `current_database()` of the database the migration will touch. */
  actualDatabaseName: string;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
}>;

/** Longest accepted string value; evidence is metadata, not a data dump. */
const MAX_STRING_LENGTH = 512;
const MAX_CHECK_ENTRIES = 16;
const MAX_DEPTH = 6;

/** Keys that may never appear anywhere in an evidence document. */
const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "pgpass",
  "secret",
  "token",
  "credential",
  "connectionstring",
  "connstring",
  "connurl",
  "privatekey",
  "apikey",
  "accesskey",
  "hash",
  "checksum",
  "digest",
  "salt",
  "cookie",
  "authorization",
  "seed",
]);

/** Values that look like connection material are rejected on sight. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\//i,
  /:\/\/[^\s]*@[^\s]*/i,
  /\bpassword\s*[=:]/i,
  /-----BEGIN\b/,
]);

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const DATABASE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const IDENTIFIER_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,40}$/;

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "target",
  "backup",
  "restoreDrill",
  "recordedBy",
]);
const TARGET_KEYS = Object.freeze(["environment", "databaseName"]);
const BACKUP_KEYS = Object.freeze(["backupId", "takenAt", "method", "scope"]);
const DRILL_KEYS = Object.freeze([
  "result",
  "completedAt",
  "durationSeconds",
  "checks",
]);

function fail(
  code: EvidenceFailureCode,
  detail: string,
): Extract<EvidenceParseResult | EvidenceEvaluationResult, { ok: false }> {
  return Object.freeze({ ok: false, code, detail });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Data-minimization sweep over the raw document before schema validation:
 * any key that names a credential, connection detail, hash, or cookie — at
 * any depth — is rejected, and any string value that looks like connection
 * material or exceeds the metadata size bound is rejected.
 */
function scanForSecrets(raw: unknown, depth = 0): EvidenceParseResult | null {
  if (depth > MAX_DEPTH) {
    return fail("EVIDENCE_SCHEMA_INVALID", "evidence document nests too deeply");
  }
  if (Array.isArray(raw)) {
    for (const item of raw.slice(0, 64)) {
      const found = scanForSecrets(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(raw)) return null;

  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = key.toLowerCase();
    for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
      if (normalizedKey.includes(fragment)) {
        return fail(
          "EVIDENCE_FORBIDDEN_FIELD",
          `field "${truncate(key, 40)}" is forbidden: evidence must never carry credentials, connection details, hashes, or database contents`,
        );
      }
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) {
        return fail(
          "EVIDENCE_SCHEMA_INVALID",
          `field "${truncate(key, 40)}" exceeds ${MAX_STRING_LENGTH} characters`,
        );
      }
      for (const pattern of SECRET_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          return fail(
            "EVIDENCE_SECRET_VALUE",
            `field "${truncate(key, 40)}" contains connection material; evidence must stay non-secret`,
          );
        }
      }
    }
    const nested = scanForSecrets(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): EvidenceParseResult | null {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  const missing = allowed
    .filter((key) => key !== "durationSeconds" && key !== "checks")
    .filter((key) => !(key in record));
  if (unexpected.length > 0) {
    return fail(
      "EVIDENCE_SCHEMA_INVALID",
      `${path} has unexpected field(s): ${unexpected.slice(0, 3).map(truncate).join(", ")}`,
    );
  }
  if (missing.length > 0) {
    return fail(
      "EVIDENCE_SCHEMA_INVALID",
      `${path} is missing required field(s): ${missing.slice(0, 3).join(", ")}`,
    );
  }
  return null;
}

function parseTimestamp(value: unknown, path: string): EvidenceParseResult | string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return fail("EVIDENCE_TIMESTAMP_INVALID", `${path} must be an ISO 8601 UTC timestamp`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    return fail("EVIDENCE_TIMESTAMP_INVALID", `${path} is not a valid timestamp`);
  }
  return value;
}

/**
 * Parses raw evidence JSON (already JSON.parse'd by the caller) against the
 * closed schema. Unknown fields, wrong types, and any secret-shaped content
 * are rejected — nothing is coerced or ignored.
 */
export function parseBackupEvidence(raw: unknown): EvidenceParseResult {
  const secretScan = scanForSecrets(raw);
  if (secretScan) return secretScan;

  if (!isPlainObject(raw)) {
    return fail("EVIDENCE_SCHEMA_INVALID", "evidence must be a JSON object");
  }

  const topLevel = assertExactKeys(raw, TOP_LEVEL_KEYS, "evidence");
  if (topLevel) return topLevel;

  if (raw.schemaVersion !== BACKUP_EVIDENCE_SCHEMA_VERSION) {
    return fail(
      "EVIDENCE_SCHEMA_INVALID",
      `schemaVersion must be ${BACKUP_EVIDENCE_SCHEMA_VERSION}`,
    );
  }

  if (!isPlainObject(raw.target)) {
    return fail("EVIDENCE_SCHEMA_INVALID", "target must be an object");
  }
  const targetKeys = assertExactKeys(raw.target, TARGET_KEYS, "target");
  if (targetKeys) return targetKeys;
  if (
    typeof raw.target.environment !== "string" ||
    !isDatabaseEnvironmentId(raw.target.environment)
  ) {
    return fail("EVIDENCE_SCHEMA_INVALID", "target.environment is not a known environment id");
  }
  if (
    typeof raw.target.databaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(raw.target.databaseName)
  ) {
    return fail(
      "EVIDENCE_SCHEMA_INVALID",
      "target.databaseName must be a non-secret database name (letters, digits, _ or -)",
    );
  }

  if (!isPlainObject(raw.backup)) {
    return fail("EVIDENCE_SCHEMA_INVALID", "backup must be an object");
  }
  const backupKeys = assertExactKeys(raw.backup, BACKUP_KEYS, "backup");
  if (backupKeys) return backupKeys;
  if (typeof raw.backup.backupId !== "string" || raw.backup.backupId.length < 1) {
    return fail("EVIDENCE_SCHEMA_INVALID", "backup.backupId must be a non-empty string");
  }
  if (typeof raw.backup.method !== "string" || raw.backup.method.length < 1) {
    return fail("EVIDENCE_SCHEMA_INVALID", "backup.method must be a non-empty string");
  }
  if (raw.backup.scope !== "full" && raw.backup.scope !== "schema") {
    return fail("EVIDENCE_SCHEMA_INVALID", 'backup.scope must be "full" or "schema"');
  }
  const takenAt = parseTimestamp(raw.backup.takenAt, "backup.takenAt");
  if (typeof takenAt !== "string") return takenAt;

  if (!isPlainObject(raw.restoreDrill)) {
    return fail("EVIDENCE_SCHEMA_INVALID", "restoreDrill must be an object");
  }
  const drillKeys = assertExactKeys(raw.restoreDrill, DRILL_KEYS, "restoreDrill");
  if (drillKeys) return drillKeys;
  if (
    raw.restoreDrill.result !== "passed" &&
    raw.restoreDrill.result !== "failed"
  ) {
    return fail('EVIDENCE_SCHEMA_INVALID', 'restoreDrill.result must be "passed" or "failed"');
  }
  const completedAt = parseTimestamp(
    raw.restoreDrill.completedAt,
    "restoreDrill.completedAt",
  );
  if (typeof completedAt !== "string") return completedAt;

  let durationSeconds: number | undefined;
  if ("durationSeconds" in raw.restoreDrill) {
    const duration = raw.restoreDrill.durationSeconds;
    if (
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > 7 * 24 * 60 * 60
    ) {
      return fail(
        "EVIDENCE_SCHEMA_INVALID",
        "restoreDrill.durationSeconds must be a number within one week",
      );
    }
    durationSeconds = duration;
  }

  let checks: Record<string, "passed" | "failed"> | undefined;
  if ("checks" in raw.restoreDrill) {
    const rawChecks = raw.restoreDrill.checks;
    if (!isPlainObject(rawChecks)) {
      return fail("EVIDENCE_SCHEMA_INVALID", "restoreDrill.checks must be an object");
    }
    const entries = Object.entries(rawChecks);
    if (entries.length > MAX_CHECK_ENTRIES) {
      return fail(
        "EVIDENCE_SCHEMA_INVALID",
        `restoreDrill.checks may contain at most ${MAX_CHECK_ENTRIES} entries`,
      );
    }
    checks = {};
    for (const [name, result] of entries) {
      if (!IDENTIFIER_KEY_PATTERN.test(name)) {
        return fail(
          "EVIDENCE_SCHEMA_INVALID",
          `restoreDrill.checks key "${truncate(name, 40)}" is not a simple identifier`,
        );
      }
      if (result !== "passed" && result !== "failed") {
        return fail(
          "EVIDENCE_SCHEMA_INVALID",
          `restoreDrill.checks.${name} must be "passed" or "failed"`,
        );
      }
      checks[name] = result;
    }
  }

  if (typeof raw.recordedBy !== "string" || raw.recordedBy.length < 1) {
    return fail("EVIDENCE_SCHEMA_INVALID", "recordedBy must be a non-empty string");
  }

  const evidence: BackupEvidence = Object.freeze({
    schemaVersion: BACKUP_EVIDENCE_SCHEMA_VERSION,
    target: Object.freeze({
      environment: raw.target.environment,
      databaseName: raw.target.databaseName,
    }),
    backup: Object.freeze({
      backupId: raw.backup.backupId,
      takenAt,
      method: raw.backup.method,
      scope: raw.backup.scope,
    }),
    restoreDrill: Object.freeze({
      result: raw.restoreDrill.result,
      completedAt,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(checks !== undefined
        ? { checks: Object.freeze({ ...checks }) }
        : {}),
    }),
    recordedBy: raw.recordedBy,
  });

  return Object.freeze({ ok: true, evidence });
}

/**
 * Verifies parsed evidence for the current gate run: recent, successful,
 * and bound to the intended database instance. Checks run in a fixed order
 * so the reported code is deterministic for a given document.
 */
export function evaluateBackupEvidence(
  evidence: BackupEvidence,
  context: EvidenceEvaluationContext,
): EvidenceEvaluationResult {
  const maxAgeMs = context.maxAgeMs ?? BACKUP_EVIDENCE_MAX_AGE_MS;
  const maxFutureSkewMs =
    context.maxFutureSkewMs ?? BACKUP_EVIDENCE_MAX_FUTURE_SKEW_MS;

  const backupTakenAt = Date.parse(evidence.backup.takenAt);
  const drillCompletedAt = Date.parse(evidence.restoreDrill.completedAt);
  if (!Number.isFinite(backupTakenAt) || !Number.isFinite(drillCompletedAt)) {
    return fail("EVIDENCE_TIMESTAMP_INVALID", "evidence timestamps must be valid ISO 8601 UTC");
  }

  if (
    backupTakenAt > context.now + maxFutureSkewMs ||
    drillCompletedAt > context.now + maxFutureSkewMs
  ) {
    return fail(
      "EVIDENCE_TIMESTAMP_FUTURE",
      "evidence timestamps are further in the future than the allowed clock skew",
    );
  }

  if (evidence.target.environment !== context.intendedEnvironment) {
    return fail(
      "EVIDENCE_TARGET_ENVIRONMENT_MISMATCH",
      `evidence is bound to environment "${evidence.target.environment}" but the migration targets "${context.intendedEnvironment}"`,
    );
  }

  if (evidence.target.databaseName !== context.actualDatabaseName) {
    return fail(
      "EVIDENCE_TARGET_DATABASE_MISMATCH",
      `evidence is bound to database "${truncate(evidence.target.databaseName)}" but the migration target reports "${truncate(context.actualDatabaseName)}"`,
    );
  }

  if (evidence.restoreDrill.result !== "passed") {
    return fail("EVIDENCE_DRILL_NOT_PASSED", "restore drill result is not a pass");
  }

  const checks = evidence.restoreDrill.checks;
  if (checks) {
    const failed = Object.entries(checks)
      .filter(([, result]) => result !== "passed")
      .map(([name]) => name);
    if (failed.length > 0) {
      return fail(
        "EVIDENCE_DRILL_CHECK_FAILED",
        `restore drill check(s) did not pass: ${failed.slice(0, 3).map((n) => truncate(n, 40)).join(", ")}`,
      );
    }
  }

  if (drillCompletedAt < backupTakenAt) {
    return fail(
      "EVIDENCE_DRILL_BEFORE_BACKUP",
      "restore drill completed before the backup it claims to verify",
    );
  }

  const backupAgeMs = context.now - backupTakenAt;
  if (backupAgeMs > maxAgeMs) {
    return fail(
      "EVIDENCE_BACKUP_STALE",
      `backup is ${Math.floor(backupAgeMs / 3_600_000)}h old; the limit is ${Math.floor(maxAgeMs / 3_600_000)}h`,
    );
  }

  const drillAgeMs = context.now - drillCompletedAt;
  if (drillAgeMs > maxAgeMs) {
    return fail(
      "EVIDENCE_DRILL_STALE",
      `restore drill completed ${Math.floor(drillAgeMs / 3_600_000)}h ago; the limit is ${Math.floor(maxAgeMs / 3_600_000)}h`,
    );
  }

  return Object.freeze({ ok: true, backupAgeMs, drillAgeMs });
}
