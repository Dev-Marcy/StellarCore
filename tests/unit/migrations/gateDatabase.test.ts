import assert from "node:assert/strict";
import test from "node:test";

import { GATE_SQL, readMigrationGateFacts } from "@/lib/migrations/gateDatabase";

test("gate SQL is constant, parameter-free, and read-only", () => {
  const statements = Object.values(GATE_SQL);
  assert.ok(statements.length >= 3);

  for (const statement of statements) {
    assert.equal(
      statement.includes("${"),
      false,
      "gate SQL must never interpolate values",
    );
    assert.equal(
      /;/.test(statement),
      false,
      "gate SQL must be a single statement",
    );
    assert.match(statement, /^\s*SELECT\b/i, "gate SQL must be a SELECT");
  }

  assert.match(GATE_SQL.appliedMigrations, /"_prisma_migrations"/);
  assert.match(GATE_SQL.databaseName, /current_database\(\)/);
  assert.match(GATE_SQL.environmentStamp, /"database_environment"/);
});

test("a missing or non-PostgreSQL connection string fails closed without connecting", async () => {
  for (const connectionString of [undefined, "", "mysql://user:host/db", ":::"]) {
    const facts = await readMigrationGateFacts(connectionString);
    assert.equal(facts.reachable, false);
    assert.equal(facts.appliedMigrationNames, null);
    assert.equal(facts.databaseName, null);
    assert.equal(facts.stampAvailable, false);
  }
});
