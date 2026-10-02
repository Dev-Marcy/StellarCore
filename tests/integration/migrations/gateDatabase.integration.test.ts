import assert from "node:assert/strict";
import test from "node:test";

import { readMigrationGateFacts } from "@/lib/migrations/gateDatabase";
import { createMockPostgresServer } from "../db/fixtures/mockPostgresServer";

/**
 * The gate's database reader must fail closed on real connection-level
 * failures, not just missing configuration (#188). These cases use the
 * existing mock PostgreSQL server and never touch a real database.
 */

test("a server that rejects the startup connection fails closed as unreachable", async () => {
  const server = await createMockPostgresServer(0);
  try {
    server.setMode("ADMIN_SHUTDOWN");
    const facts = await readMigrationGateFacts(server.connectionString);
    assert.equal(facts.reachable, false);
    assert.equal(facts.appliedMigrationNames, null);
    assert.equal(facts.databaseName, null);
    assert.equal(facts.stampAvailable, false);
  } finally {
    await server.close();
  }
});

test("a connection dropped mid-query fails closed as unreachable", async () => {
  const server = await createMockPostgresServer(0);
  try {
    server.setMode("DROP_ON_QUERY");
    const facts = await readMigrationGateFacts(server.connectionString);
    assert.equal(facts.reachable, false);
    assert.equal(facts.appliedMigrationNames, null);
    assert.equal(facts.databaseName, null);
    assert.equal(facts.stampAvailable, false);
  } finally {
    await server.close();
  }
});
