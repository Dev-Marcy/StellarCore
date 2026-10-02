/**
 * Migration backup gate — decision logic (#188).
 *
 * Pure, I/O-free composition of:
 * - deterministic risk classification of pending migrations,
 * - strict backup-evidence parsing and evaluation,
 * - database target identity (name + environment stamp),
 * - the explicit emergency-override channel.
 *
 * Fail-closed principle: every unknown, unreadable, stale, or mismatched
 * input produces a blocking decision with a stable code. The only paths that
 * allow a high-risk migration are a freshly verified, correctly bound
 * evidence document or the fully explicit emergency override — which is
 * never partial, never defaulted, and always emits a loud audit banner into
 * the deployment output.
 */

import {
  BACKUP_EVIDENCE_MAX_AGE_MS,
  BACKUP_EVIDENCE_MAX_FUTURE_SKEW_MS,
  BACKUP_GATE_OVERRIDE_MIN_REASON_LENGTH,
  BACKUP_GATE_OVERRIDE_REVIEW_PATTERN,
  BACKUP_GATE_OVERRIDE_TOKEN,
} from "@/constants/migrationBackupGate";
import type { DatabaseEnvironmentId } from "@/lib/config/environmentGuard";
import {
  evaluateBackupEvidence,
  parseBackupEvidence,
  type EvidenceFailureCode,
} from "@/lib/migrations/backupEvidence";
import {
  classifyMigrations,
  type MigrationRiskAssessment,
  type MigrationSqlInput,
} from "@/lib/migrations/riskClassification";

export type BackupGateCode =
  | "PASS_NOTHING_PENDING"
  | "PASS_LOW_RISK"
  | "PASS_EVIDENCE_VALID"
  | "PASS_EMERGENCY_OVERRIDE"
  | "FAIL_OVERRIDE_INCOMPLETE"
  | "FAIL_TARGET_ENVIRONMENT_MISSING"
  | "FAIL_DATABASE_READ"
  | "FAIL_DATABASE_IDENTITY_UNVERIFIED"
  | "FAIL_DATABASE_STAMP_MISMATCH"
  | "EVIDENCE_MISSING"
  | EvidenceFailureCode;

export type BackupGateEvidenceState =
  | "not-required"
  | "not-verified"
  | "missing"
  | "valid"
  | "invalid";

export type BackupGateOverrideState = "absent" | "active" | "invalid";

/** Facts gathered from the target database before the gate decides. */
export type BackupGateDatabaseFacts = Readonly<{
  /** False when the database could not be read at all (fail closed). */
  reachable: boolean;
  /** Applied migration names, or null when the read failed. */
  appliedMigrationNames: readonly string[] | null;
  /** `current_database()` of the target, or null when unreadable. */
  databaseName: string | null;
  /** Raw environment stamp, or null when the stamp is absent/unreadable. */
  stampEnvironment: string | null;
  /** False when the database_environment table does not exist. */
  stampAvailable: boolean;
}>;

export type BackupGateOverrideInput = Readonly<{
  token: string | null;
  reason: string | null;
  review: string | null;
}>;

export type BackupGateInput = Readonly<{
  /** Evaluation instant (epoch ms); injected for deterministic tests. */
  now: number;
  committedMigrations: readonly MigrationSqlInput[];
  database: BackupGateDatabaseFacts;
  intendedEnvironment: DatabaseEnvironmentId | null;
  /** Display path of the evidence file, e.g. `backup-evidence/production.json`. */
  evidenceFile: string;
  evidence: Readonly<{ present: boolean; raw: string | null }>;
  override: BackupGateOverrideInput;
  limits?: Readonly<{ maxAgeMs: number; maxFutureSkewMs: number }>;
}>;

export type BackupGateDecision = Readonly<{
  allowed: boolean;
  code: BackupGateCode;
  detail: string;
  requiresBackupEvidence: boolean;
  /** Pending migrations evaluated; null when classification could not run. */
  pendingCount: number | null;
  highRiskCount: number | null;
  assessments: readonly MigrationRiskAssessment[];
  evidenceState: BackupGateEvidenceState;
  evidenceDetail: string;
  override: BackupGateOverrideState;
  /** Set only when the override is active: the check it bypassed. */
  bypassedCode: BackupGateCode | null;
  /** Human-readable lines printed verbatim to the deployment output. */
  auditLines: readonly string[];
}>;

export type OverrideEvaluation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "active"; reason: string; review: string }>
  | Readonly<{ kind: "invalid"; invalidFields: readonly string[] }>;

