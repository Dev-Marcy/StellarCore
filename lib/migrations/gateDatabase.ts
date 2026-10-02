/**
 * Target-database facts for the backup gate (#188).
 *
 * Read-only inspection of the database the migration is about to touch:
 * - which migrations are already applied (`_prisma_migrations`),
 * - the instance identity (`current_database()`),
 * - the durable environment stamp from #143 (`database_environment`).
 *
 * Safety properties:
 * - The session issues only constant, parameter-free SELECT statements —
 *   there is no interpolation of any external value into SQL text.
 * - Every failure maps to a bounded, secret-free fact shape; the gate's
 *   decision logic fails closed when any fact is unreadable.
 * - The connection string is used for connecting only and is never printed,
 *   logged, or returned.
 */

import { Pool } from "pg";

/** Constant SQL texts. No parameter binding is ever required. */
export const GATE_SQL = Object.freeze({
  appliedMigrations:
    'SELECT "migration_name" AS migration_name, "rolled_back_at" AS rolled_back_at FROM "_prisma_migrations"',
  databaseName: "SELECT current_database() AS database_name",
  environmentStamp:
    'SELECT "environment" AS environment FROM "database_environment" WHERE "id" = 1',
});

export type MigrationGateDatabaseFacts = Readonly<
  | {
      reachable: true;
      appliedMigrationNames: readonly string[];
      databaseName: string;
      /** Raw stamp value; null when the table exists but holds no row. */
      stampEnvironment: string | null;
      stampAvailable: boolean;
      /** Bounded driver error code from a partially failed read, if any. */
      errorCode: string | null;
    }
  | {
      reachable: false;
      appliedMigrationNames: null;
      databaseName: null;
      stampEnvironment: null;
      stampAvailable: false;
      errorCode: string;
    }
>;

const UNREACHABLE: MigrationGateDatabaseFacts = Object.freeze({
  reachable: false,
  appliedMigrationNames: null,
  databaseName: null,
  stampEnvironment: null,
  stampAvailable: false,
  errorCode: "DATABASE_UNAVAILABLE",
});

function isMissingRelation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function boundedErrorCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : "DATABASE_UNAVAILABLE";
}

/**
 * Reads the gate facts from the target database. Never throws: an
 * unreachable database or an invalid connection string produces the
 * `reachable: false` shape so the gate can block with FAIL_DATABASE_READ.
 */
export async function readMigrationGateFacts(
  connectionString: string | undefined,
): Promise<MigrationGateDatabaseFacts> {
  if (!connectionString) return UNREACHABLE;

  try {
    const protocol = new URL(connectionString).protocol;
    if (protocol !== "postgres:" && protocol !== "postgresql:") {
      return UNREACHABLE;
    }
  } catch {
    return UNREACHABLE;
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  });

  // Idle-client failures must never crash the process: the query path below
  // already maps every failure to the unreachable fact shape (fail closed).
  pool.on("error", () => undefined);

  try {
    const client = await pool.connect();
    // A checked-out client must have an error listener, otherwise a dropped
    // connection would surface as an unhandled 'error' emission and crash
    // the process. The query path below maps the same failure to the
    // unreachable fact shape instead.
    client.on("error", () => undefined);
    try {
      // A missing _prisma_migrations table means a fresh database: nothing
      // has been applied yet, which is a valid (not failed) read.
      let appliedMigrationNames: string[] = [];
      try {
        const applied = await client.query<{
          migration_name: string;
          rolled_back_at: Date | null;
        }>(GATE_SQL.appliedMigrations);
        appliedMigrationNames = applied.rows
          .filter((row) => row.rolled_back_at === null)
          .map((row) => row.migration_name);
      } catch (error) {
        if (!isMissingRelation(error)) {
          return {
            reachable: false,
            appliedMigrationNames: null,
            databaseName: null,
            stampEnvironment: null,
            stampAvailable: false,
            errorCode: boundedErrorCode(error),
          };
        }
      }

      const nameRow = await client.query<{ database_name: string }>(
        GATE_SQL.databaseName,
      );
      const databaseName = nameRow.rows[0]?.database_name;
      if (!databaseName) return UNREACHABLE;

      let stampEnvironment: string | null = null;
      let stampAvailable = true;
      try {
        const stamp = await client.query<{ environment: string }>(
          GATE_SQL.environmentStamp,
        );
        stampEnvironment = stamp.rows[0]?.environment ?? null;
      } catch (error) {
        if (isMissingRelation(error)) {
          stampAvailable = false;
        } else {
          return {
            reachable: false,
            appliedMigrationNames: null,
            databaseName: null,
            stampEnvironment: null,
            stampAvailable: false,
            errorCode: boundedErrorCode(error),
          };
        }
      }

      return {
        reachable: true,
        appliedMigrationNames,
        databaseName,
        stampEnvironment,
        stampAvailable,
        errorCode: null,
      };
    } finally {
      client.release();
    }
  } catch {
    return UNREACHABLE;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
