# DevPulse Database Engineering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, tracked PostgreSQL migrations, database integrity constraints and indexes, plus a password-safe project/owner JOIN without changing existing authorization behavior.

**Architecture:** A small CommonJS migration runner reads ordered SQL files, serializes concurrent runners with a PostgreSQL advisory lock, and records each successfully committed filename in `schema_migrations`. Additive SQL migrations preserve the inspected live data and work for a fresh database, while repository and integration tests verify the schema and LEFT JOIN against real PostgreSQL behavior.

**Tech Stack:** Node.js CommonJS, PostgreSQL, `pg`, Node's built-in `node:test`, SQL catalog queries.

**Spec:** `docs/superpowers/specs/2026-09-19-database-engineering-design.md`

## Global Constraints

- Use the existing `pg` dependency; add no migration framework dependency.
- Preserve all existing user and project rows; never drop or recreate either table.
- Keep `projects.owner_id` nullable for legacy projects.
- Never expose `users.password_hash` from the project/owner JOIN.
- Do not alter existing routes, authentication, authorization, or ownership policy.
- Do not implement pagination, filtering, sorting, search, Redis, or application transaction features.
- Add beginner-friendly comments for migration tracking, constraints, indexes, LEFT JOIN semantics, and index write cost.
- Preserve unrelated uncommitted working-tree changes.

## Review Focus

- A migration file that throws halfway through must leave neither schema changes nor a history row; Task 1 tests rollback using a deliberately failing temporary migration.
- Two calls against an already migrated schema must not apply SQL twice; Task 1 tests first-run `applied` and second-run `skipped` results plus unique history rows.
- Existing environments outside the allowed set must never be silently modified; Task 2 tests that the constraint migration rejects invalid legacy data and preserves it after rollback.
- An equivalent owner index with a nonstandard name must not be duplicated; Task 2 tests catalog-based index reuse.
- A legacy project with null ownership must survive both migration and JOIN retrieval; Tasks 2 and 3 assert null owner fields and unchanged project identity.

---

### Task 1: Tracked Migration Runner

**Files:**
- Create: `src/database/migrate.js`
- Create: `tests/migrationRunner.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: a `pg.Pool`-compatible object exposing `connect()`, and a directory of `.sql` files.
- Produces: `listMigrationFiles(migrationsDirectory): Promise<string[]>` and `runMigrations({ pool, migrationsDirectory }): Promise<{ applied: string[], skipped: string[] }>`.
- CLI: `npm run migrate` calls `node src/database/migrate.js` with the shared pool and top-level `migrations` directory.

- [ ] **Step 1: Write failing runner tests**

Create `tests/migrationRunner.test.js`. Use a real temporary directory under `os.tmpdir()` for ordered SQL fixtures and a small fake pool/client that records SQL and supplies history rows. Assert:

```js
test("lists only ordered SQL migration files", async () => {
    assert.deepEqual(await listMigrationFiles(directory), [
        "001_first.sql",
        "002_second.sql"
    ]);
});

test("applies pending files and reports already recorded files as skipped", async () => {
    const result = await runMigrations({ pool, migrationsDirectory: directory });
    assert.deepEqual(result, {
        applied: ["002_second.sql"],
        skipped: ["001_first.sql"]
    });
    assert.equal(recordedSql.includes("BEGIN"), true);
    assert.equal(recordedSql.includes("COMMIT"), true);
});

test("rolls back a failed migration without recording it", async () => {
    await assert.rejects(
        runMigrations({ pool: failingPool, migrationsDirectory: directory }),
        /002_second\.sql/
    );
    assert.equal(recordedSql.includes("ROLLBACK"), true);
    assert.equal(insertedMigrationNames.includes("002_second.sql"), false);
});
```

Also assert that the runner acquires/releases the same advisory lock, creates `schema_migrations` before reading history, releases the client in `finally`, ignores non-SQL files, and rejects duplicate migration basenames case-insensitively so Windows and Linux produce the same order.

- [ ] **Step 2: Run runner tests and verify RED**

Run: `node --test tests/migrationRunner.test.js`

Expected: FAIL with `Cannot find module '../src/database/migrate'`.

- [ ] **Step 3: Implement the runner**

Create `src/database/migrate.js` with these core functions and constants:

```js
const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../config/db");

