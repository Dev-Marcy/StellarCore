/**
 * Backup-gate configuration manifest for production migrations (#188).
 *
 * This file is the single reviewed source of truth for:
 * - the risk-factor scale used to classify pending migrations,
 * - the score threshold that makes a migration "high-risk",
 * - backup-evidence freshness limits and the evidence directory,
 * - the emergency-override literals.
 *
 * Design rules:
 * - Classification is a pure function of committed SQL text: no database
 *   reads, no clock, no randomness. The same migration directory always
 *   classifies identically (lib/migrations/riskClassification.ts).
 * - Every weight and threshold below is documented in
 *   docs/migration-backup-gate.md; changing a value changes the documented
 *   scale in the same pull request.
 * - The override token is deliberately verbose and never has a default: an
 *   unset, empty, or partial override is always treated as "no override",
 *   so the gate can never be bypassed by an accidental default.
 * - Evidence records never contain credentials, connection strings, hashes,
 *   or database contents — see lib/migrations/backupEvidence.ts, which
 *   rejects any evidence file that carries them.
 */

/** Evidence schema version accepted by the gate. */
export const BACKUP_EVIDENCE_SCHEMA_VERSION = 1;

/**
 * A pending migration whose deterministic risk score reaches this threshold
 * requires verified backup evidence before it may apply in production.
 * Weights are chosen so a single destructive statement (drop/truncate/
 * delete) or any structural type/rename/not-null change reaches it, while
 * additive schema extensions (create table, add column, create index) stay
 * well below it even in combination with benign metadata edits.
 */
export const MIGRATION_HIGH_RISK_THRESHOLD = 50;

/**
 * Backup evidence must be recent to count: both the backup itself and its
 * restore drill (#170) must be no older than this at gate time (7 days).
 */
export const BACKUP_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tolerated clock skew for evidence timestamps. Timestamps further in the
 * future than this are rejected rather than silently accepted.
 */
export const BACKUP_EVIDENCE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Directory (relative to the repository root) holding evidence files. */
export const BACKUP_EVIDENCE_DIRECTORY = "backup-evidence";

/** Evidence file name per target environment: backup-evidence/<environment>.json */
export const BACKUP_EVIDENCE_FILE_SUFFIX = ".json";

/**
 * The only accepted emergency-override token. It must be supplied through an
 * explicit, reviewed configuration channel (workflow input) together with a
 * reason and a review reference; see BACKUP_GATE_OVERRIDE_* below.
 */
export const BACKUP_GATE_OVERRIDE_TOKEN = "emergency-acknowledge-unverified-backup";

/** Minimum length of the required override reason. */
export const BACKUP_GATE_OVERRIDE_MIN_REASON_LENGTH = 12;

/**
 * The required override review reference must cite an issue or pull request
 * (for example `#188` or `PR #314`) so every override maps to a reviewable
 * record.
 */
export const BACKUP_GATE_OVERRIDE_REVIEW_PATTERN = /#\d+/;

export type MigrationRiskFactorCode =
  | "TABLE_DROP"
  | "TABLE_TRUNCATE"
  | "ROW_DELETE"
  | "COLUMN_DROP"
  | "COLUMN_TYPE_CHANGE"
  | "OBJECT_RENAME"
  | "CONSTRAINT_DROP"
  | "ROW_UPDATE"
  | "NOT_NULL_ENFORCE"
  | "INDEX_DROP"
  | "DEFAULT_CHANGE"
  | "UNIQUE_CONSTRAINT_ADD";

export type MigrationRiskFactor = Readonly<{
  code: MigrationRiskFactorCode;
  /** Deterministic weight contributed to the migration's total risk score. */
  weight: number;
  /** Human-readable rule, mirrored in docs/migration-backup-gate.md. */
  description: string;
  /** Matched against comment- and literal-stripped SQL, case-insensitive. */
  pattern: RegExp;
}>;

