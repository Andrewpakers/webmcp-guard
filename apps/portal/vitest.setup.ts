/**
 * Runs before every portal test file.
 *
 * `lib/db/connection.ts` reads `PORTAL_DB_PATH` when it opens the singleton, so
 * setting it here keeps the whole suite on a throwaway in-memory database — the
 * developer's seeded `data/portal.db` is never read or mutated by tests.
 */
process.env.PORTAL_DB_PATH = ":memory:";
