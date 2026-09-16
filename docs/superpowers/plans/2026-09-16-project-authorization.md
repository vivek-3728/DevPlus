# DevPulse Project Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect every project endpoint with JWT authentication, reusable role authorization, and owner-or-admin project access while preserving the existing unowned project.

**Architecture:** Express routes will authenticate the JWT and allow only the existing `user` and `admin` roles before controllers run. Controllers pass the trusted `req.user` identity into services, services enforce ownership, repositories use parameterized owner-aware SQL, and an additive PostgreSQL migration introduces nullable ownership for legacy data.

**Tech Stack:** Node.js CommonJS, Express 5, PostgreSQL through `pg`, `jsonwebtoken`, `node:test`, bcrypt authentication already present.

**Spec:** `docs/superpowers/specs/2026-09-16-project-authorization-design.md`

## Global Constraints

- Preserve the existing project row as unowned with `owner_id = NULL`.
- Add `projects.owner_id` as nullable, reference `users(id)`, use `ON DELETE SET NULL`, and index the column.
- New projects always use `req.user.userId`; never trust `owner_id` or `userId` from request JSON.
- Normal users can access only their own projects and receive `403` for existing unowned or other-user projects.
- Admins can list and manage all projects, including the legacy unowned project.
- Use only the existing roles `user` and `admin`.
- Keep registration, login, JWT authentication, `/api/auth/me`, existing validation, and unrelated functionality unchanged.
- Continue using parameterized SQL and add beginner-friendly comments around authentication, authorization, ownership, foreign keys, and `403` behavior.

## File Structure

- Create `database/migrations/001_add_project_owner.sql`: idempotent ownership column, foreign key, and index migration.
- Create `scripts/runMigration.js`: apply one SQL migration transactionally with the existing database pool.
- Modify `package.json`: expose the ownership migration as `npm run migrate:project-ownership`.
- Create `tests/projectOwnershipMigration.test.js`: lock down the migration's nullable column, FK action, and index.
- Create `src/middleware/authorizeRoles.js`: reusable role authorization middleware factory.
- Create `tests/authorization.test.js`: verify allowed and forbidden roles through Express.
- Modify `src/repositories/projectRepository.js`: add owner-filtered listing and owned creation.
- Create `tests/projectRepository.test.js`: verify parameterized ownership queries.
- Modify `src/services/projectService.js`: select lists by role and enforce owner-or-admin access.
- Create `tests/projectServiceAuthorization.test.js`: verify owner, other-user, unowned, admin, missing-row, and trusted-owner behavior.
- Modify `src/controllers/projectController.js`: pass `req.user` to every project service call.
- Modify `src/routes/projectRoutes.js`: run authentication and role authorization before project controllers.
- Modify `tests/projects.test.js`: authenticate all existing CRUD requests and add HTTP authorization coverage.
- Modify `BACKEND_CONCEPTS.txt`: explain authentication versus authorization, roles, ownership, foreign keys, and the protected request flow.

---

### Task 1: Add the Additive Project Ownership Migration

**Files:**
- Create: `database/migrations/001_add_project_owner.sql`
- Create: `scripts/runMigration.js`
- Modify: `package.json`
- Test: `tests/projectOwnershipMigration.test.js`

**Interfaces:**
- Consumes: existing `src/config/db.js` PostgreSQL `Pool` export and the existing `users(id)` primary key.
- Produces: nullable `projects.owner_id`, constraint `projects_owner_id_fkey`, index `idx_projects_owner_id`, and npm script `migrate:project-ownership`.

- [ ] **Step 1: Write the failing migration contract test**

