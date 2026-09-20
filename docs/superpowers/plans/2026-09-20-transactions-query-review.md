# Transactions and Query Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project creation atomically persist both the project and its internal creation audit record, retain the existing project-query indexes after an evidence-based review, and close the remaining Phase 4 edge-case coverage.

**Architecture:** Migration 006 adds an internal `project_audit_log` table. `projectService.createProject()` keeps validation and trusted ownership logic, while `projectRepository.createProject()` checks out one `pg` client and owns `BEGIN`, both parameterized inserts, `COMMIT`, rollback handling, and release. Existing project reads and HTTP response shapes do not change.

**Tech Stack:** Node.js CommonJS, Express 5, PostgreSQL, `pg`, Node's built-in test runner

**Spec:** `docs/superpowers/specs/2026-09-20-transactions-query-review-design.md`

## Global Constraints

- Preserve all Phase 1–4 Block 2 authentication, role, ownership, CRUD, migration, JOIN, pagination, filtering, search, and sorting behavior.
- Derive project `owner_id` and audit `actor_user_id` only from the authenticated actor.
- Use one checked-out PostgreSQL client for the entire project-creation transaction and release it in `finally`.
- Keep SQL in the repository and transaction-independent validation in the service.
- Add schema changes only through migration `006_project_audit_log.sql`; do not alter or delete existing data.
- Do not add project-query indexes without evidence; do not add trigram/full-text extensions.
- Do not add Redis, background jobs, WebSockets, Docker, deployment configuration, or an audit HTTP endpoint.
- Add beginner-friendly comments around transaction and database concepts.

## Review Focus

- The project insert succeeds but the audit insert fails: neither row persists, `ROLLBACK` runs, and the original error is preserved.
- `COMMIT` or `ROLLBACK` fails: the checked-out client is still released exactly once.
- A signed request tries to supply a different owner: both project owner and audit actor still use `req.user.userId`.
- `limit=100` is accepted while `limit=101`, repeated values, unsafe integers, and injection-like sort/order values are rejected before SQL.
- Deleting a project or user later sets audit foreign keys to NULL while retaining the audit snapshots.

---

## File Structure

- Create `migrations/006_project_audit_log.sql`: additive audit-table schema and integrity constraints.
- Modify `tests/databaseMigrations.test.js`: migration list, audit schema, preservation, and nullable-FK behavior.
- Modify `src/repositories/projectRepository.js`: atomic project-plus-audit creation using one client.
- Modify `tests/projectRepository.test.js`: transaction command order, parameter binding, rollback, and release tests.
- Modify `tests/projects.test.js`: adapt HTTP create mocks/assertions to the transaction and preserve trusted actor behavior.
- Create `tests/projectTransactionDatabase.test.js`: real PostgreSQL commit and post-first-write rollback verification in an isolated schema.
- Modify `tests/projectQueryService.test.js`: maximum-limit and boundary coverage.
- Verify `tests/projectQueryDatabase.test.js`: retain its real pagination, filtering, search, sorting, ownership, admin, and legacy coverage without changing it.
- Modify `BACKEND_CONCEPTS.txt`: beginner explanation of atomicity, one-client transactions, rollback, and release.

### Task 1: Audit Table Migration

**Files:**
- Create: `migrations/006_project_audit_log.sql`
- Modify: `tests/databaseMigrations.test.js`

**Interfaces:**
- Consumes: the existing filename-ordered migration runner and existing `users(id)` / `projects(id)` tables.
- Produces: `project_audit_log(id, project_id, action, actor_user_id, project_name, environment, created_at)` for Task 2.

- [ ] **Step 1: Extend the migration integration test with the expected filename and audit schema assertions**

Update the first-run expectation to include `006_project_audit_log.sql`, then add a test that inserts a user, project, and audit row and verifies the row shape and constraints:

