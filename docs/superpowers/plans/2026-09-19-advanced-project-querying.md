# DevPulse Advanced Project Querying Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Phase 3 project authentication/ownership and add safe pagination, filtering, search, and sorting to `GET /api/projects`.

**Architecture:** Project routes authenticate and authorize roles before controllers pass trusted actors into services. Services enforce owner-or-admin policy and normalize query parameters; repositories contain parameterized count/page SQL and use only whitelisted SQL fragments for sorting.

**Tech Stack:** Node.js CommonJS, Express 5, PostgreSQL, `pg`, JWT, Node's built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-19-advanced-project-querying-design.md`

## Global Constraints

- Work directly in the current dirty checkout with the user's explicit approval.
- Preserve existing database schema and migrations; create no new migration.
- Preserve unrelated Phase 1–4 working-tree changes and do not revert files.
- Restore Phase 3 exactly: JWT authentication, `user`/`admin` role authorization, JWT-derived ownership, user owner-only access, admin bypass, and null-owner legacy rows inaccessible to normal users.
- Keep SQL in the repository and query validation/authorization in the service.
- Use placeholders for every user-controlled SQL value.
- Never concatenate raw `sort` or `order` input into SQL.
- Keep important new logic beginner-friendly and commented.
- Do not add Redis, caching, application transactions, full-text search, ownership transfer, or new HTTP endpoints.
- Existing dirty source/test files may not be safely committed without absorbing earlier work; commit only clean new files and document any intentionally uncommitted hunks in the execution ledger.

## Review Focus

- Ownership must constrain both `COUNT(*)` and the page query; otherwise metadata can reveal another user's projects even when rows do not.
- Repeated or non-string query values must return 400 rather than causing coercion surprises or entering SQL.
- Sort/order injection text must fail validation, while repository SQL receives only fixed mapped fragments.
- `%`, `_`, and `\` in search text must be literal characters, not unintended wildcard syntax.
- A valid page beyond the final page must return correct totals with an empty project array.

---

### Task 1: Restore Phase 3 Project Authorization and Ownership

**Files:**
- Create: `src/middleware/authorizeRoles.js`
- Create: `tests/authorization.test.js`
- Create: `tests/projectRepository.test.js`
- Create: `tests/projectServiceAuthorization.test.js`
- Modify: `src/routes/projectRoutes.js`
- Modify: `src/controllers/projectController.js`
- Modify: `src/services/projectService.js`
- Modify: `src/repositories/projectRepository.js`
- Modify: `tests/projects.test.js`

**Interfaces:**
- Consumes: `authenticate(req,res,next)` attaching `{ userId, role }`; nullable `projects.owner_id` foreign key.
- Produces: `authorizeRoles(...allowedRoles)`; owner-aware service signatures accepting `actor`; `getProjectsByOwnerId(ownerId)`; `createProject({ name, environment, ownerId })`.

- [ ] **Step 1: Write failing role middleware tests**

In `tests/authorization.test.js`, test the middleware directly:

```js
test("authorizeRoles allows a configured role", () => {
    const req = { user: { userId: 31, role: "user" } };
    authorizeRoles("user", "admin")(req, {}, next);
    assert.equal(nextError, undefined);
});