Create `tests/projectOwnershipMigration.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationPath = path.join(
    __dirname,
    "..",
    "database",
    "migrations",
    "001_add_project_owner.sql"
);

test("ownership migration is additive, indexed, and preserves projects when a user is deleted", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");

    assert.match(sql, /ADD COLUMN IF NOT EXISTS owner_id INTEGER/i);
    assert.doesNotMatch(sql, /owner_id INTEGER NOT NULL/i);
    assert.match(sql, /FOREIGN KEY \(owner_id\) REFERENCES users\(id\) ON DELETE SET NULL/i);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects\(owner_id\)/i);
    assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM projects/i);
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `node --test tests/projectOwnershipMigration.test.js`

Expected: FAIL with `ENOENT` because the migration file does not exist.

- [ ] **Step 3: Create the idempotent SQL migration**

Create `database/migrations/001_add_project_owner.sql`:

```sql
-- Existing rows remain valid because owner_id is nullable. New API-created
-- projects always receive an authenticated owner in application code.
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS owner_id INTEGER;

-- A foreign key prevents projects from pointing at users that do not exist.
-- ON DELETE SET NULL preserves project history if a user is deleted.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'projects_owner_id_fkey'
          AND conrelid = 'projects'::regclass
    ) THEN
        ALTER TABLE projects
        ADD CONSTRAINT projects_owner_id_fkey
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- Owner-filtered project lists use this index instead of scanning every row.
CREATE INDEX IF NOT EXISTS idx_projects_owner_id
ON projects(owner_id);
```

- [ ] **Step 4: Add a transactional migration runner and npm command**

Create `scripts/runMigration.js`:

```js
const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../src/config/db");

const migrationPath = path.join(
    __dirname,
    "..",
    "database",
    "migrations",
    "001_add_project_owner.sql"
);

const run = async () => {
    const sql = await fs.readFile(migrationPath, "utf8");
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
        console.log("Project ownership migration completed.");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
};

run().catch(error => {
    console.error("Project ownership migration failed:", error.message);
    process.exitCode = 1;
});
```

Add this exact script entry without changing `test`:

```json
"migrate:project-ownership": "node scripts/runMigration.js"
```

- [ ] **Step 5: Run the focused test and syntax checks**

Run: `node --test tests/projectOwnershipMigration.test.js`

Expected: 1 test passes.

Run: `node --check scripts/runMigration.js`

Expected: exit code 0 with no output.

- [ ] **Step 6: Commit the migration deliverable**

```bash
git add database/migrations/001_add_project_owner.sql scripts/runMigration.js package.json tests/projectOwnershipMigration.test.js
git commit -m "feat: add project ownership migration"
```

### Task 2: Add Reusable Role Authorization Middleware

**Files:**
- Create: `src/middleware/authorizeRoles.js`
- Create: `tests/authorization.test.js`

**Interfaces:**
- Consumes: `req.user = { userId, role }` from `src/middleware/authenticate.js` and `new Apperror(message, statusCode)`.
- Produces: `authorizeRoles(...allowedRoles)`, an Express middleware factory that calls `next()` for allowed roles and forwards `AppError("Forbidden", 403)` otherwise.

- [ ] **Step 1: Write HTTP tests for allowed and forbidden roles**

Create `tests/authorization.test.js` with an Express app whose test-only identity middleware sets `req.user` from an `x-test-role` header, followed by `authorizeRoles("admin")`:

```js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const authorizeRoles = require("../src/middleware/authorizeRoles");
const errorHandler = require("../src/middleware/errorHandler");

let server;
let url;

