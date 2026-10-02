import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  MIGRATION_HIGH_RISK_THRESHOLD,
  MIGRATION_RISK_MAX_SCORE,
} from "@/constants/migrationBackupGate";
import {
  classifyMigrationSql,
  classifyMigrations,
  stripSqlNoise,
} from "@/lib/migrations/riskClassification";

const LOW_ADDITIVE_SQL = `
CREATE TABLE "scheduled_source_suppressions" (
    "id" TEXT NOT NULL,
    "reason" TEXT,
    CONSTRAINT "scheduled_source_suppressions_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "rate_snapshots" ADD COLUMN "note" TEXT;
CREATE INDEX "rate_snapshots_captured_at_idx" ON "rate_snapshots"("captured_at");
`;

test("additive schema extension classifies low-risk", () => {
  const assessment = classifyMigrationSql("20261001000000_additive", LOW_ADDITIVE_SQL);
  assert.equal(assessment.level, "low");
  assert.ok(assessment.score < MIGRATION_HIGH_RISK_THRESHOLD);
  assert.deepEqual(assessment.factors, []);
});

test("foreign-key statements with ON DELETE/UPDATE clause stay low-risk", () => {
  const assessment = classifyMigrationSql("fk", `
ALTER TABLE "anchor_corridors" ADD CONSTRAINT "anchor_corridors_anchor_id_fkey"
FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
`);
  assert.equal(assessment.level, "low");
});

test("commented-out DROP TABLE does not inflate the score", () => {
  const assessment = classifyMigrationSql("commented", `
-- DROP TABLE "rate_snapshots";
/* DROP COLUMN "legacy"; */
CREATE INDEX "one_idx" ON "anchors"("slug");
`);
  assert.equal(assessment.level, "low");
  assert.deepEqual(assessment.factors, []);
});

test("DROP TABLE text inside a string literal does not inflate the score", () => {
  const assessment = classifyMigrationSql("literal", `
INSERT INTO "anchors" ("id", "name") VALUES ('x', 'DROP TABLE rate_snapshots; DELETE FROM anchors');
`);
  assert.equal(assessment.level, "low");
  assert.deepEqual(assessment.factors, []);
});

test("permission statements mentioning TRUNCATE/UPDATE/DELETE do not inflate the score", () => {
  const assessment = classifyMigrationSql("permissions", `
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "database_environment" FROM PUBLIC;
GRANT SELECT ON "database_environment" TO PUBLIC;
`);
  assert.equal(assessment.level, "low");
  assert.deepEqual(assessment.factors, []);
});

test("dollar-quoted function bodies are stripped before matching", () => {
  const normalized = stripSqlNoise(
    `CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;`,
  );
  assert.equal(normalized.includes("PERFORM"), false);
});

test("DROP TABLE classifies high-risk with the TABLE_DROP factor", () => {
  const assessment = classifyMigrationSql("drop", `DROP TABLE "legacy_rates";`);
  assert.equal(assessment.level, "high");
  assert.equal(assessment.score, 100);
  assert.deepEqual(assessment.factors.map((f) => f.code), ["TABLE_DROP"]);
});

test("TRUNCATE statement classifies high-risk", () => {
  const assessment = classifyMigrationSql("truncate", `TRUNCATE TABLE "rate_snapshots";`);
  assert.equal(assessment.level, "high");
  assert.deepEqual(assessment.factors.map((f) => f.code), ["TABLE_TRUNCATE"]);
});

test("DELETE FROM classifies high-risk", () => {
  const assessment = classifyMigrationSql(
    "delete",
    `DELETE FROM "transfer_outcomes" WHERE "status" = 'ERROR';`,
  );
  assert.equal(assessment.level, "high");
  assert.deepEqual(assessment.factors.map((f) => f.code), ["ROW_DELETE"]);
});

test("DROP COLUMN classifies high-risk", () => {
  const assessment = classifyMigrationSql(
    "dropcol",
    `ALTER TABLE "rate_snapshots" DROP COLUMN "legacy_source";`,
  );
  assert.equal(assessment.level, "high");
  assert.deepEqual(assessment.factors.map((f) => f.code), ["COLUMN_DROP"]);
});

test("column type change classifies high-risk", () => {
  const assessment = classifyMigrationSql(
    "type",
    `ALTER TABLE "anchors" ALTER COLUMN "status" TYPE TEXT USING "status"::text;`,
  );
  assert.equal(assessment.level, "high");
  assert.deepEqual(assessment.factors.map((f) => f.code), ["COLUMN_TYPE_CHANGE"]);
});

test("SET DATA TYPE classifies high-risk", () => {
  const assessment = classifyMigrationSql(
    "datatype",
    `ALTER TABLE "corridors" ALTER COLUMN "slug" SET DATA TYPE VARCHAR(100);`,
  );
  assert.equal(assessment.level, "high");
  assert.deepEqual(assessment.factors.map((f) => f.code), ["COLUMN_TYPE_CHANGE"]);
});

test("rename classifies high-risk", () => {
  const assessment = classifyMigrationSql(
    "rename",
    `ALTER TABLE "rate_snapshots" RENAME TO "rate_observations";`,
  );
  assert.equal(assessment.level, "high");
  assert.deepEqual(assessment.factors.map((f) => f.code), ["OBJECT_RENAME"]);
});