test("authorizeRoles rejects a missing or disallowed role with 403", () => {
    authorizeRoles("admin")({ user: { role: "user" } }, {}, next);
    assert.equal(nextError.statusCode, 403);
});
```

- [ ] **Step 2: Write failing repository ownership tests**

In `tests/projectRepository.test.js`, temporarily replace `pool.query` and
verify `getProjectsByOwnerId(31)` uses `WHERE owner_id = $1 ORDER BY id`, while
`createProject` inserts `(name, environment, owner_id)` with values
`["Owned", "development", 31]`. Assert update/delete SQL never changes
`owner_id`.

- [ ] **Step 3: Write failing service authorization tests**

In `tests/projectServiceAuthorization.test.js`, replace repository functions
with controlled fakes and assert:

- user listing calls `getProjectsByOwnerId(actor.userId)`;
- admin listing calls `getAllProjects()`;
- creation passes the actor's ID and ignores request ownership fields;
- users may read/update/delete only strict-equal owner IDs;
- another user's and null-owner projects produce 403 before mutation;
- admins may access owned and null-owner projects;
- missing rows remain 404.

- [ ] **Step 4: Run Phase 3 tests and verify RED**

Run:

```bash
node --test tests/authorization.test.js tests/projectRepository.test.js tests/projectServiceAuthorization.test.js
```

Expected: FAIL because `authorizeRoles`, owner-aware repository methods, and
actor-aware service behavior are missing.

- [ ] **Step 5: Implement role middleware**

Create `authorizeRoles.js` as a factory. It reads only `req.user.role`, calls
`next()` when allowed, and otherwise forwards `new Apperror("Forbidden", 403)`.
Comments explain that authentication establishes identity before authorization
checks permission.

- [ ] **Step 6: Implement repository ownership primitives**

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

Change project creation to insert `owner_id` from `project.ownerId`. Keep update
and delete ownership-neutral.

- [ ] **Step 7: Implement service owner-or-admin policy**

Change service signatures to accept `actor`. Add an internal
`getAuthorizedProject(projectId, actor)` that fetches the row, returns 404 when
missing, and returns 403 when a non-admin's `project.owner_id !== actor.userId`.
Use it for read/update/delete. Admin listing uses all rows; user listing uses
the owner query. Creation passes only the actor's trusted ID.

- [ ] **Step 8: Protect routes and pass actors through controllers**

Apply both middleware functions before every project controller. Pass
`req.user` to every service call. Keep body extraction limited to name and
environment so client owner fields are ignored.

- [ ] **Step 9: Update HTTP CRUD tests for authentication**

Set a test JWT secret, sign user/admin tokens, send Authorization headers, and
update mocked SQL sequences for owner checks. Add HTTP assertions for missing
tokens, user isolation, admin null-owner access, and JWT-derived creation.

- [ ] **Step 10: Run Phase 3 and existing tests GREEN**

Run:

```bash
node --test tests/authorization.test.js tests/projectRepository.test.js tests/projectServiceAuthorization.test.js tests/projects.test.js
npm test
```

Expected: restored authorization tests and the full existing suite pass.

- [ ] **Step 11: Commit only clean new files**

```bash
git add src/middleware/authorizeRoles.js tests/authorization.test.js tests/projectRepository.test.js tests/projectServiceAuthorization.test.js
git commit -m "feat: restore project ownership authorization"
```

Leave pre-existing dirty source/test files uncommitted and record that ruling.

### Task 2: Query Parameter Validation and Pagination Metadata

**Files:**
- Create: `tests/projectQueryService.test.js`
- Modify: `src/services/projectService.js`

**Interfaces:**
- Consumes: raw Express query object and authenticated actor.
- Produces: `getProjects(rawQuery, actor)` returning `{ page, limit, total, totalPages, projects }`; internal normalized query `{ page, limit, offset, environment, search, sort, order }`.

- [ ] **Step 1: Write failing service query tests**

Stub `projectRepository.queryProjects` and verify defaults:

```js
assert.deepEqual(capturedQuery, {
    page: 1,
    limit: 10,
    offset: 0,
    environment: undefined,
    search: undefined,
    sort: "id",
    order: "asc"
});
```

Assert `{ total: 21, projects: [...] }` becomes metadata with `totalPages: 3`.
Assert total zero produces zero pages, and page 4 computes offset 30.

Add table-driven 400 tests for page/limit values `0`, `-1`, `1.5`, `1e2`,
`0x10`, unsafe integers, arrays, objects, empty strings, and `limit=101`.

Add tests for environment values, trimmed search, blank search omission,
101-character search rejection, allowed sort fields, case-normalized order, and
injection-like sort/order rejection.

- [ ] **Step 2: Run service query tests and verify RED**

Run: `node --test tests/projectQueryService.test.js`

Expected: FAIL because `getProjects`/query normalization is missing.

- [ ] **Step 3: Implement normalization helpers**

Add constants for defaults, maximum limit, allowed environments, sort keys, and
orders. Implement strict string-only decimal parsing with `Number.isSafeInteger`.
Reuse one environment helper from both create/update and list filtering.

Normalize optional search using `trim()`, omit blank text, and reject text over
100 characters. Normalize order to lowercase only after confirming it is a
single string.

- [ ] **Step 4: Implement metadata service**

Call:

```js
const { projects, total } = await projectRepository.queryProjects({
    ...normalizedQuery,
    ownerId: actor.role === "admin" ? undefined : actor.userId
});
```

Return the public metadata object and do not expose offset/internal owner scope.

- [ ] **Step 5: Run service query tests and full suite GREEN**

Run:

```bash
node --test tests/projectQueryService.test.js
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit the clean new test file**

