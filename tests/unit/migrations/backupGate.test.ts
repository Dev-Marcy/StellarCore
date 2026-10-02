import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_GATE_OVERRIDE_TOKEN,
  BACKUP_EVIDENCE_SCHEMA_VERSION,
} from "@/constants/migrationBackupGate";
import {
  decideMigrationBackupGate,
  type BackupGateInput,
} from "@/lib/migrations/gate";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

const LOW_MIGRATION = {
  name: "20261101000000_add_read_index",
  sql: 'CREATE INDEX "anchors_slug_idx" ON "anchors"("slug");',
};

const HIGH_MIGRATION = {
  name: "20990101000000_drop_legacy_rates",
  sql: 'DROP TABLE "legacy_rates";',
};

const VALID_EVIDENCE_JSON = JSON.stringify({
  schemaVersion: BACKUP_EVIDENCE_SCHEMA_VERSION,
  target: { environment: "production", databaseName: "stellarcore" },
  backup: {
    backupId: "stellarcore-20261001-0200",
    takenAt: "2026-10-01T02:00:00.000Z",
    method: "pg_dump --format=custom",
    scope: "full",
  },
  restoreDrill: {
    result: "passed",
    completedAt: "2026-10-01T03:10:00.000Z",
    durationSeconds: 110,
    checks: { migrationState: "passed", rowCounts: "passed" },
  },
  recordedBy: "restore-drill-run",
});

function baseInput(overrides: Partial<BackupGateInput> = {}): BackupGateInput {
  return {
    now: NOW,
    committedMigrations: [LOW_MIGRATION],
    database: {
      reachable: true,
      appliedMigrationNames: [],
      databaseName: "stellarcore",
      stampEnvironment: "production",
      stampAvailable: true,
    },
    intendedEnvironment: "production",
    evidenceFile: "backup-evidence/production.json",
    evidence: { present: false, raw: null },
    override: { token: null, reason: null, review: null },
    ...overrides,
  };
}

function highRiskInput(overrides: Partial<BackupGateInput> = {}): BackupGateInput {
  return baseInput({
    committedMigrations: [LOW_MIGRATION, HIGH_MIGRATION],
    ...overrides,
  });
}

test("low-risk pending migration passes without any backup evidence", () => {
  const decision = decideMigrationBackupGate(baseInput());
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "PASS_LOW_RISK");
  assert.equal(decision.requiresBackupEvidence, false);
  assert.equal(decision.evidenceState, "not-required");
  assert.equal(decision.override, "absent");
});

test("nothing pending passes without evidence", () => {
  const decision = decideMigrationBackupGate(
    baseInput({
      database: {
        reachable: true,
        appliedMigrationNames: [LOW_MIGRATION.name],
        databaseName: "stellarcore",
        stampEnvironment: "production",
        stampAvailable: true,
      },
    }),
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "PASS_NOTHING_PENDING");
});

test("high-risk migration without evidence fails closed", () => {
  const decision = decideMigrationBackupGate(highRiskInput());
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "EVIDENCE_MISSING");
  assert.equal(decision.requiresBackupEvidence, true);
  assert.equal(decision.evidenceState, "missing");
  assert.ok(
    decision.auditLines.some((line) =>
      line.includes("decision: BLOCK code=EVIDENCE_MISSING"),
    ),
  );
});

test("high-risk migration with fresh, correctly bound evidence passes", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: VALID_EVIDENCE_JSON } }),
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "PASS_EVIDENCE_VALID");
  assert.equal(decision.evidenceState, "valid");
  assert.equal(decision.highRiskCount, 1);
});

test("stale evidence is rejected dynamically at gate time", () => {
  const stale = JSON.parse(VALID_EVIDENCE_JSON);
  stale.backup.takenAt = "2026-09-20T02:00:00.000Z";
  stale.restoreDrill.completedAt = "2026-09-20T03:00:00.000Z";
  const decision = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: JSON.stringify(stale) } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "EVIDENCE_BACKUP_STALE");
});

test("evidence for another environment is rejected", () => {
  const wrongEnv = JSON.parse(VALID_EVIDENCE_JSON);
  wrongEnv.target.environment = "preview";
  const decision = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: JSON.stringify(wrongEnv) } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "EVIDENCE_TARGET_ENVIRONMENT_MISMATCH");
});

test("evidence for another database instance is rejected", () => {
  const wrongDb = JSON.parse(VALID_EVIDENCE_JSON);
  wrongDb.target.databaseName = "stellarcore_preview";
  const decision = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: JSON.stringify(wrongDb) } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "EVIDENCE_TARGET_DATABASE_MISMATCH");
});

test("evidence file present but unreadable (invalid JSON) fails closed", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: "{not json" } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "EVIDENCE_UNREADABLE");
});