function normalizeOverrideField(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Validates the emergency-override channel. All three fields must be
 * present and valid together: an empty, missing, or partial override is
 * never treated as active, so no default configuration can bypass the gate.
 * Only field *names* are reported — values are never echoed here.
 */
export function evaluateBackupGateOverride(
  override: BackupGateOverrideInput,
): OverrideEvaluation {
  const token = normalizeOverrideField(override.token);
  const reason = normalizeOverrideField(override.reason);
  const review = normalizeOverrideField(override.review);

  if (token === null && reason === null && review === null) {
    return Object.freeze({ kind: "absent" });
  }

  const invalidFields: string[] = [];
  if (token !== BACKUP_GATE_OVERRIDE_TOKEN) invalidFields.push("token");
  if (reason === null || reason.length < BACKUP_GATE_OVERRIDE_MIN_REASON_LENGTH) {
    invalidFields.push("reason");
  }
  if (review === null || !BACKUP_GATE_OVERRIDE_REVIEW_PATTERN.test(review)) {
    invalidFields.push("review");
  }

  if (invalidFields.length > 0) {
    return Object.freeze({ kind: "invalid", invalidFields: Object.freeze(invalidFields) });
  }

  if (reason === null || review === null) {
    // Unreachable: a null reason/review was pushed onto invalidFields above.
    return Object.freeze({
      kind: "invalid",
      invalidFields: Object.freeze(["reason", "review"]),
    });
  }

  return Object.freeze({ kind: "active", reason, review });
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildAssessmentLines(
  assessments: readonly MigrationRiskAssessment[],
): string[] {
  const lines: string[] = [];
  const limit = Math.min(assessments.length, 40);
  for (let index = 0; index < limit; index += 1) {
    const assessment = assessments[index];
    const factorCodes =
      assessment.factors.length > 0
        ? assessment.factors.map((factor) => factor.code).join("+")
        : "none";
    lines.push(
      `  ${assessment.level === "high" ? "HIGH" : " low"} ${assessment.migration} score=${assessment.score} factors=${factorCodes}`,
    );
  }
  if (assessments.length > limit) {
    lines.push(`  … ${assessments.length - limit} more migration(s) omitted`);
  }
  return lines;
}

type NormalOutcome = Readonly<{
  allowed: boolean;
  code: BackupGateCode;
  detail: string;
  requiresBackupEvidence: boolean;
  pendingCount: number | null;
  highRiskCount: number | null;
  assessments: readonly MigrationRiskAssessment[];
  evidenceState: BackupGateEvidenceState;
  evidenceDetail: string;
  auditLines: readonly string[];
}>;

/**
 * The fail-closed evaluation of everything except the override channel.
 * Every branch returns a complete, printable decision fragment.
 */
function evaluateNormalOutcome(input: BackupGateInput): NormalOutcome {
  const maxAgeMs = input.limits?.maxAgeMs ?? BACKUP_EVIDENCE_MAX_AGE_MS;
  const maxFutureSkewMs =
    input.limits?.maxFutureSkewMs ?? BACKUP_EVIDENCE_MAX_FUTURE_SKEW_MS;

  const header = (): string =>
    `migration backup gate: environment=${input.intendedEnvironment ?? "unresolved"} committed=${input.committedMigrations.length} applied=${input.database.appliedMigrationNames?.length ?? "unreadable"}`;

  if (input.intendedEnvironment === null) {
    return {
      allowed: false,
      code: "FAIL_TARGET_ENVIRONMENT_MISSING",
      detail:
        "the migration workflow did not declare STELLARCORE_ENVIRONMENT; the intended target is unresolved",
      requiresBackupEvidence: false,
      pendingCount: null,
      highRiskCount: null,
      assessments: [],
      evidenceState: "not-required",
      evidenceDetail: "target environment unresolved",
      auditLines: [header(), "decision: BLOCK code=FAIL_TARGET_ENVIRONMENT_MISSING"],
    };
  }

  if (!input.database.reachable || input.database.appliedMigrationNames === null) {
    return {
      allowed: false,
      code: "FAIL_DATABASE_READ",
      detail:
        "target database could not be read to determine applied migrations; failing closed",
      requiresBackupEvidence: false,
      pendingCount: null,
      highRiskCount: null,
      assessments: [],
      evidenceState: "not-required",
      evidenceDetail: "database unreadable",
      auditLines: [header(), "decision: BLOCK code=FAIL_DATABASE_READ"],
    };
  }

  const applied = new Set(input.database.appliedMigrationNames);
  const pending = input.committedMigrations.filter(
    (migration) => !applied.has(migration.name),
  );
  const assessments = classifyMigrations(pending);
  const highRisk = assessments.filter((assessment) => assessment.level === "high");
  const requiresBackupEvidence = highRisk.length > 0;

  const baseLines = [
    header(),
    `pending: ${pending.length} migration(s), high-risk: ${highRisk.length}`,
    ...buildAssessmentLines(assessments),
  ];

  if (pending.length === 0) {
    return {
      allowed: true,
      code: "PASS_NOTHING_PENDING",
      detail: "all committed migrations are already applied",
      requiresBackupEvidence,
      pendingCount: pending.length,
      highRiskCount: highRisk.length,
      assessments,
      evidenceState: "not-required",
      evidenceDetail: "no pending migrations",
      auditLines: [...baseLines, "decision: ALLOW code=PASS_NOTHING_PENDING"],
    };
  }

  if (!requiresBackupEvidence) {
    return {
      allowed: true,
      code: "PASS_LOW_RISK",
      detail: "pending migrations are additive/low-risk and need no backup gate",
      requiresBackupEvidence,
      pendingCount: pending.length,
      highRiskCount: highRisk.length,
      assessments,
      evidenceState: "not-required",
      evidenceDetail: "no high-risk pending migrations",
      auditLines: [...baseLines, "decision: ALLOW code=PASS_LOW_RISK"],
    };
  }

  // High-risk migrations are pending: the backup gate now applies.
  const gateLines: string[] = [
    ...baseLines,
    `backup gate: required for ${highRisk.length} high-risk migration(s)`,
  ];

  if (
    input.database.databaseName === null ||
    !input.database.stampAvailable ||
    input.database.stampEnvironment === null
  ) {
    return {
      allowed: false,
      code: "FAIL_DATABASE_IDENTITY_UNVERIFIED",
      detail:
        "target database identity (current_database/environment stamp) could not be verified; failing closed",
      requiresBackupEvidence,
      pendingCount: pending.length,
      highRiskCount: highRisk.length,
      assessments,
      evidenceState: "not-verified",
      evidenceDetail: "target identity unverified",
      auditLines: [
        ...gateLines,
        `target: databaseName=${input.database.databaseName ?? "unreadable"} stamp=${input.database.stampEnvironment ?? "unavailable"}`,
        "decision: BLOCK code=FAIL_DATABASE_IDENTITY_UNVERIFIED",
      ],
    };
  }

  const stampEnvironment = input.database.stampEnvironment.trim().toLowerCase();
  if (stampEnvironment !== input.intendedEnvironment) {
    return {
      allowed: false,
      code: "FAIL_DATABASE_STAMP_MISMATCH",
      detail: `database environment stamp "${truncate(stampEnvironment, 60)}" does not match the intended environment "${input.intendedEnvironment}"`,
      requiresBackupEvidence,
      pendingCount: pending.length,
      highRiskCount: highRisk.length,
      assessments,
      evidenceState: "not-verified",
      evidenceDetail: "target identity mismatched",
      auditLines: [
        ...gateLines,
        `target: databaseName=${input.database.databaseName} stamp=${stampEnvironment} — does NOT match intended environment "${input.intendedEnvironment}"`,
        "decision: BLOCK code=FAIL_DATABASE_STAMP_MISMATCH",
      ],
    };
  }

  gateLines.push(
    `target: databaseName=${input.database.databaseName} stamp=${stampEnvironment} — bound to intended environment "${input.intendedEnvironment}"`,
  );

  if (!input.evidence.present || input.evidence.raw === null) {
    return {
      allowed: false,
      code: "EVIDENCE_MISSING",
      detail: `${input.evidenceFile} is missing; a high-risk migration cannot proceed without verified backup evidence`,
      requiresBackupEvidence,
      pendingCount: pending.length,
      highRiskCount: highRisk.length,
      assessments,
      evidenceState: "missing",
      evidenceDetail: "evidence file missing",
      auditLines: [
        ...gateLines,
        `evidence: ${input.evidenceFile} missing`,
        "decision: BLOCK code=EVIDENCE_MISSING",
      ],
    };
  }

  let parsed: ReturnType<typeof parseBackupEvidence>;
  try {
    parsed = parseBackupEvidence(JSON.parse(input.evidence.raw));
  } catch {
    parsed = { ok: false, code: "EVIDENCE_UNREADABLE", detail: "evidence file is not valid JSON" };
  }

  if (!parsed.ok) {
    return {
      allowed: false,
      code: parsed.code,
      detail: parsed.detail,
      requiresBackupEvidence,
      pendingCount: pending.length,
      highRiskCount: highRisk.length,
      assessments,
      evidenceState: "invalid",
      evidenceDetail: `${parsed.code}: ${truncate(parsed.detail)}`,
      auditLines: [
        ...gateLines,
        `evidence: ${input.evidenceFile} rejected code=${parsed.code} detail=${truncate(parsed.detail)}`,
        `decision: BLOCK code=${parsed.code}`,
      ],
    };
  }

  const evaluation = evaluateBackupEvidence(parsed.evidence, {
    now: input.now,
    intendedEnvironment: input.intendedEnvironment,
    actualDatabaseName: input.database.databaseName,
    maxAgeMs,
    maxFutureSkewMs,
  });

  if (!evaluation.ok) {
    return {
      allowed: false,
      code: evaluation.code,
      detail: evaluation.detail,
      requiresBackupEvidence,
      pendingCount: pending.length,
      highRiskCount: highRisk.length,
      assessments,
      evidenceState: "invalid",
      evidenceDetail: `${evaluation.code}: ${truncate(evaluation.detail)}`,
      auditLines: [
        ...gateLines,
        `evidence: ${input.evidenceFile} rejected code=${evaluation.code} detail=${truncate(evaluation.detail)}`,
        `decision: BLOCK code=${evaluation.code}`,
      ],
    };
  }

  return {
    allowed: true,
    code: "PASS_EVIDENCE_VALID",
    detail: "recent restore-drill evidence verified and bound to the intended database",
    requiresBackupEvidence,
    pendingCount: pending.length,
    highRiskCount: highRisk.length,
    assessments,
    evidenceState: "valid",
    evidenceDetail: `backup age ${Math.round(evaluation.backupAgeMs / 60_000)}m, drill age ${Math.round(evaluation.drillAgeMs / 60_000)}m`,
    auditLines: [
      ...gateLines,
      `evidence: ${input.evidenceFile} verified (${Math.round(evaluation.backupAgeMs / 60_000)}m old backup, drill ${Math.round(evaluation.drillAgeMs / 60_000)}m old)`,
      "decision: ALLOW code=PASS_EVIDENCE_VALID",
    ],
  };
}

function buildOverrideBanner(
  override: Extract<OverrideEvaluation, { kind: "active" }>,
  normal: NormalOutcome,
  now: number,
): string[] {
  return [
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "!! STELLARCORE MIGRATION BACKUP GATE — EMERGENCY OVERRIDE ACTIVE",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "!! This migration is proceeding WITHOUT verified backup evidence.",
    `!! bypassed check : ${normal.code}`,
    `!! reason         : ${truncate(normalizeOverrideField(override.reason) ?? "", 160)}`,
    `!! review         : ${override.review}`,
    `!! evaluated at   : ${new Date(now).toISOString()}`,
    "!! This block is the audit record and is printed to the deployment log.",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  ];
}

/**
 * Decides whether the production migration may proceed. The override is
 * evaluated first so an invalid (partial) override blocks loudly, an active
 * override allows with a full audit banner that includes the check it
 * bypassed, and an absent override — the default — runs the fail-closed
 * evaluation above.
 */
export function decideMigrationBackupGate(
  input: BackupGateInput,
): BackupGateDecision {
  const normal = evaluateNormalOutcome(input);
  const override = evaluateBackupGateOverride(input.override);

  if (override.kind === "invalid") {
    return {
      ...normal,
      allowed: false,
      code: "FAIL_OVERRIDE_INCOMPLETE",
      detail: `emergency override fields are incomplete or invalid: ${override.invalidFields.join(", ")} (values are not echoed)`,
      override: "invalid",
      bypassedCode: null,
      auditLines: [
        ...normal.auditLines,
        `override: INVALID fields=${override.invalidFields.join(",")} — partial overrides are never accepted; clear the override variables or supply token, reason, and review together`,
        "decision: BLOCK code=FAIL_OVERRIDE_INCOMPLETE",
      ],
    };
  }

  if (override.kind === "active") {
    return {
      ...normal,
      allowed: true,
      code: "PASS_EMERGENCY_OVERRIDE",
      detail: "emergency override acknowledged without verified backup evidence",
      override: "active",
      bypassedCode: normal.code,
      auditLines: [
        ...buildOverrideBanner(override, normal, input.now),
        ...normal.auditLines,
        "decision: ALLOW code=PASS_EMERGENCY_OVERRIDE (explicit emergency override)",
      ],
    };
  }

  return {
    ...normal,
    override: "absent",
    bypassedCode: null,
  };
}
