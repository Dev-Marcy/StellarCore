/**
 * Deterministic risk classification for committed migrations (#188).
 *
 * Pure, I/O-free logic: given a migration's SQL text it returns a bounded
 * risk score, a level ("low" | "high"), and the exact factors that
 * contributed. The scale itself lives in
 * constants/migrationBackupGate.ts and is documented in
 * docs/migration-backup-gate.md.
 *
 * Two properties matter for the gate:
 * - Determinism: no clock, no database, no randomness. The same SQL always
 *   classifies identically, and each risk factor counts at most once.
 * - Precision on noise: SQL comments, single-quoted literals, and
 *   dollar-quoted bodies are removed before matching, so a commented-out
 *   `DROP TABLE` or a `TRUNCATE` inside an inserted string (and permission
 *   statements such as `REVOKE ... TRUNCATE`) never inflate a score.
 */

import {
  MIGRATION_HIGH_RISK_THRESHOLD,
  MIGRATION_RISK_FACTORS,
  type MigrationRiskFactorCode,
} from "@/constants/migrationBackupGate";

export type MigrationRiskLevel = "low" | "high";

export type MatchedRiskFactor = Readonly<{
  code: MigrationRiskFactorCode;
  weight: number;
}>;

export type MigrationRiskAssessment = Readonly<{
  /** Migration directory name (Prisma migration name). */
  migration: string;
  score: number;
  level: MigrationRiskLevel;
  factors: readonly MatchedRiskFactor[];
}>;

export type MigrationSqlInput = Readonly<{
  name: string;
  sql: string;
}>;

/**
 * Removes everything that is not executable SQL text: line comments,
 * block comments, single-quoted string literals (with `''` escapes), and
 * dollar-quoted bodies (`$$…$$` / `$tag$…$tag$`). Quoted identifiers are
 * kept verbatim because Prisma emits `"table"` names that the risk patterns
 * intentionally match around.
 *
 * This is a small single-pass scanner, not a full SQL parser; it is
 * deterministic and covers the constructs Prisma migrations emit.
 */
export function stripSqlNoise(sql: string): string {
  let out = "";
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const pair = sql.slice(index, index + 2);

    if (pair === "--") {
      while (index < length && sql[index] !== "\n") index += 1;
      continue;
    }

    if (pair === "/*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? length : end + 2;
      out += " ";
      continue;
    }

    const char = sql[index];

    if (char === "'") {
      let cursor = index + 1;
      while (cursor < length) {
        if (sql[cursor] === "'") {
          if (sql[cursor + 1] === "'") {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      out += "''";
      index = cursor;
      continue;
    }

    if (char === "$") {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, index + tag.length);
        out += "''";
        index = end === -1 ? length : end + tag.length;
        continue;
      }
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * Classifies a single migration's SQL against the documented risk scale.
 * Each factor contributes its weight at most once; the level is `high`
 * when the total reaches MIGRATION_HIGH_RISK_THRESHOLD.
 */
export function classifyMigrationSql(
  migration: string,
  sql: string,
): MigrationRiskAssessment {
  const normalized = stripSqlNoise(sql);
  const factors: MatchedRiskFactor[] = [];

  for (const factor of MIGRATION_RISK_FACTORS) {
    if (factor.pattern.test(normalized)) {
      factors.push(Object.freeze({ code: factor.code, weight: factor.weight }));
    }
  }

  const score = factors.reduce((total, factor) => total + factor.weight, 0);
  const level: MigrationRiskLevel =
    score >= MIGRATION_HIGH_RISK_THRESHOLD ? "high" : "low";

  return Object.freeze({ migration, score, level, factors: Object.freeze(factors) });
}

/**
 * Classifies an ordered set of migrations. Input order is preserved and the
 * result is a pure function of the input.
 */
export function classifyMigrations(
  migrations: readonly MigrationSqlInput[],
): readonly MigrationRiskAssessment[] {
  return migrations.map((entry) => classifyMigrationSql(entry.name, entry.sql));
}

/** True when any migration in the set classifies as high-risk. */
export function hasHighRiskMigration(
  assessments: readonly MigrationRiskAssessment[],
): boolean {
  return assessments.some((assessment) => assessment.level === "high");
}
