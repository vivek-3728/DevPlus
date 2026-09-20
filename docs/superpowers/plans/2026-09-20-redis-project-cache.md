# Secure Redis Project Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, secure cache-aside Redis caching to authorized single-project reads and invalidate affected entries after successful updates/deletes.

**Architecture:** The official node-redis client lives behind a dedicated configuration module. A focused project-cache service owns actor-scoped keys, JSON, TTL, and fail-open Redis commands; the existing project service remains responsible for validation and authorization and coordinates PostgreSQL-first invalidation.

**Tech Stack:** Node.js 24, CommonJS, Express 5, PostgreSQL/node-postgres, node-redis `redis` 6.2.1, built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-20-redis-project-cache-design.md`

## Global Constraints

- PostgreSQL remains the source of truth.
- Cache only successful authorized `GET /api/projects/:id` results.
- Never cache the paginated/search/filter project list, 401, 403, 404, validation failures, Redis failures, or PostgreSQL failures.
- Derive cache scope only from the verified actor; never trust ownership data from the request.
- Complete PostgreSQL update/delete before attempting cache invalidation.
- Redis failure must not make project reads or successful mutations unavailable.
- Do not add sessions, rate limiting, queues, Pub/Sub, background jobs, Docker, or deployment changes.
- Preserve unrelated working-tree changes.

## Review Focus

- A wrong-ID or wrong-owner value stored under a user's key must never be returned; the service must fall back to PostgreSQL and apply current authorization.
- Missing `REDIS_URL` or a client that is not ready must disable caching without opening a connection or delaying PostgreSQL.
- Redis GET/SET/DEL and connection failures must remain fail-open, while PostgreSQL failures must still propagate.
- A failed PostgreSQL update/delete must not invalidate any cache key; a failed Redis invalidation must not change a successful database response.
- Administrator and normal-user namespaces must remain separate, and invalidation must clear both the admin key and the actual owner's key.

---

### Task 1: Redis Client Configuration and Cache Boundary

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/config/redis.js`
- Create: `src/services/projectCache.js`
- Create: `tests/redisConfig.test.js`
- Create: `tests/projectCache.test.js`

**Interfaces:**
- Produces: `redisConfig.redisClient`, `connectRedis()`, `createRedisClient()`, and `getProjectCacheTtlSeconds()`.
- Produces: `projectCache.getProject(projectId, actor)`, `setProject(project, actor)`, `invalidateProject(projectId, ownerId)`, and exported key builders for focused tests.
- Consumes: `REDIS_URL` and `REDIS_PROJECT_TTL_SECONDS`; no PostgreSQL interface changes.

- [ ] **Step 1: Install the official Redis client**

Run:

```powershell
npm install redis@6.2.1
```

Expected: `redis` is recorded in dependencies and the lockfile changes without modifying existing dependency versions unnecessarily.

- [ ] **Step 2: Write failing Redis configuration tests**

Create `tests/redisConfig.test.js` with a small fake EventEmitter client and tests equivalent to:

```js
test("Redis is disabled when REDIS_URL is absent", () => {
    assert.equal(createRedisClient({ env: {}, createClient: () => assert.fail() }), null);
});

test("Redis client uses the environment URL, disables offline commands, and handles events", () => {
    const fake = new EventEmitter();
    let options;
    fake.connect = async () => {};
    fake.isOpen = false;

    const client = createRedisClient({
        env: { REDIS_URL: "redis://cache.internal:6379" },
        createClient: (received) => { options = received; return fake; },
        logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(client, fake);
    assert.deepEqual(options, {
        url: "redis://cache.internal:6379",
        disableOfflineQueue: true
    });
    assert.doesNotThrow(() => fake.emit("error", new Error("offline")));
});

test("project cache TTL defaults to 60 and accepts only positive integers", () => {
    assert.equal(getProjectCacheTtlSeconds({}), 60);
    assert.equal(getProjectCacheTtlSeconds({ REDIS_PROJECT_TTL_SECONDS: "120" }), 120);
    assert.equal(getProjectCacheTtlSeconds({ REDIS_PROJECT_TTL_SECONDS: "0" }), 60);
    assert.equal(getProjectCacheTtlSeconds({ REDIS_PROJECT_TTL_SECONDS: "1.5" }), 60);
});
```

Also test that `connectRedis(null)` is a no-op, that an already-open client is not connected twice, and that a rejected `connect()` is caught and logged without rejecting its caller.

- [ ] **Step 3: Run configuration tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/redisConfig.test.js
```

Expected: FAIL because `src/config/redis.js` does not exist.

- [ ] **Step 4: Implement the Redis configuration module**

Create `src/config/redis.js` around these exact contracts:

```js
require("dotenv").config();
const { createClient: createNodeRedisClient } = require("redis");