```bash
git add tests/projectQueryService.test.js
git commit -m "test: define project query validation"
```

Keep the already-dirty service implementation hunk in the working tree.

### Task 3: Safe Repository Count and Page Queries

**Files:**
- Create: `tests/projectQueryRepository.test.js`
- Modify: `src/repositories/projectRepository.js`

**Interfaces:**
- Consumes: normalized query plus optional `ownerId` from Task 2.
- Produces: `queryProjects(options): Promise<{ projects: object[], total: number }>`.

- [ ] **Step 1: Write failing repository SQL tests**

Capture both queries and assert:

- defaults produce no filter and `ORDER BY p.id ASC LIMIT $1 OFFSET $2`;
- user scope adds `p.owner_id = $1` to count and page queries;
- environment adds parameterized equality;
- search uses `p.name ILIKE $n ESCAPE '\\'` and escapes `%`, `_`, and `\`;
- combined options use the expected parameter order;
- `name/created_at` and ASC/DESC become only whitelisted SQL fragments;
- count parses PostgreSQL's string count into a number;
- an empty row query still returns the count;
- SQL contains none of the malicious sort/order input supplied to service tests.

- [ ] **Step 2: Run repository query tests and verify RED**

Run: `node --test tests/projectQueryRepository.test.js`

Expected: FAIL because `queryProjects` is missing.

- [ ] **Step 3: Implement fixed-fragment query building**

Define private `SORT_COLUMNS` and `SORT_ORDERS` maps in the repository. Build
predicates using a helper that appends values and returns the next `$n`.
Generate one shared `WHERE` string for both queries.

Escape search text in JavaScript:

```js
const escapedSearch = search.replace(/[\\%_]/g, "\\$&");
```

Bind `%${escapedSearch}%` as a value and use explicit `ESCAPE '\\'` SQL.
Select explicit project columns. Add `p.id ASC` as a secondary order unless ID
is already the primary sort.

- [ ] **Step 4: Run repository and service query tests GREEN**

Run:

```bash
node --test tests/projectQueryRepository.test.js tests/projectQueryService.test.js
```

Expected: all query unit tests pass.

- [ ] **Step 5: Commit the clean repository test**

```bash
git add tests/projectQueryRepository.test.js
git commit -m "test: verify safe advanced project SQL"
```

Keep the already-dirty repository implementation hunk in the working tree.

### Task 4: HTTP Query Contract and Real PostgreSQL Integration

**Files:**
- Modify: `src/controllers/projectController.js`
- Modify: `tests/projects.test.js`
- Create: `tests/projectQueryDatabase.test.js`

**Interfaces:**
- Consumes: `getProjects(req.query, req.user)` from Task 2 and the migrated database schema.
- Produces: authenticated `GET /api/projects` metadata response supporting all combined query parameters.

- [ ] **Step 1: Write failing HTTP list tests**

Update `tests/projects.test.js` list tests so the pool fake returns a count row
then page rows. Assert default metadata, explicit pagination, invalid query 400,
combined query forwarding, user ownership SQL, admin omission of ownership SQL,
empty result metadata, and a beyond-final-page response.

- [ ] **Step 2: Run HTTP tests and verify RED**

Run: `node --test tests/projects.test.js`

Expected: FAIL because the controller still calls the old list service without
query/actor and returns an array.

- [ ] **Step 3: Connect controller query and actor**

Change the list controller to await `projectService.getProjects(req.query,
req.user)` and return the metadata object. Preserve existing centralized error
handling.

- [ ] **Step 4: Run HTTP tests GREEN**

Run: `node --test tests/projects.test.js`

Expected: all authenticated CRUD and advanced list HTTP tests pass.

- [ ] **Step 5: Write real PostgreSQL query integration tests**

Create `tests/projectQueryDatabase.test.js` using the same verified temporary
schema safety pattern as `tests/databaseMigrations.test.js`. Run migrations,
insert two users, owned projects in both environments with mixed-case names,
and a null-owner legacy project.

Route repository queries through the schema pool and assert:

- a normal user's combined search/environment/page/sort query returns only
  their matching rows and owner-scoped total;
- another user's matching name never affects rows or total;
- admin query sees both users and the null-owner legacy project;
- search containing `%`, `_`, and `\` matches those characters literally;
- a page beyond the final page returns no rows with a nonzero total.

- [ ] **Step 6: Run integration tests GREEN**

Run:

```bash
node --test tests/projectQueryDatabase.test.js
```

Expected: all real PostgreSQL query tests pass and temporary schemas are dropped.

- [ ] **Step 7: Commit clean integration test**

```bash
git add tests/projectQueryDatabase.test.js
git commit -m "test: verify advanced project queries in PostgreSQL"
```

### Task 5: Final Verification and Review

**Files:**
- Modify only files found defective by verification, with a failing regression test first for behavior changes.

**Interfaces:**
- Consumes: all Task 1–4 deliverables.
- Produces: verified Phase 3 restoration and Phase 4 Block 2 implementation.

- [ ] **Step 1: Run focused tests**

```bash
node --test tests/authorization.test.js tests/projectRepository.test.js tests/projectServiceAuthorization.test.js tests/projectQueryService.test.js tests/projectQueryRepository.test.js tests/projects.test.js tests/projectQueryDatabase.test.js
```

Expected: zero failures.

- [ ] **Step 2: Run database regression tests**

```bash
node --test tests/databaseMigrations.test.js tests/projectOwnerJoin.test.js tests/projectQueryDatabase.test.js
```

Expected: zero failures and no leaked temporary schemas.

- [ ] **Step 3: Run complete suite**

Run: `npm test`

Expected: all Phase 1–4 tests pass with zero failures. Record the exact total.

- [ ] **Step 4: Verify migration and diff health**

Run:

```bash
npm run migrate
git diff --check <implementation-base>..HEAD
git diff --check -- src/routes/projectRoutes.js src/controllers/projectController.js src/services/projectService.js src/repositories/projectRepository.js
```

Expected: migrations remain skipped, Phase 4 commits have no whitespace errors,
and any unrelated pre-existing warning is reported without modification.

- [ ] **Step 5: Perform independent whole-change review**

Provide the reviewer the spec, plan, ledger rulings, committed implementation
range, and the explicit uncommitted hunks in the four pre-dirty project files.
Fix Critical/Important findings once through RED-GREEN; defer Minor findings.

- [ ] **Step 6: Final fresh verification**

Run `npm test` again after review fixes and report the exact passing count,
supported query parameters, LIMIT/OFFSET behavior, sorting safety, ownership
enforcement, and example URLs.