before(async () => {
    const app = express();
    app.get(
        "/admin-only",
        (req, res, next) => {
            req.user = { userId: 1, role: req.headers["x-test-role"] };
            next();
        },
        authorizeRoles("admin"),
        (req, res) => res.json({ allowed: true })
    );
    app.use(errorHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${server.address().port}/admin-only`;
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
});

test("authorizeRoles allows a configured role", async () => {
    const response = await fetch(url, { headers: { "x-test-role": "admin" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { allowed: true });
});

test("authorizeRoles returns 403 when a user attempts admin-only behavior", async () => {
    const response = await fetch(url, { headers: { "x-test-role": "user" } });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `node --test tests/authorization.test.js`

Expected: FAIL because `src/middleware/authorizeRoles.js` does not exist.

- [ ] **Step 3: Implement the middleware factory with learning comments**

Create `src/middleware/authorizeRoles.js`:

```js
const AppError = require("../errors/Apperror");

// Authentication establishes who the caller is. Authorization runs afterward
// and decides whether that authenticated role may perform this operation.
const authorizeRoles = (...allowedRoles) => (req, res, next) => {
    const role = req.user?.role;

    if (role && allowedRoles.includes(role)) {
        return next();
    }

    // 403 means the caller is authenticated but lacks permission.
    return next(new AppError("Forbidden", 403));
};

module.exports = authorizeRoles;
```

- [ ] **Step 4: Run the focused test and syntax check**

Run: `node --test tests/authorization.test.js`

Expected: 2 tests pass.

Run: `node --check src/middleware/authorizeRoles.js`

Expected: exit code 0.

- [ ] **Step 5: Commit the middleware deliverable**

```bash
git add src/middleware/authorizeRoles.js tests/authorization.test.js
git commit -m "feat: add role authorization middleware"
```

### Task 3: Add Parameterized Project Ownership Queries

**Files:**
- Modify: `src/repositories/projectRepository.js`
- Create: `tests/projectRepository.test.js`

**Interfaces:**
- Consumes: authenticated numeric owner IDs supplied by the service.
- Produces: `getProjectsByOwnerId(ownerId)` and `createProject({ name, environment, ownerId })`; preserves `getAllProjects()`, `getProjectById(id)`, `updateProject(id, project)`, and `deleteProject(id)`.

- [ ] **Step 1: Write repository tests for owner filtering and owned inserts**

Create `tests/projectRepository.test.js`. Save and restore `pool.query`, normalize SQL whitespace, and assert these two calls:

```js
test("getProjectsByOwnerId filters with a parameterized owner ID", async () => {
    pool.query = async (sql, values) => {
        captured = { sql: sql.replace(/\s+/g, " ").trim(), values };
        return { rows: [{ id: 7, owner_id: 31 }] };
    };

    const rows = await projectRepository.getProjectsByOwnerId(31);
    assert.deepEqual(rows, [{ id: 7, owner_id: 31 }]);
    assert.match(captured.sql, /^SELECT \* FROM projects WHERE owner_id = \$1 ORDER BY id$/i);
    assert.deepEqual(captured.values, [31]);
});

test("createProject stores the trusted owner with parameters", async () => {
    pool.query = async (sql, values) => {
        captured = { sql: sql.replace(/\s+/g, " ").trim(), values };
        return { rows: [{ id: 8, name: "Owned", environment: "development", owner_id: 31 }] };
    };

    const row = await projectRepository.createProject({
        name: "Owned",
        environment: "development",
        ownerId: 31
    });
    assert.equal(row.owner_id, 31);
    assert.match(captured.sql, /INSERT INTO projects \(name, environment, owner_id\) VALUES \(\$1, \$2, \$3\) RETURNING \*/i);
    assert.deepEqual(captured.values, ["Owned", "development", 31]);
});
```

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run: `node --test tests/projectRepository.test.js`

Expected: FAIL because `getProjectsByOwnerId` is missing and the insert omits `owner_id`.

- [ ] **Step 3: Implement the repository queries**

Add:

```js
const getProjectsByOwnerId = async (ownerId) => {
    const result = await pool.query(
        "SELECT * FROM projects WHERE owner_id = $1 ORDER BY id",
        [ownerId]
    );
    return result.rows;
};
```

Change the insert to:

```js
const result = await pool.query(
    `INSERT INTO projects (name, environment, owner_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [project.name, project.environment, project.ownerId]
);
```

Export `getProjectsByOwnerId` with the existing functions. Comments must explain that `$1`/`$2`/`$3` keep values separate from SQL text, that the owner ID came from a verified JWT, and that the foreign key guarantees the referenced user exists.

- [ ] **Step 4: Run repository tests and syntax checks**

Run: `node --test tests/projectRepository.test.js tests/userRepository.test.js`

Expected: all repository tests pass.

Run: `node --check src/repositories/projectRepository.js`

Expected: exit code 0.

- [ ] **Step 5: Commit the repository deliverable**

```bash
git add src/repositories/projectRepository.js tests/projectRepository.test.js
git commit -m "feat: add project ownership queries"
```

### Task 4: Enforce Owner-or-Admin Rules in the Service

**Files:**
- Modify: `src/services/projectService.js`
- Create: `tests/projectServiceAuthorization.test.js`

**Interfaces:**
- Consumes: actor objects shaped as `{ userId: number, role: "user" | "admin" }` and repository rows containing `owner_id`.
- Produces: `getAllProjects(actor)`, `getProjectById(id, actor)`, `createProject(name, environment, actor)`, `updateProject(id, name, environment, actor)`, and `deleteProject(id, actor)`.

- [ ] **Step 1: Write focused service authorization tests**

Create `tests/projectServiceAuthorization.test.js`, save and restore all replaced repository functions, and define:

```js
const owner = { userId: 31, role: "user" };
const otherUser = { userId: 44, role: "user" };
const admin = { userId: 1, role: "admin" };
const ownedProject = { id: 7, name: "Owned", environment: "development", owner_id: 31 };
const unownedProject = { ...ownedProject, id: 8, owner_id: null };
```

Add exact assertions that:

```js
await projectService.getAllProjects(owner);
assert.deepEqual(events, [["getProjectsByOwnerId", 31]]);

await projectService.getAllProjects(admin);
assert.deepEqual(events, [["getAllProjects"]]);

assert.deepEqual(await projectService.getProjectById("7", owner), ownedProject);

await assert.rejects(
    projectService.getProjectById("7", otherUser),
    error => error.statusCode === 403 && error.message === "Forbidden"
);

await assert.rejects(
    projectService.getProjectById("8", owner),
    error => error.statusCode === 403 && error.message === "Forbidden"
);

assert.deepEqual(await projectService.getProjectById("8", admin), unownedProject);

await assert.rejects(
    projectService.getProjectById("999", admin),
    error => error.statusCode === 404 && error.message === "Project not found"
);

await projectService.createProject("Owned", "development", owner);
assert.deepEqual(events.at(-1), ["createProject", {
    name: "Owned",
    environment: "development",
    ownerId: 31
}]);
```

Also add update and delete cases proving an owner is allowed, another user is rejected before mutation, and an admin can mutate `unownedProject`.

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run: `node --test tests/projectServiceAuthorization.test.js`

Expected: FAIL because the current service does not accept or check an actor.

- [ ] **Step 3: Implement shared ownership authorization**

Add an internal helper after validation:

```js
const getAuthorizedProject = async (projectId, actor) => {
    const project = await projectRepository.getProjectById(projectId);

    if (!project) {
        throw new Apperror("Project not found", 404);
    }

    if (actor.role !== "admin" && project.owner_id !== actor.userId) {
        throw new Apperror("Forbidden", 403);
    }

    return project;
};
```

Use the actor in every public operation:

```js
const getAllProjects = actor => actor.role === "admin"
    ? projectRepository.getAllProjects()
    : projectRepository.getProjectsByOwnerId(actor.userId);

const getProjectById = async (id, actor) => {
    const projectId = validateId(id);
    return getAuthorizedProject(projectId, actor);
};

const createProject = async (name, environment, actor) => {
    validateProject(name, environment);
    return projectRepository.createProject({
        name,
        environment,
        ownerId: actor.userId
    });
};
```

For update and delete, validate first, call `getAuthorizedProject(projectId, actor)`, then call the existing mutation query. Preserve `404` if the authorized row disappears before the mutation completes. Comments must explain that checking ownership in the service keeps policy out of HTTP and SQL layers, that null ownership fails the strict equality check for users, and that admins bypass only ownership.

- [ ] **Step 4: Run focused service and existing validation tests**

Run: `node --test tests/projectServiceAuthorization.test.js tests/projects.test.js`

Expected at this intermediate point: the new service tests pass; existing HTTP project tests may fail because their controllers have not yet supplied `req.user`. Record those expected route-layer failures and continue immediately to Task 5.

- [ ] **Step 5: Run the service syntax check**

Run: `node --check src/services/projectService.js`

Expected: exit code 0.

- [ ] **Step 6: Commit the service deliverable**

```bash
git add src/services/projectService.js tests/projectServiceAuthorization.test.js
git commit -m "feat: enforce project ownership in service"
```

### Task 5: Protect Project Routes and Pass Trusted Identity

**Files:**
- Modify: `src/routes/projectRoutes.js`
- Modify: `src/controllers/projectController.js`
- Modify: `tests/projects.test.js`

**Interfaces:**
- Consumes: `authenticate(req, res, next)`, `authorizeRoles("user", "admin")`, and service actor parameters from Task 4.
- Produces: protected `GET`, `POST`, `PUT`, and `DELETE /api/projects` behavior with ownership derived exclusively from the JWT.

- [ ] **Step 1: Update the HTTP test harness to issue real JWTs**

Before importing `projectRoutes`, set a test secret and import `jsonwebtoken`:

```js
const jwt = require("jsonwebtoken");
process.env.JWT_SECRET = "test-only-project-authorization-secret";
process.env.JWT_EXPIRES_IN = "1h";
```

Add:

```js
const tokenFor = (userId = 31, role = "user") => jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
);

const request = (path = "", method = "GET", body, token = tokenFor()) => {
    const headers = token === undefined
        ? {}
        : { Authorization: `Bearer ${token}` };

    if (body !== undefined) headers["Content-Type"] = "application/json";

    return fetch(base + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
};
```

Restore the original JWT environment values in `after()`. Update mocked rows used by owner requests to include `owner_id: 31`.

- [ ] **Step 2: Add failing HTTP authorization tests**

Add cases with query-aware mock results that verify:

```js
test("project routes reject requests without a JWT", async () => {
    const response = await request("", "GET", undefined, undefined);
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
});

test("a user list is filtered by the authenticated user ID", async () => {
    const response = await request();
    assert.equal(response.status, 200);
    assert.match(calls[0].sql, /WHERE owner_id = \$1/i);
    assert.deepEqual(calls[0].values, [31]);
});

test("another user receives 403 for an existing project", async () => {
    answer = async () => ({ rows: [{ ...ownedProject, owner_id: 44 }], rowCount: 1 });
    const response = await request("/7");
    assert.equal(response.status, 403);
});

test("a user receives 403 for an unowned legacy project", async () => {
    answer = async () => ({ rows: [{ ...ownedProject, owner_id: null }], rowCount: 1 });
    const response = await request("/7");
    assert.equal(response.status, 403);
});

test("an admin can read an unowned legacy project", async () => {
    answer = async () => ({ rows: [{ ...ownedProject, owner_id: null }], rowCount: 1 });
    const response = await request("/7", "GET", undefined, tokenFor(1, "admin"));
    assert.equal(response.status, 200);
});

test("create ignores body ownership and uses the JWT user ID", async () => {
    answer = async () => ({ rows: [{ id: 9, name: "Owned", environment: "development", owner_id: 31 }], rowCount: 1 });
    const response = await request("", "POST", {
        name: "Owned",
        environment: "development",
        owner_id: 44,
        userId: 44
    });
    assert.equal(response.status, 201);
    assert.deepEqual(calls[0].values, ["Owned", "development", 31]);
});
```

Adjust existing update/delete success mocks to return the owned row for the authorization `SELECT` and the mutation row for the second query. Assert other-user update/delete perform only the authorization `SELECT`, while admin update/delete of `owner_id: null` reach the mutation query.

- [ ] **Step 3: Run the project HTTP tests and confirm the red state**

Run: `node --test tests/projects.test.js`

Expected: FAIL because routes are public and controllers do not pass `req.user`.

- [ ] **Step 4: Protect the routes in the required order**

Import both middleware modules and add this after router creation, before route declarations:

```js
const authenticate = require("../middleware/authenticate");
const authorizeRoles = require("../middleware/authorizeRoles");

// Authentication identifies the JWT holder. Authorization then confirms that
// the authenticated role is allowed to use project endpoints.
router.use(authenticate, authorizeRoles("user", "admin"));
```

- [ ] **Step 5: Pass the trusted actor from controllers into services**

Change only the service calls:

```js
projectService.getAllProjects(req.user);
projectService.getProjectById(req.params.id, req.user);
projectService.createProject(name, environment, req.user);
projectService.updateProject(req.params.id, name, environment, req.user);
projectService.deleteProject(req.params.id, req.user);
```

Keep controller body extraction limited to `{ name, environment }`, with comments explaining that owner fields are ignored because `req.user` came from the verified JWT.

- [ ] **Step 6: Run project HTTP tests and syntax checks**

Run: `node --test tests/projects.test.js tests/authorization.test.js tests/projectServiceAuthorization.test.js tests/projectRepository.test.js`

Expected: all project authorization tests pass.

Run: `node --check src/routes/projectRoutes.js`

Run: `node --check src/controllers/projectController.js`

Expected: both exit with code 0.

- [ ] **Step 7: Commit the protected HTTP flow**

```bash
git add src/routes/projectRoutes.js src/controllers/projectController.js tests/projects.test.js
git commit -m "feat: protect project routes by owner and role"
```

### Task 6: Apply and Verify the Live Database Migration

**Files:**
- No new source files; this task applies and verifies Task 1 against the configured PostgreSQL database.

**Interfaces:**
- Consumes: `.env` database settings and `npm run migrate:project-ownership`.
- Produces: verified live `projects.owner_id`, FK deletion rule, index, and preserved legacy row.

- [ ] **Step 1: Record the pre-migration project count**

Run a read-only Node command using `src/config/db.js`:

```js
const pool = require("./src/config/db");
pool.query("SELECT COUNT(*)::int AS count FROM projects")
    .then(result => console.log(result.rows[0]))
    .finally(() => pool.end());
```

Expected for the currently inspected database: `{ count: 1 }`.

- [ ] **Step 2: Apply the migration**

Run: `npm run migrate:project-ownership`

Expected: `Project ownership migration completed.`

- [ ] **Step 3: Re-run the migration to verify idempotency**

Run: `npm run migrate:project-ownership`

Expected: it completes successfully again without duplicate-column, duplicate-constraint, or duplicate-index errors.

- [ ] **Step 4: Verify the live column, constraint, index, and legacy row**

Query PostgreSQL through the existing pool and assert:

```sql
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_name = 'projects' AND column_name = 'owner_id';
```

Expected: one `integer` row with `is_nullable = 'YES'`.

```sql
SELECT confdeltype
FROM pg_constraint
WHERE conname = 'projects_owner_id_fkey'
  AND conrelid = 'projects'::regclass;
```

Expected: `confdeltype = 'n'`, PostgreSQL's code for `ON DELETE SET NULL`.

```sql
SELECT indexname
FROM pg_indexes
WHERE tablename = 'projects' AND indexname = 'idx_projects_owner_id';
```

Expected: one index row.

```sql
SELECT COUNT(*)::int AS count,
       COUNT(*) FILTER (WHERE owner_id IS NULL)::int AS unowned_count
FROM projects;
```

Expected: `{ count: 1, unowned_count: 1 }`, proving the legacy project was preserved and remains unowned.

- [ ] **Step 5: Stop and report any incompatibility instead of changing the schema further**

If the live results differ, capture the exact schema/query evidence and report it before any destructive or corrective migration. Do not drop data, constraints, or columns automatically.

### Task 7: Update Learning Notes and Run Complete Verification

**Files:**
- Modify: `BACKEND_CONCEPTS.txt`

**Interfaces:**
- Consumes: the completed authorization implementation.
- Produces: beginner-readable documentation and final verification evidence.

- [ ] **Step 1: Add the authorization concepts to the learning notes**

Append sections that explain:

```text
AUTHENTICATION VS AUTHORIZATION
- authenticate verifies the Bearer JWT and creates req.user.
- authorizeRoles decides whether req.user.role may enter a route.
- Project services then decide whether that user owns a particular row.

PROJECT OWNERSHIP
- projects.owner_id references users.id.
- A foreign key blocks references to nonexistent users.
- ON DELETE SET NULL preserves projects if their user is deleted.
- The owner_id index speeds up GET /api/projects for normal users.
- New ownership comes only from req.user.userId, never request JSON.

403 FORBIDDEN
- 401 means the caller could not be authenticated.
- 403 means the caller is authenticated but lacks permission.
- Users receive 403 for existing projects owned by someone else or by nobody.
- Admins may manage owned and legacy unowned projects.

PROTECTED PROJECT REQUEST FLOW
Request -> authenticate -> authorizeRoles -> controller -> service ownership check -> repository -> PostgreSQL -> response
```

Also list the exact files implementing each step.

- [ ] **Step 2: Run JavaScript syntax checks for all source, script, and test files**

Run a PowerShell loop over `src/**/*.js`, `scripts/**/*.js`, and `tests/**/*.js` that invokes `node --check` for each file and exits on the first failure.

Expected: every file exits with code 0.

- [ ] **Step 3: Run the complete automated test suite**

Run: `npm test`

Expected: every existing Phase 1, Phase 2, and Phase 3 test plus all new authorization tests passes; report the exact total from this fresh run.

- [ ] **Step 4: Review the complete working-tree diff**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git diff --stat`

Run: `git status --short`

Confirm only the intended migration, authorization, ownership, tests, and learning-note changes are present alongside the user's pre-existing Phase 1-3 working changes.

- [ ] **Step 5: Request code review**

Invoke `superpowers:requesting-code-review` and ask the reviewer to compare the implementation with `docs/superpowers/specs/2026-09-16-project-authorization-design.md`, paying special attention to route middleware order, body-owner spoofing, null legacy ownership, admin bypass, parameterized SQL, and regression coverage.

- [ ] **Step 6: Address review findings and re-run affected checks**

For each valid finding, add or adjust a focused failing test first, implement the correction, rerun that focused test, then rerun `npm test` and `git diff --check`.

- [ ] **Step 7: Commit the documentation and any review corrections**

```bash
git add BACKEND_CONCEPTS.txt
git commit -m "docs: explain project authorization flow"
```

- [ ] **Step 8: Prepare the final user report**

Report the schema change, middleware, ownership behavior, protected routes, admin behavior, exact files changed, exact fresh test count, and these manual Thunder Client steps:

1. Register owner and second-user accounts with `POST /api/auth/register`.
2. Log in the owner with `POST /api/auth/login`; copy `token`.
3. Create a project with `POST /api/projects`, header `Authorization: Bearer <owner-token>`, and body containing only `name` and `environment`.
4. List and read the project using the owner token; expect `200`.
5. Log in as the second user and read/update/delete the owner's project; expect `403`.
6. Call any project endpoint without the Authorization header; expect `401`.
7. Promote a test account to `admin` directly in PostgreSQL for learning/testing, log in again to receive a JWT whose role is `admin`, then list/read/update/delete the legacy unowned project; expect access.

Do not include a password, database password, JWT secret, token value, or password hash in the report.
