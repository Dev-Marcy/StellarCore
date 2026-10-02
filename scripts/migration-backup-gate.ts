import "dotenv/config";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BACKUP_EVIDENCE_DIRECTORY,
  BACKUP_EVIDENCE_FILE_SUFFIX,
} from "@/constants/migrationBackupGate";
import { isDatabaseEnvironmentId } from "@/lib/config/environmentGuard";
import type { DatabaseEnvironmentId } from "@/lib/config/environmentGuard";
import { readMigrationGateFacts } from "@/lib/migrations/gateDatabase";
import { decideMigrationBackupGate } from "@/lib/migrations/gate";
import { classifyMigrations } from "@/lib/migrations/riskClassification";
import type { MigrationSqlInput } from "@/lib/migrations/riskClassification";

/**
 * Migration backup gate CLI (#188).
 *
 * Fails a production migration run (exit 1) unless every pending high-risk
 * migration is covered by recent, verified, correctly bound backup evidence
 * — or by the fully explicit emergency override, whose use prints a loud
 * audit banner into the deployment output. Low-risk pending migrations pass
 * without evidence; nothing here ever writes to the database.
 *
 * Usage:
 *   npm run migration:gate                     # full gate (needs DATABASE_URL,
 *                                              #   STELLARCORE_ENVIRONMENT)
 *   npm run migration:gate -- --classify-only  # offline dry-run: classify the
 *                                              #   committed migration chain
 *
 * Override (emergency only; never set by default):
 *   STELLARCORE_BACKUP_GATE_OVERRIDE          exact token, see constants
 *   STELLARCORE_BACKUP_GATE_OVERRIDE_REASON   >= 12 characters of justification
 *   STELLARCORE_BACKUP_GATE_OVERRIDE_REVIEW   review reference, e.g. "#188"
 */

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MIGRATIONS_DIRECTORY = join(REPO_ROOT, "prisma", "migrations");

async function loadCommittedMigrations(): Promise<MigrationSqlInput[]> {
  const entries = await readdir(MIGRATIONS_DIRECTORY, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    names.map(async (name) => {
      let sql = "";
      try {
        sql = await readFile(
          join(MIGRATIONS_DIRECTORY, name, "migration.sql"),
          "utf8",
        );
      } catch {
        // A directory without migration.sql contributes no SQL to classify.
      }
      return { name, sql };
    }),
  );
}

function resolveIntendedEnvironment(): DatabaseEnvironmentId | null {
  const raw = process.env.STELLARCORE_ENVIRONMENT?.trim().toLowerCase();
  return raw && isDatabaseEnvironmentId(raw) ? raw : null;
}

async function readEvidenceFile(
  path: string,
): Promise<{ present: boolean; raw: string | null }> {
  try {
    const raw = await readFile(path, "utf8");
    return { present: true, raw };
  } catch {
    // Unreadable evidence is treated exactly like missing evidence: absent.
    return { present: false, raw: null };
  }
}

async function main(): Promise<void> {
  const classifyOnly = process.argv.includes("--classify-only");
  const committed = await loadCommittedMigrations();

  if (classifyOnly) {
    const assessments = classifyMigrations(committed);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: "classify-only",
        migrationCount: assessments.length,
        highRiskCount: assessments.filter((a) => a.level === "high").length,
        migrations: assessments.map((assessment) => ({
          migration: assessment.migration,
          score: assessment.score,
          level: assessment.level,
          factors: assessment.factors.map((factor) => factor.code),
        })),
      })}\n`,
    );
    return;
  }

  const intendedEnvironment = resolveIntendedEnvironment();
  const evidenceRelativePath =
    intendedEnvironment === null
      ? `${BACKUP_EVIDENCE_DIRECTORY}/<unresolved>${BACKUP_EVIDENCE_FILE_SUFFIX}`
      : `${BACKUP_EVIDENCE_DIRECTORY}/${intendedEnvironment}${BACKUP_EVIDENCE_FILE_SUFFIX}`;

  const [database, evidence] = await Promise.all([
    readMigrationGateFacts(process.env.DATABASE_URL),
    intendedEnvironment === null
      ? Promise.resolve({ present: false, raw: null })
      : readEvidenceFile(join(REPO_ROOT, evidenceRelativePath)),
  ]);

  const decision = decideMigrationBackupGate({
    now: Date.now(),
    committedMigrations: committed,
    database,
    intendedEnvironment,
    evidenceFile: evidenceRelativePath,
    evidence,
    override: {
      token: process.env.STELLARCORE_BACKUP_GATE_OVERRIDE ?? null,
      reason: process.env.STELLARCORE_BACKUP_GATE_OVERRIDE_REASON ?? null,
      review: process.env.STELLARCORE_BACKUP_GATE_OVERRIDE_REVIEW ?? null,
    },
  });

  for (const line of decision.auditLines) {
    console.log(line);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: decision.allowed,
      code: decision.code,
      detail: decision.detail,
      requiresBackupEvidence: decision.requiresBackupEvidence,
      pendingCount: decision.pendingCount,
      highRiskCount: decision.highRiskCount,
      evidenceState: decision.evidenceState,
      evidenceDetail: decision.evidenceDetail,
      override: decision.override,
      bypassedCode: decision.bypassedCode,
    })}\n`,
  );

  process.exitCode = decision.allowed ? 0 : 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    console.error(
      JSON.stringify({ ok: false, code: "GATE_EXECUTION_FAILURE" }),
    );
    process.exitCode = 1;
  });
}