const MIGRATION_LOCK_ID = 437_004;
const defaultMigrationsDirectory = path.resolve(__dirname, "../../migrations");

const listMigrationFiles = async (migrationsDirectory) => {
    const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, "en"));

    const normalized = files.map((name) => name.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
        throw new Error("Migration filenames must be unique regardless of letter case");
    }
    return files;
};
```

`runMigrations` must connect once, acquire `pg_advisory_lock($1)`, create:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

Read recorded filenames, then for each pending file read UTF-8 SQL and execute `BEGIN`, SQL, parameterized history insert, and `COMMIT`. On failure, issue `ROLLBACK` and throw `Migration <filename> failed: <message>` with the original error as `cause`. Always run `pg_advisory_unlock($1)` and `client.release()` in nested `finally` blocks.

The CLI branch logs each applied/skipped filename, sets `process.exitCode = 1` on error, and always awaits `pool.end()` without calling `process.exit()`.

- [ ] **Step 4: Add the npm command**

Modify the scripts object in `package.json` to be:

```json
"scripts": {
  "migrate": "node src/database/migrate.js",
  "test": "node --test"
}
```

- [ ] **Step 5: Run runner tests and verify GREEN**

Run: `node --test tests/migrationRunner.test.js`

Expected: all migration-runner tests pass with no warnings.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json src/database/migrate.js tests/migrationRunner.test.js
git commit -m "feat: add tracked PostgreSQL migration runner"
```

### Task 2: Additive Schema, Constraints, and Index Migrations

**Files:**
- Create: `migrations/001_current_schema.sql`
- Create: `migrations/002_project_ownership.sql`
- Create: `migrations/003_project_environment_constraint.sql`
- Create: `migrations/004_project_owner_index.sql`
- Create: `tests/databaseMigrations.test.js`

**Interfaces:**
- Consumes: `runMigrations({ pool, migrationsDirectory })` from Task 1 and the configured PostgreSQL database environment.
- Produces: current schema on a fresh database; nullable ownership FK with `ON DELETE SET NULL`; valid-environment check; one useful owner index; tracked migration rows.

- [ ] **Step 1: Write failing PostgreSQL integration tests**

Create `tests/databaseMigrations.test.js`. Build an administrative `Pool` from `DB_USER`, `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, and numeric `DB_PORT`. Generate a schema name matching `^devpulse_migration_test_[a-f0-9]+$`, create it with a safely quoted identifier, and create a second pool with PostgreSQL `options: "-c search_path=<schema>"`. Cleanup must verify the regex again before running `DROP SCHEMA <quoted-name> CASCADE`.

Before migration, create the inspected legacy tables and insert one project. Then assert:

```js
const first = await runMigrations({ pool: schemaPool, migrationsDirectory });
const second = await runMigrations({ pool: schemaPool, migrationsDirectory });