```js
test("audit migration preserves snapshots and nullable relationships", async () => {
    const user = await mainPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('Auditor', 'auditor@example.com', 'hash') RETURNING id"
    );
    const project = await mainPool.query(
        "INSERT INTO projects (name, environment, owner_id) VALUES ('Audited', 'production', $1) RETURNING id",
        [user.rows[0].id]
    );
    const audit = await mainPool.query(
        `INSERT INTO project_audit_log
            (project_id, action, actor_user_id, project_name, environment)
         VALUES ($1, 'created', $2, 'Audited', 'production')
         RETURNING id, project_id, action, actor_user_id, project_name, environment`,
        [project.rows[0].id, user.rows[0].id]
    );

    const { id: auditId, ...auditRow } = audit.rows[0];
    assert.match(auditId, /^\d+$/); // BIGSERIAL values arrive from pg as text.
    assert.deepEqual(auditRow, {
        project_id: project.rows[0].id,
        action: "created",
        actor_user_id: user.rows[0].id,
        project_name: "Audited",
        environment: "production"
    });

    await mainPool.query("DELETE FROM projects WHERE id = $1", [project.rows[0].id]);
    await mainPool.query("DELETE FROM users WHERE id = $1", [user.rows[0].id]);
    const retained = await mainPool.query(
        "SELECT project_id, actor_user_id, project_name FROM project_audit_log WHERE id = $1",
        [auditId]
    );
    assert.deepEqual(retained.rows[0], {
        project_id: null,
        actor_user_id: null,
        project_name: "Audited"
    });
});
```

Also assert unsupported `action` and `environment` values reject with PostgreSQL code `23514`.

- [ ] **Step 2: Run the migration test to verify RED**

Run: `node --test --test-concurrency=1 tests/databaseMigrations.test.js`

Expected: FAIL because migration 006 and `project_audit_log` do not exist.

- [ ] **Step 3: Add migration 006**

Create `migrations/006_project_audit_log.sql`:

```sql
-- The audit row is a required companion to project creation. Snapshot fields
-- preserve useful history even if the referenced user or project is deleted.
CREATE TABLE project_audit_log (
    id BIGSERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    action VARCHAR(20) NOT NULL
        CONSTRAINT project_audit_log_action_check CHECK (action = 'created'),
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    project_name VARCHAR(100) NOT NULL,
    environment VARCHAR(50) NOT NULL
        CONSTRAINT project_audit_log_environment_check
        CHECK (environment IN ('production', 'development')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- No extra index is added yet. Indexes speed reads but add work to every
-- INSERT/UPDATE/DELETE, and DevPulse has no audit-log lookup query today.
```

- [ ] **Step 4: Run migration tests to verify GREEN and repeated-run safety**

Run: `node --test --test-concurrency=1 tests/databaseMigrations.test.js tests/migrationRunner.test.js`

Expected: all migration tests pass; the second migration run skips 006 with the other recorded files.

- [ ] **Step 5: Commit the migration deliverable**

```powershell
git add -- migrations/006_project_audit_log.sql tests/databaseMigrations.test.js
git commit -m "feat: add project creation audit migration"
```

### Task 2: Transactional Project Creation Repository

**Files:**
- Modify: `tests/projectRepository.test.js`
- Modify: `src/repositories/projectRepository.js`

**Interfaces:**
- Consumes: `projectRepository.createProject({ name, environment, ownerId })` from the existing service.
- Produces: the same created-project return value while atomically inserting one `project_audit_log` row.

- [ ] **Step 1: Replace the single-query creation test with transaction tests**

Create a fake checked-out client that records `query()` calls and release count. Test success:

```js
test("createProject commits the project and audit record on one client", async () => {
    const calls = [];
    let releases = 0;
    const client = {
        query: async (sql, values) => {
            calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
            if (/^INSERT INTO projects/i.test(sql.trim())) {
                return { rows: [{ id: 8, name: "Owned", environment: "development", owner_id: 31 }] };
            }
            return { rows: [] };
        },
        release: () => { releases += 1; }
    };
    pool.connect = async () => client;

    const project = await projectRepository.createProject({
        name: "Owned", environment: "development", ownerId: 31
    });

    assert.equal(project.id, 8);
    assert.deepEqual(calls.map((call) => call.sql.split(" ")[0]), [
        "BEGIN", "INSERT", "INSERT", "COMMIT"
    ]);
    assert.deepEqual(calls[1].values, ["Owned", "development", 31]);
    assert.deepEqual(calls[2].values, [8, 31, "Owned", "development"]);
    assert.equal(releases, 1);
});
```

Test an audit insert failure after the project insert. Assert `ROLLBACK` appears,
`COMMIT` does not, the original error object is rejected, and release count is one.
Add a commit-failure variant and assert rollback is attempted and release count
is one. Add a rollback-failure variant whose rollback query throws and still
assert the original audit error is reported and release count is one.