const DEFAULT_PROJECT_CACHE_TTL_SECONDS = 60;

const getProjectCacheTtlSeconds = (env = process.env) => {
    const raw = env.REDIS_PROJECT_TTL_SECONDS;
    if (!/^\d+$/.test(raw ?? "")) return DEFAULT_PROJECT_CACHE_TTL_SECONDS;
    const ttl = Number(raw);
    return Number.isSafeInteger(ttl) && ttl > 0
        ? ttl
        : DEFAULT_PROJECT_CACHE_TTL_SECONDS;
};

const createRedisClient = ({
    env = process.env,
    createClient = createNodeRedisClient,
    logger = console
} = {}) => {
    const url = env.REDIS_URL?.trim();
    if (!url) return null;

    const client = createClient({ url, disableOfflineQueue: true });
    client.on("ready", () => logger.log("Redis cache ready"));
    client.on("reconnecting", () => logger.warn("Redis cache reconnecting"));
    client.on("end", () => logger.warn("Redis cache connection closed"));
    client.on("error", (error) => logger.error("Redis cache error:", error.message));
    return client;
};

const redisClient = createRedisClient();

const connectRedis = async (client = redisClient, logger = console) => {
    if (!client || client.isOpen) return false;
    try {
        await client.connect();
        return true;
    } catch (error) {
        logger.error("Redis cache connection failed:", error.message);
        return false;
    }
};

module.exports = {
    redisClient,
    connectRedis,
    createRedisClient,
    getProjectCacheTtlSeconds
};
```

Keep comments explaining why the cache is optional, why an `error` listener is mandatory, and why credentials are never logged.

- [ ] **Step 5: Run configuration tests and verify GREEN**

Run the command from Step 3.

Expected: all Redis configuration tests pass without a Redis server.

- [ ] **Step 6: Write failing project-cache tests**

Create `tests/projectCache.test.js`. Save/restore `redisConfig.redisClient` and test:

```js
test("user and admin keys are separated by authenticated scope", () => {
    assert.equal(buildProjectCacheKey(7, { userId: 31, role: "user" }),
        "devpulse:project:user:31:7");
    assert.equal(buildProjectCacheKey(7, { userId: 1, role: "admin" }),
        "devpulse:project:admin:7");
});

test("cache writes JSON with an expiry", async () => {
    redisConfig.redisClient = {
        isReady: true,
        set: async (...args) => { calls.push(args); }
    };
    await projectCache.setProject(project, user);
    assert.deepEqual(calls[0], [
        "devpulse:project:user:31:7",
        JSON.stringify(project),
        { EX: 60 }
    ]);
});
```

Add tests for cache hit JSON parsing, Redis GET/SET/DEL rejection, malformed JSON, a non-ready client, and invalidation keys. Failure cases must return `undefined`/`false` rather than reject. The production change that makes these tests pass is the new cache module; no repository mock is involved.

- [ ] **Step 7: Run cache tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/projectCache.test.js
```

Expected: FAIL because `src/services/projectCache.js` does not exist.

- [ ] **Step 8: Implement the cache service**

Create `src/services/projectCache.js` with these core rules:

```js
const redisConfig = require("../config/redis");

const buildProjectCacheKey = (projectId, actor) => actor.role === "admin"
    ? `devpulse:project:admin:${projectId}`
    : `devpulse:project:user:${actor.userId}:${projectId}`;

const buildInvalidationKeys = (projectId, ownerId) => [
    `devpulse:project:admin:${projectId}`,
    ...(ownerId == null ? [] : [`devpulse:project:user:${ownerId}:${projectId}`])
];

const getProject = async (projectId, actor) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return undefined;
    try {
        const value = await client.get(buildProjectCacheKey(projectId, actor));
        return value === null ? undefined : JSON.parse(value);
    } catch (error) {
        console.warn("Redis project cache read failed:", error.message);
        return undefined;
    }
};

const setProject = async (project, actor) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return false;
    try {
        await client.set(
            buildProjectCacheKey(project.id, actor),
            JSON.stringify(project),
            { EX: redisConfig.getProjectCacheTtlSeconds() }
        );
        return true;
    } catch (error) {
        console.warn("Redis project cache write failed:", error.message);
        return false;
    }
};

const invalidateProject = async (projectId, ownerId) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return false;
    try {
        await client.del(buildInvalidationKeys(projectId, ownerId));
        return true;
    } catch (error) {
        console.warn("Redis project cache invalidation failed:", error.message);
        return false;
    }
};
```

Export all three public operations and both key builders. Add beginner comments for cache-aside, TTL, and why Redis errors are swallowed here but PostgreSQL errors are not.

- [ ] **Step 9: Run Task 1 tests and commit**

Run:

```powershell
node --test --test-concurrency=1 tests/redisConfig.test.js tests/projectCache.test.js
```

Expected: all Task 1 tests pass.

Commit only Task 1 files:

```powershell
git add -- package.json package-lock.json src/config/redis.js src/services/projectCache.js tests/redisConfig.test.js tests/projectCache.test.js
git commit -m "feat: add optional Redis project cache infrastructure"
```

---

### Task 2: Secure Cache-Aside Project Reads

**Files:**
- Modify: `src/services/projectService.js`
- Create: `tests/projectServiceCaching.test.js`

**Interfaces:**
- Consumes: `projectCache.getProject(projectId, actor)` and `setProject(project, actor)` from Task 1.
- Preserves: `projectService.getProjectById(id, actor)` and all controller/repository interfaces.
- Produces: cache-hit reads that still validate project ID and ownership before return.

- [ ] **Step 1: Write failing cache-aside service tests**

Create `tests/projectServiceCaching.test.js`, save/restore all patched repository/cache functions in `afterEach`, and cover:

```js
test("cache miss queries PostgreSQL and caches only the authorized project", async () => {
    projectCache.getProject = async () => undefined;
    projectRepository.getProjectById = async () => owned;
    projectCache.setProject = async (...args) => { writes.push(args); return true; };

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.deepEqual(writes, [[owned, user]]);
});

test("valid cache hit avoids PostgreSQL", async () => {
    projectCache.getProject = async () => owned;
    projectRepository.getProjectById = async () => assert.fail("PostgreSQL queried");
    assert.deepEqual(await projectService.getProjectById("7", user), owned);
});
```

Add separate tests proving:

- a wrong-ID cache object falls back to PostgreSQL;
- a wrong-owner and NULL-owner cache object falls back to PostgreSQL and then returns 403 when the database row is unauthorized;
- an admin cache hit may return another user's or a legacy project's row;
- 404, 403, invalid ID, and repository rejection never call `setProject`;
- a cache miss caused by Redis failure still queries PostgreSQL;
- a cache write failure still returns the PostgreSQL row;
- `getProjects` never calls Redis, preserving the explicit no-list-caching scope.

- [ ] **Step 2: Run service caching tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/projectServiceCaching.test.js
```

Expected: FAIL because `getProjectById` does not call the cache boundary.

- [ ] **Step 3: Implement authorization-safe cache-aside reads**

Modify `src/services/projectService.js`:

```js
const projectCache = require("./projectCache");

const actorCanAccessProject = (project, actor) =>
    actor.role === "admin" || project.owner_id === actor.userId;

const isUsableCachedProject = (project, projectId, actor) =>
    project !== null &&
    typeof project === "object" &&
    !Array.isArray(project) &&
    project.id === projectId &&
    actorCanAccessProject(project, actor);

const getAuthorizedProject = async (projectId, actor) => {
    const project = await projectRepository.getProjectById(projectId);
    if (!project) throw new Apperror("Project not found", 404);
    if (!actorCanAccessProject(project, actor)) throw new Apperror("Forbidden", 403);
    return project;
};

const getProjectById = async (id, actor) => {
    const projectId = validateId(id);
    const cachedProject = await projectCache.getProject(projectId, actor);

    if (isUsableCachedProject(cachedProject, projectId, actor)) {
        return cachedProject;
    }

    const project = await getAuthorizedProject(projectId, actor);
    await projectCache.setProject(project, actor);
    return project;
};
```

Keep mutation authorization on `getAuthorizedProject`, which deliberately reads PostgreSQL rather than trusting cache data. Add comments explaining the double defense of actor-scoped keys plus authorization on every hit.

- [ ] **Step 4: Run caching and existing authorization tests**

Run:

```powershell
node --test --test-concurrency=1 tests/projectServiceCaching.test.js tests/projectServiceAuthorization.test.js
```

Expected: all read caching and Phase 3 authorization tests pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- src/services/projectService.js tests/projectServiceCaching.test.js
git commit -m "feat: cache authorized project reads"
```

---

### Task 3: PostgreSQL-First Invalidation, Startup, and Full Regression

**Files:**
- Modify: `src/services/projectService.js`
- Modify: `src/server.js`
- Modify: `.env.example`
- Modify: `tests/projectServiceCaching.test.js`
- Modify: `BACKEND_CONCEPTS.txt`

**Interfaces:**
- Consumes: `projectCache.invalidateProject(projectId, ownerId)` and `redisConfig.connectRedis()`.
- Preserves: update/delete HTTP responses, PostgreSQL error behavior, project ownership, and list endpoint behavior.
- Produces: post-database invalidation of admin and owner keys.

- [ ] **Step 1: Add failing invalidation-order tests**

Extend `tests/projectServiceCaching.test.js`:

```js
test("update invalidates after PostgreSQL succeeds", async () => {
    projectRepository.getProjectById = async () => owned;
    projectRepository.updateProject = async () => { order.push("database"); return updated; };
    projectCache.invalidateProject = async (...args) => { order.push("cache"); invalidations.push(args); };

    assert.deepEqual(
        await projectService.updateProject("7", "Updated", "production", user),
        updated
    );
    assert.deepEqual(order, ["database", "cache"]);
    assert.deepEqual(invalidations, [[7, 31]]);
});

test("failed PostgreSQL mutation does not invalidate", async () => {
    projectRepository.getProjectById = async () => owned;
    projectRepository.updateProject = async () => { throw databaseError; };
    projectCache.invalidateProject = async () => { invalidations += 1; };

    await assert.rejects(
        projectService.updateProject("7", "Updated", "production", user),
        (error) => error === databaseError
    );
    assert.equal(invalidations, 0);
});
```

Add equivalent successful/failed delete coverage, administrator mutation of another user's project, legacy NULL-owner admin invalidation, and a cache invalidation failure that leaves the successful update/delete result unchanged.

- [ ] **Step 2: Run invalidation tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/projectServiceCaching.test.js
```

Expected: invalidation assertions FAIL because mutations do not yet call the cache service.

- [ ] **Step 3: Implement PostgreSQL-first invalidation**

In `src/services/projectService.js`, retain the authorized database row and invalidate only after mutation success:

```js
const updateProject = async (id, name, environment, actor) => {
    const projectId = validateId(id);
    validateProject(name, environment);
    const existingProject = await getAuthorizedProject(projectId, actor);
    const project = await projectRepository.updateProject(projectId, { name, environment });
    if (!project) throw new Apperror("Project not found", 404);
    await projectCache.invalidateProject(projectId, existingProject.owner_id);
    return project;
};

const deleteProject = async (id, actor) => {
    const projectId = validateId(id);
    const existingProject = await getAuthorizedProject(projectId, actor);
    const project = await projectRepository.deleteProject(projectId);
    if (!project) throw new Apperror("Project not found", 404);
    await projectCache.invalidateProject(projectId, existingProject.owner_id);
};
```

The cache service already converts DEL failures into `false`, so these awaits preserve operation ordering without hiding database failures.

- [ ] **Step 4: Connect Redis without blocking server availability**

In `src/server.js`, import `connectRedis` and invoke it without awaiting HTTP startup:

```js
const { connectRedis } = require("./config/redis");

connectRedis();
```

Place the call beside the existing PostgreSQL startup diagnostic. Do not add Redis readiness to `/api/health` because Redis is optional.

- [ ] **Step 5: Add learner-facing environment and concept documentation**

Append to `.env.example`:

```text
# Redis is optional. When omitted, PostgreSQL serves every project read.
REDIS_URL=redis://localhost:6379

# Successful individual-project reads remain cached for 60 seconds by default.
REDIS_PROJECT_TTL_SECONDS=60
```

Append a concise `CACHE-ASIDE WITH REDIS` section to `BACKEND_CONCEPTS.txt` explaining misses, hits, TTL, PostgreSQL source-of-truth status, actor-scoped keys, invalidation after successful writes, and the write-performance/staleness trade-off.

- [ ] **Step 6: Run Phase 5 focused tests**

Run:

```powershell
node --test --test-concurrency=1 tests/redisConfig.test.js tests/projectCache.test.js tests/projectServiceCaching.test.js tests/projectServiceAuthorization.test.js tests/projects.test.js
```

Expected: all focused tests pass. List endpoint tests must show no Redis GET/SET activity.

- [ ] **Step 7: Run the complete regression suite**

Run:

```powershell
npm test
```

Expected: all authentication, authorization, ownership, migrations, transactions, JOIN, query, CRUD, and new Redis tests pass with zero failures.

- [ ] **Step 8: Inspect scope and commit**

Run:

```powershell
git diff --check -- package.json package-lock.json .env.example BACKEND_CONCEPTS.txt src/config/redis.js src/services/projectCache.js src/services/projectService.js src/server.js tests/redisConfig.test.js tests/projectCache.test.js tests/projectServiceCaching.test.js
git status --short
```

Commit only Task 3 files:

```powershell
git add -- src/services/projectService.js src/server.js .env.example BACKEND_CONCEPTS.txt tests/projectServiceCaching.test.js
git commit -m "feat: invalidate project cache after database writes"
```

- [ ] **Step 9: Request final read-only code review**

Review the complete Phase 5 range for authorization bypasses, cache-key scope,
malformed payload handling, Redis fail-open behavior, PostgreSQL error
propagation, mutation ordering, dependency/configuration safety, and test
completeness. Fix every Critical or Important finding with a failing regression
test first, then rerun `npm test`.