test("evidence carrying a credential-shaped field is rejected", () => {
  const leaky = JSON.parse(VALID_EVIDENCE_JSON);
  leaky.backup.password = "hunter2";
  const decision = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: JSON.stringify(leaky) } }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "EVIDENCE_FORBIDDEN_FIELD");
});

test("unreadable database fails closed even for low-risk migrations", () => {
  const decision = decideMigrationBackupGate(
    baseInput({
      database: {
        reachable: false,
        appliedMigrationNames: null,
        databaseName: null,
        stampEnvironment: null,
        stampAvailable: false,
      },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "FAIL_DATABASE_READ");
});

test("missing environment stamp fails closed for high-risk migrations", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({
      database: {
        reachable: true,
        appliedMigrationNames: [],
        databaseName: "stellarcore",
        stampEnvironment: null,
        stampAvailable: false,
      },
      evidence: { present: true, raw: VALID_EVIDENCE_JSON },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "FAIL_DATABASE_IDENTITY_UNVERIFIED");
});

test("environment stamp from another environment fails closed despite valid evidence", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({
      database: {
        reachable: true,
        appliedMigrationNames: [],
        databaseName: "stellarcore",
        stampEnvironment: "preview",
        stampAvailable: true,
      },
      evidence: { present: true, raw: VALID_EVIDENCE_JSON },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "FAIL_DATABASE_STAMP_MISMATCH");
});

test("stamp comparison is case-insensitive", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({
      database: {
        reachable: true,
        appliedMigrationNames: [],
        databaseName: "stellarcore",
        stampEnvironment: "Production",
        stampAvailable: true,
      },
      evidence: { present: true, raw: VALID_EVIDENCE_JSON },
    }),
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "PASS_EVIDENCE_VALID");
});

test("missing intended environment fails closed", () => {
  const decision = decideMigrationBackupGate(
    baseInput({ intendedEnvironment: null }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "FAIL_TARGET_ENVIRONMENT_MISSING");
});

test("a partial emergency override is never accepted and never echoes values", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({
      override: {
        token: "totally-wrong-token",
        reason: "short",
        review: "no-reference",
      },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "FAIL_OVERRIDE_INCOMPLETE");
  assert.equal(decision.override, "invalid");
  assert.ok(decision.detail.includes("token, reason, review"));
  const joined = decision.auditLines.join("\n");
  assert.ok(joined.includes("fields=token,reason,review"));
  assert.equal(joined.includes("totally-wrong-token"), false);
  assert.equal(joined.includes("hunter2"), false);
});

test("an override is invalid even when the gate would otherwise pass", () => {
  const decision = decideMigrationBackupGate(
    baseInput({
      override: { token: BACKUP_GATE_OVERRIDE_TOKEN, reason: null, review: null },
    }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "FAIL_OVERRIDE_INCOMPLETE");
});

test("empty override fields (workflow defaults) count as absent", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({
      override: { token: "", reason: "   ", review: "" },
      evidence: { present: false, raw: null },
    }),
  );
  assert.equal(decision.override, "absent");
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "EVIDENCE_MISSING");
});

test("a fully explicit emergency override allows with a loud audit banner", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({
      override: {
        token: BACKUP_GATE_OVERRIDE_TOKEN,
        reason: "restore drill infrastructure outage; approved hotfix",
        review: "#188",
      },
    }),
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "PASS_EMERGENCY_OVERRIDE");
  assert.equal(decision.override, "active");
  assert.equal(decision.bypassedCode, "EVIDENCE_MISSING");

  const joined = decision.auditLines.join("\n");
  assert.ok(joined.includes("EMERGENCY OVERRIDE ACTIVE"));
  assert.ok(joined.includes("bypassed check : EVIDENCE_MISSING"));
  assert.ok(joined.includes("restore drill infrastructure outage"));
  assert.ok(joined.includes("#188"));
  assert.ok(joined.includes("WITHOUT verified backup evidence"));
});

test("an active override on a low-risk run still reports the bypassed check", () => {
  const decision = decideMigrationBackupGate(
    baseInput({
      override: {
        token: BACKUP_GATE_OVERRIDE_TOKEN,
        reason: "operator testing override output during maintenance",
        review: "PR #314",
      },
    }),
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "PASS_EMERGENCY_OVERRIDE");
  assert.equal(decision.bypassedCode, "PASS_LOW_RISK");
});

test("audit output never contains connection URLs", () => {
  const decision = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: VALID_EVIDENCE_JSON } }),
  );
  const joined = decision.auditLines.join("\n");
  assert.equal(/postgres(?:ql)?:\/\//i.test(joined), false);
  assert.equal(/password/i.test(joined), false);
});

test("identical inputs produce identical decisions", () => {
  const first = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: VALID_EVIDENCE_JSON } }),
  );
  const second = decideMigrationBackupGate(
    highRiskInput({ evidence: { present: true, raw: VALID_EVIDENCE_JSON } }),
  );
  assert.deepEqual(first, second);
});