- [ ] **Step 2: Run repository tests to verify RED**

Run: `node --test --test-concurrency=1 tests/projectRepository.test.js`

Expected: FAIL because `createProject()` still uses `pool.query()` and does not emit transaction commands or an audit insert.

- [ ] **Step 3: Implement the one-client transaction**

Replace only `createProject()` with:

```js
const createProject = async (project) => {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
        // A transaction groups both writes into one all-or-nothing operation.
        await client.query("BEGIN");
        transactionStarted = true;

        const projectResult = await client.query(
            `INSERT INTO projects (name, environment, owner_id)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [project.name, project.environment, project.ownerId]
        );
        const createdProject = projectResult.rows[0];

        await client.query(
            `INSERT INTO project_audit_log
                (project_id, action, actor_user_id, project_name, environment)
             VALUES ($1, 'created', $2, $3, $4)`,
            [createdProject.id, project.ownerId, project.name, project.environment]
        );

        await client.query("COMMIT");
        return createdProject;
    } catch (error) {
        if (transactionStarted) {
            try {
                await client.query("ROLLBACK");
            } catch {
                // Preserve the original write failure; finally still releases
                // the connection so it cannot leak from the pool.
            }
        }
        throw error;
    } finally {
        client.release();
    }
};
```

- [ ] **Step 4: Run repository and service authorization tests**

Run: `node --test --test-concurrency=1 tests/projectRepository.test.js tests/projectServiceAuthorization.test.js`

Expected: all tests pass, including JWT-derived ownership and non-transferable ownership.

- [ ] **Step 5: Commit the repository transaction**

```powershell
git add -- src/repositories/projectRepository.js tests/projectRepository.test.js
git commit -m "feat: create projects and audit records atomically"
```

### Task 3: HTTP and Real PostgreSQL Transaction Verification

**Files:**
- Modify: `tests/projects.test.js`
- Create: `tests/projectTransactionDatabase.test.js`

**Interfaces:**
- Consumes: transactional `projectRepository.createProject()` from Task 2 and migration 006 from Task 1.
- Produces: end-to-end evidence that HTTP creation preserves its response while PostgreSQL commits or rolls back both writes.

- [ ] **Step 1: Update the HTTP pool fake for checked-out clients**

Save/restore `pool.connect` alongside `pool.query`. Return a fake client whose
`query()` forwards to the existing `answer(sql, values)` test callback while
recording calls, and whose `release()` increments a counter.

Update create assertions to expect:

```js
assert.deepEqual(
    calls.map((call) => call.sql.replace(/\s+/g, " ").trim().split(" ")[0]),
    ["BEGIN", "INSERT", "INSERT", "COMMIT"]
);
assert.deepEqual(calls[1].values, ["New", "development", 1]);
assert.deepEqual(calls[2].values, [41, 1, "New", "development"]);
```

Retain the test that body `owner_id` and `userId` are ignored; assert both the
project insert and audit insert use authenticated user ID 31.

- [ ] **Step 2: Run the HTTP suite to verify the test harness is RED before adaptation is complete**

Run: `node --test --test-concurrency=1 tests/projects.test.js`

Expected: create-route tests fail until the fake client and transaction call assertions match the new repository contract.

- [ ] **Step 3: Add isolated real-PostgreSQL transaction tests**

In `tests/projectTransactionDatabase.test.js`, create a random safe schema,
run all migrations in it, insert one owner, and temporarily route
`sharedPool.connect` to the isolated schema pool.

For success, call:

```js
const created = await projectRepository.createProject({
    name: "Committed project",
    environment: "production",
    ownerId
});
```

Assert one project and one matching `created` audit row exist.

For rollback-after-first-write, add an isolated-schema trigger that raises an
exception before audit insertion when `NEW.project_name = 'Rollback project'`.
Call `createProject()` and assert rejection, then assert both counts are zero:

```sql
SELECT COUNT(*) FROM projects WHERE name = 'Rollback project';
SELECT COUNT(*) FROM project_audit_log WHERE project_name = 'Rollback project';
```

Always restore `sharedPool.connect`, end the isolated pool, drop only the
validated random schema, and end the admin/shared pools in test teardown.

- [ ] **Step 4: Run HTTP and real transaction tests to verify GREEN**

Run: `node --test --test-concurrency=1 tests/projects.test.js tests/projectTransactionDatabase.test.js`

Expected: all tests pass; HTTP still returns 201 and the real failure leaves zero rows.

- [ ] **Step 5: Commit end-to-end transaction coverage**

```powershell
git add -- tests/projects.test.js tests/projectTransactionDatabase.test.js
git commit -m "test: verify project creation transaction end to end"
```

### Task 4: Query Boundaries, Index Review, and Final Verification

**Files:**
- Modify: `tests/projectQueryService.test.js`
- Modify: `BACKEND_CONCEPTS.txt`

**Interfaces:**
- Consumes: existing `projectService.getProjects(rawQuery, actor)` and `projectRepository.queryProjects(query)` contracts.
- Produces: complete Block 3 edge-case evidence without changing the Block 2 API.

- [ ] **Step 1: Add the exact maximum-limit boundary test**

```js
test("limit 100 is accepted and produces the correct offset", async () => {
    let received;
    projectRepository.queryProjects = async (query) => {
        received = query;
        return { projects: [], total: 205 };
    };

    const result = await projectService.getProjects(
        { page: "2", limit: "100" },
        { userId: 31, role: "user" }
    );

    assert.equal(received.limit, 100);
    assert.equal(received.offset, 100);
    assert.equal(result.totalPages, 3);
});
```

Add the explicit lower-bound test:

```js
test("page 1 and limit 1 are accepted lower boundaries", async () => {
    let received;
    projectRepository.queryProjects = async (query) => {
        received = query;
        return { projects: [], total: 0 };
    };

    await projectService.getProjects(
        { page: "1", limit: "1" },
        { userId: 31, role: "user" }
    );

    assert.equal(received.page, 1);
    assert.equal(received.limit, 1);
    assert.equal(received.offset, 0);
});
```

Retain the existing `limit=101` rejection. Do not duplicate existing invalid
environment, sort/order injection, blank search, empty result, owner/admin,
legacy NULL owner, or out-of-range page tests; verify those test names instead.

- [ ] **Step 2: Run all query-focused tests**

Run: `node --test --test-concurrency=1 tests/projectQueryService.test.js tests/projectQueryRepository.test.js tests/projectQueryDatabase.test.js`

Expected: all tests pass, including the exact maximum and existing security boundaries.

- [ ] **Step 3: Document the transaction and index decision for learners**

Append a concise section to `BACKEND_CONCEPTS.txt` explaining:

```text
POSTGRESQL TRANSACTIONS
- BEGIN starts one all-or-nothing unit of work.
- COMMIT makes every successful write permanent.
- ROLLBACK undoes writes made since BEGIN when a later step fails.
- Every statement must use the same checked-out client; separate pool.query()
  calls could run on different connections and therefore different transactions.