assert.equal(first.applied.length, 4);
assert.equal(second.applied.length, 0);
assert.equal(second.skipped.length, 4);
assert.equal((await schemaPool.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count, 4);
```

Add focused tests using savepoints or cleanup rows between assertions:

- legacy project ID/name/environment is unchanged and `owner_id` is null;
- duplicate email raises PostgreSQL code `23505`;
- invalid environment raises `23514`;
- nonexistent `owner_id` raises `23503`;
- deleting a user changes their project's `owner_id` to null;
- catalog queries show the existing PK/unique constraints, exactly one FK with delete action `n`, exactly one check on environment, and one single-column owner index;
- a separate temporary schema containing an invalid legacy environment causes migration 003 to fail and retains the invalid row with no 003 history entry;
- a separate temporary schema with an equivalent differently named single-column owner index runs migration 004 without adding a second owner index.

- [ ] **Step 2: Run database migration tests and verify RED**

Run: `node --test tests/databaseMigrations.test.js`

Expected: FAIL because the `migrations` directory/files do not exist.

- [ ] **Step 3: Add baseline schema migration**

Create `migrations/001_current_schema.sql` with comments explaining that migrations describe schema history and `IF NOT EXISTS` preserves existing tables/data:

```sql
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    environment VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 4: Add ownership migration**

Create `migrations/002_project_ownership.sql`. Add `owner_id INTEGER` with `ADD COLUMN IF NOT EXISTS`. In a `DO` block, inspect `pg_constraint`, `pg_attribute`, `conkey`, `confrelid`, and `confdeltype`. Reuse any equivalent FK. If an owner-to-users FK exists with another delete action, drop it by safely formatted constraint name, then add:

```sql
ALTER TABLE projects
ADD CONSTRAINT projects_owner_id_fkey
FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
```

Comments must explain referential integrity, why null is allowed, and why `SET NULL` preserves projects when a user is deleted.

- [ ] **Step 5: Add environment constraint migration**

Create `migrations/003_project_environment_constraint.sql`. In a `DO` block, inspect check constraints attached to the `environment` attribute and reuse an equivalent constraint whose normalized definition admits only `production` and `development`. Otherwise add:

```sql
ALTER TABLE projects
ADD CONSTRAINT projects_environment_check
CHECK (environment IN ('production', 'development'));
```

Do not update invalid rows. Let PostgreSQL fail so the runner rolls back the migration and leaves the data visible for correction.

- [ ] **Step 6: Add owner index migration**

Create `migrations/004_project_owner_index.sql`. In a `DO` block, inspect `pg_index`/`pg_attribute` for an existing valid, non-partial, single-column index whose only key is `projects.owner_id`. Create `idx_projects_owner_id` only when none exists.

Include comments explaining that a B-tree is a separate lookup structure useful for `WHERE owner_id = ...`, while every index consumes space and adds maintenance work to `INSERT`, `UPDATE`, and `DELETE`, so low-value indexes are intentionally omitted.

- [ ] **Step 7: Run migration integration tests and verify GREEN**

Run: `node --test tests/databaseMigrations.test.js`

Expected: all tests pass; each test schema is removed in cleanup.

- [ ] **Step 8: Apply migrations to the configured DevPulse database**

Run: `npm run migrate`

Expected: four migrations apply, the existing project remains present, and a subsequent `npm run migrate` reports all four as skipped.

- [ ] **Step 9: Commit Task 2**

```bash
git add migrations tests/databaseMigrations.test.js
git commit -m "feat: migrate database constraints and indexes"
```

### Task 3: Password-Safe Project Owner JOIN

**Files:**
- Modify: `src/repositories/projectRepository.js`
- Create: `tests/projectOwnerJoin.test.js`

**Interfaces:**
- Consumes: the migrated `projects.owner_id -> users.id` relationship.
- Produces: `getProjectsWithOwners(): Promise<Array<{ project_id, project_name, environment, owner_id, owner_name, owner_email }>>`.

- [ ] **Step 1: Write failing JOIN repository tests**

Create `tests/projectOwnerJoin.test.js`. Temporarily replace `pool.query`, restore it in `afterEach`, and assert returned rows include both an owned and legacy project:

```js
assert.deepEqual(await projectRepository.getProjectsWithOwners(), [
    {
        project_id: 1,
        project_name: "Legacy",
        environment: "development",
        owner_id: null,
        owner_name: null,
        owner_email: null
    },
    {
        project_id: 2,
        project_name: "API",
        environment: "production",
        owner_id: 7,
        owner_name: "Ada",
        owner_email: "ada@example.com"
    }
]);
```

Normalize captured SQL and assert it contains `FROM projects AS p LEFT JOIN users AS u ON u.id = p.owner_id`, selects the six explicit aliases, ends with `ORDER BY p.id`, contains no `SELECT *`, and contains no `password_hash`.

- [ ] **Step 2: Run JOIN tests and verify RED**

Run: `node --test tests/projectOwnerJoin.test.js`

Expected: FAIL because `getProjectsWithOwners` is not exported.

- [ ] **Step 3: Implement the JOIN**

Add this repository function with beginner-friendly comments:

```js
const getProjectsWithOwners = async () => {
    const result = await pool.query(
        `SELECT
             p.id AS project_id,
             p.name AS project_name,
             p.environment,
             u.id AS owner_id,
             u.name AS owner_name,
             u.email AS owner_email
         FROM projects AS p
         LEFT JOIN users AS u ON u.id = p.owner_id
         ORDER BY p.id`
    );
    return result.rows;
};
```

Explain that `LEFT JOIN` retains unowned legacy projects, explicit columns form a safe output boundary, and omitting `password_hash` prevents credential data from leaving the user table. Export the function without changing existing repository functions.

- [ ] **Step 4: Run JOIN tests and verify GREEN**

Run: `node --test tests/projectOwnerJoin.test.js`

Expected: all JOIN tests pass.

- [ ] **Step 5: Verify the JOIN against the migrated PostgreSQL schema**

Extend `tests/databaseMigrations.test.js` to insert one user, one owned project, and retain the legacy null-owner project. Set the temporary schema in a checked-out client, temporarily route repository queries through that client, call `getProjectsWithOwners()`, and assert safe owner fields/null legacy fields plus `Object.hasOwn(row, "password_hash") === false` for every row.

Run: `node --test tests/databaseMigrations.test.js tests/projectOwnerJoin.test.js`

Expected: all migration and JOIN integration tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/repositories/projectRepository.js tests/projectOwnerJoin.test.js tests/databaseMigrations.test.js
git commit -m "feat: join projects with safe owner details"
```

### Task 4: Full Verification and Documentation Check

**Files:**
- Modify only files found defective by verification, with a failing regression test first for behavior changes.

**Interfaces:**
- Consumes: all Task 1–3 deliverables.
- Produces: verified migration command, schema, repository behavior, and complete test count for the handoff report.

- [ ] **Step 1: Check modified files and package metadata**

Run:

```bash
git diff --check
npm ls --depth=0
```

Expected: no new whitespace errors and installed dependencies match `package.json`.

- [ ] **Step 2: Run migrations a final time**

Run: `npm run migrate`

Expected: exit code 0 and every migration is reported as skipped, proving repeat safety.

- [ ] **Step 3: Inspect the configured database**

Run a read-only Node/`pg` catalog query that reports migration filenames,
constraint definitions, indexes, and project count. Confirm four unique history
rows, the owner FK uses `ON DELETE SET NULL`, the environment check exists, the
owner index exists once, and the original project count did not decrease.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test tests/migrationRunner.test.js tests/databaseMigrations.test.js tests/projectOwnerJoin.test.js
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 5: Run the complete suite**

Run: `npm test`

Expected: all Phase 1–4 tests pass with zero failures. Record the exact test count from fresh output for the final report.

- [ ] **Step 6: Review the final diff against the specification**

Run:

```bash
git status --short
git diff --stat HEAD~3
git diff HEAD~3 -- package.json src/database/migrate.js migrations src/repositories/projectRepository.js tests/migrationRunner.test.js tests/databaseMigrations.test.js tests/projectOwnerJoin.test.js
```

Confirm every specification requirement has an implementation/test, no deferred feature was added, and pre-existing unrelated changes remain untouched.

- [ ] **Step 7: Commit verification-only corrections if any**

If verification required a correction, stage only its exact files and commit:

```bash
git commit -m "test: complete database engineering verification" -- <exact-files>
```

If no correction was required, do not create an empty commit.