/**
 * The deterministic risk scale. Each factor is presence-based: it contributes
 * its weight at most once per migration, no matter how often it occurs, so a
 * score never depends on formatting or repetition.
 *
 * Patterns must never carry the `g` flag (stateless `.test()`), and must not
 * match permission statements such as `REVOKE ... TRUNCATE` or
 * `ON UPDATE CASCADE`.
 */
export const MIGRATION_RISK_FACTORS: readonly MigrationRiskFactor[] =
  Object.freeze([
    Object.freeze({
      code: "TABLE_DROP",
      weight: 100,
      description: "DROP TABLE — irrecoverable loss of a table's rows",
      pattern: /\bDROP\s+TABLE\b/i,
    }),
    Object.freeze({
      code: "TABLE_TRUNCATE",
      weight: 100,
      description: "TRUNCATE statement — removes all rows of a table",
      pattern: /^\s*TRUNCATE\b/im,
    }),
    Object.freeze({
      code: "ROW_DELETE",
      weight: 90,
      description: "DELETE FROM — removes rows from a table",
      pattern: /\bDELETE\s+FROM\b/i,
    }),
    Object.freeze({
      code: "COLUMN_DROP",
      weight: 80,
      description: "DROP COLUMN — irrecoverable loss of column data",
      pattern: /\bDROP\s+COLUMN\b/i,
    }),
    Object.freeze({
      code: "COLUMN_TYPE_CHANGE",
      weight: 70,
      description: "ALTER COLUMN ... TYPE / SET DATA TYPE — rewrites stored values",
      pattern:
        /\bSET\s+DATA\s+TYPE\b|\bALTER\s+COLUMN\b[^;]{0,160}?\bTYPE\b/i,
    }),
    Object.freeze({
      code: "OBJECT_RENAME",
      weight: 60,
      description: "RENAME TO / RENAME COLUMN / RENAME CONSTRAINT — breaks referencing SQL",
      pattern: /\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b/i,
    }),
    Object.freeze({
      code: "CONSTRAINT_DROP",
      weight: 60,
      description: "DROP CONSTRAINT — removes an integrity guarantee",
      pattern: /\bDROP\s+CONSTRAINT\b/i,
    }),
    Object.freeze({
      code: "ROW_UPDATE",
      weight: 60,
      description: "UPDATE ... SET — bulk data transformation with overwrite risk",
      pattern: /\bUPDATE\s+(?:ONLY\s+)?"?[a-z_][a-z0-9_]*"?\s+SET\b/i,
    }),
    Object.freeze({
      code: "NOT_NULL_ENFORCE",
      weight: 50,
      description: "SET NOT NULL — rewrites/validates existing rows, fails on null data",
      pattern: /\bSET\s+NOT\s+NULL\b/i,
    }),
    Object.freeze({
      code: "INDEX_DROP",
      weight: 40,
      description: "DROP INDEX — removes a read path until recreated",
      pattern: /\bDROP\s+INDEX\b/i,
    }),
    Object.freeze({
      code: "DEFAULT_CHANGE",
      weight: 20,
      description: "SET/DROP DEFAULT — changes write behavior for future rows",
      pattern: /\b(?:SET|DROP)\s+DEFAULT\b/i,
    }),
    Object.freeze({
      code: "UNIQUE_CONSTRAINT_ADD",
      weight: 15,
      description:
        "CREATE UNIQUE INDEX / ADD CONSTRAINT ... UNIQUE — can fail or lock on existing duplicates",
      pattern:
        /\bCREATE\s+UNIQUE\s+INDEX\b|\bADD\s+CONSTRAINT\b[^;]{0,200}?\bUNIQUE\b/i,
    }),
  ]);

/** Upper bound of a migration's score (sum of all factor weights). */
export const MIGRATION_RISK_MAX_SCORE: number = MIGRATION_RISK_FACTORS.reduce(
  (total, factor) => total + factor.weight,
  0,
);