- finally releases the client on both success and failure.

INDEX REVIEW
- The primary key index supports ID lookup.
- idx_projects_owner_id supports mandatory normal-user ownership filtering.
- Environment has only two values, and leading-wildcard ILIKE cannot use a
  normal B-tree effectively.
- Extra indexes were not added because they would slow writes without measured
  evidence that their read benefit is needed.
```

- [ ] **Step 4: Run migration command and complete suite**

Run: `npm run migrate`

Expected: migration 006 applies once, or is reported as already applied on a previously migrated database.

Run: `npm test`

Expected: every test passes with zero failures.

- [ ] **Step 5: Inspect final scope and whitespace**

Run:

```powershell
git diff --check -- migrations/006_project_audit_log.sql src/repositories/projectRepository.js tests/databaseMigrations.test.js tests/projectRepository.test.js tests/projects.test.js tests/projectTransactionDatabase.test.js tests/projectQueryService.test.js BACKEND_CONCEPTS.txt
git status --short
```

Expected: no whitespace errors in Block 3 files; unrelated pre-existing dirty files remain untouched.

- [ ] **Step 6: Commit documentation and boundary coverage**

```powershell
git add -- tests/projectQueryService.test.js BACKEND_CONCEPTS.txt
git commit -m "test: complete phase four database edge coverage"
```

- [ ] **Step 7: Request final code review**

Ask a read-only reviewer to inspect the Block 3 commit range for transaction
correctness, client leaks, rollback error handling, migration integrity,
authorization preservation, index restraint, and test completeness. Address
important findings with a failing regression test first, then rerun `npm test`.