test("DROP CONSTRAINT classifies high-risk", () => {
  const assessment = classifyMigrationSql(
    "dropconstraint",
    `ALTER TABLE "reputation_scores" DROP CONSTRAINT "reputation_scores_anchor_id_fkey";`,
  );
  assert.equal(assessment.level, "high");
  assert.deepEqual(assessment.factors.map((f) => f.code), ["CONSTRAINT_DROP"]);
});

test("SET NOT NULL sits exactly at the threshold and classifies high-risk", () => {
  const assessment = classifyMigrationSql(
    "notnull",
    `ALTER TABLE "anchors" ALTER COLUMN "slug" SET NOT NULL;`,
  );
  assert.equal(assessment.score, MIGRATION_HIGH_RISK_THRESHOLD);
  assert.equal(assessment.level, "high");
});

test("bulk UPDATE ... SET classifies high-risk", () => {
  const assessment = classifyMigrationSql(
    "backfill",
    `UPDATE "rate_snapshots" SET "captured_at" = "created_at" WHERE "captured_at" IS NULL;`,
  );
  assert.equal(assessment.level, "high");
  assert.deepEqual(assessment.factors.map((f) => f.code), ["ROW_UPDATE"]);
});

test("ON UPDATE CASCADE is not a row update", () => {
  const assessment = classifyMigrationSql(
    "cascade",
    `ALTER TABLE "anchor_corridors" ADD CONSTRAINT "c" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON UPDATE CASCADE ON DELETE CASCADE;`,
  );
  assert.deepEqual(assessment.factors, []);
  assert.equal(assessment.level, "low");
});

test("DROP DEFAULT alone stays low-risk", () => {
  const assessment = classifyMigrationSql(
    "default",
    `ALTER TABLE "anchors" ALTER COLUMN "status" DROP DEFAULT;`,
  );
  assert.equal(assessment.level, "low");
  assert.equal(assessment.score, 20);
});

test("DROP INDEX alone stays low-risk", () => {
  const assessment = classifyMigrationSql(
    "index",
    `DROP INDEX "rate_snapshots_captured_at_idx";`,
  );
  assert.equal(assessment.level, "low");
  assert.equal(assessment.score, 40);
});

test("cumulative structural factors cross the threshold", () => {
  const assessment = classifyMigrationSql(
    "cumulative",
    `
DROP INDEX "rate_snapshots_captured_at_idx";
ALTER TABLE "anchors" ALTER COLUMN "status" DROP DEFAULT;
`,
  );
  assert.equal(assessment.score, 60);
  assert.equal(assessment.level, "high");
});

test("risk factors count at most once per migration", () => {
  const assessment = classifyMigrationSql(
    "twice",
    `DROP TABLE "a"; DROP TABLE "b"; DROP TABLE "c";`,
  );
  assert.equal(assessment.score, 100);
});

test("classification is deterministic across repeated runs", () => {
  const migrations = [
    { name: "m1", sql: LOW_ADDITIVE_SQL },
    { name: "m2", sql: `ALTER TABLE "t" RENAME COLUMN "a" TO "b";` },
  ];
  const first = classifyMigrations(migrations);
  const second = classifyMigrations(migrations);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((assessment) => assessment.migration),
    ["m1", "m2"],
  );
});

test("every score is bounded by the documented maximum", () => {
  const assessment = classifyMigrationSql(
    "max",
    [
      `DROP TABLE "t";`,
      `TRUNCATE TABLE "t";`,
      `DELETE FROM "t";`,
      `ALTER TABLE "t" DROP COLUMN "c";`,
      `ALTER TABLE "t" ALTER COLUMN "c" TYPE TEXT;`,
      `ALTER TABLE "t" RENAME TO "u";`,
      `ALTER TABLE "u" DROP CONSTRAINT "k";`,
      `UPDATE "u" SET "c" = 1;`,
      `ALTER TABLE "u" ALTER COLUMN "c" SET NOT NULL;`,
      `DROP INDEX "i";`,
      `ALTER TABLE "u" ALTER COLUMN "d" DROP DEFAULT;`,
      `CREATE UNIQUE INDEX "i2" ON "u"("c");`,
    ].join("\n"),
  );
  assert.equal(assessment.score, MIGRATION_RISK_MAX_SCORE);
});

test("the committed migration chain classifies deterministically and is currently all low-risk", () => {
  const migrationsDirectory = join(process.cwd(), "prisma", "migrations");
  const names = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const migrations = names.map((name) => ({
    name,
    sql: readFileSync(join(migrationsDirectory, name, "migration.sql"), "utf8"),
  }));

  const first = classifyMigrations(migrations);
  const second = classifyMigrations(migrations);
  assert.deepEqual(first, second, "classification must be deterministic");
  assert.deepEqual(
    first.map((assessment) => assessment.migration),
    names,
    "every committed migration must be classified",
  );

  for (const assessment of first) {
    assert.ok(
      assessment.score >= 0 && assessment.score <= MIGRATION_RISK_MAX_SCORE,
      `${assessment.migration} score out of bounds`,
    );
  }

  // If this fails, a high-risk migration was committed: that is allowed, but
  // it must be a deliberate, reviewed change — commit matching backup
  // evidence (backup-evidence/README.md), update this expectation, and
  // document the new risk in docs/migration-backup-gate.md.
  const highRisk = first.filter((assessment) => assessment.level === "high");
  assert.deepEqual(
    highRisk.map((assessment) => assessment.migration),
    [],
    "committed chain currently contains no high-risk migrations",
  );
});
