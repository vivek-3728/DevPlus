const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const projectRepository = require("../src/repositories/projectRepository");
const redisConfig = require("../src/config/redis");
const projectCache = require("../src/services/projectCache");
const projectService = require("../src/services/projectService");

const originalRepository = { ...projectRepository };
const originalCache = { ...projectCache };
const originalRedisClient = redisConfig.redisClient;
const originalRedisTimeout = redisConfig.getRedisOperationTimeoutMs;
const originalRecycleRedisClient = redisConfig.recycleRedisClient;
const originalWarn = console.warn;

afterEach(() => {
    for (const [name, implementation] of Object.entries(originalRepository)) {
        projectRepository[name] = implementation;
    }
    for (const [name, implementation] of Object.entries(originalCache)) {
        projectCache[name] = implementation;
    }
    redisConfig.redisClient = originalRedisClient;
    if (originalRedisTimeout === undefined) {
        delete redisConfig.getRedisOperationTimeoutMs;
    } else {
        redisConfig.getRedisOperationTimeoutMs = originalRedisTimeout;
    }
    if (originalRecycleRedisClient === undefined) {
        delete redisConfig.recycleRedisClient;
    } else {
        redisConfig.recycleRedisClient = originalRecycleRedisClient;
    }
    console.warn = originalWarn;
});

const user = { userId: 31, role: "user" };
const admin = { userId: 1, role: "admin" };
const owned = {
    id: 7,
    name: "Owned",
    environment: "development",
    owner_id: 31
};
const projectCacheKey = "devpulse:project:user:31:v0:7";
const cacheContext = (value, cacheKey = projectCacheKey) => ({ value, cacheKey });

const withTestDeadline = (promise, milliseconds = 100) => Promise.race([
    promise,
    new Promise((_, reject) => {
        setTimeout(() => reject(new Error("test deadline exceeded")), milliseconds);
    })
]);

test("cache miss queries PostgreSQL and caches only the authorized project", async () => {
    const writes = [];
    let databaseReads = 0;
    projectCache.getProject = async () => cacheContext(undefined);
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return owned;
    };
    projectCache.setProject = async (...args) => {
        writes.push(args);
        return true;
    };

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(databaseReads, 1);
    assert.deepEqual(writes, [[projectCacheKey, owned]]);
});

test("concurrent identical project misses share one PostgreSQL load", async () => {
    let releaseDatabase;
    const gate = new Promise(resolve => { releaseDatabase = resolve; });
    let databaseReads = 0;
    let cacheWrites = 0;
    projectCache.getProject = async () => ({
        value: undefined,
        cacheKey: "devpulse:project:user:31:v0:7"
    });
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        await gate;
        return owned;
    };
    projectCache.setProject = async () => { cacheWrites += 1; return true; };

    const first = projectService.getProjectById("7", user);
    const second = projectService.getProjectById("7", user);
    releaseDatabase();

    assert.deepEqual(await Promise.all([first, second]), [owned, owned]);
    assert.equal(databaseReads, 1);
    assert.equal(cacheWrites, 1);
});

test("a read started after update invalidation does not join an older version flight", async () => {
    let releaseOldRead;
    let markOldReadStarted;
    const oldReadGate = new Promise(resolve => { releaseOldRead = resolve; });
    const oldReadStarted = new Promise(resolve => { markOldReadStarted = resolve; });
    const freshProject = { ...owned, name: "Fresh" };
    let version = 0;
    let databaseReads = 0;

    projectCache.getProject = async () => ({
        value: undefined,
        cacheKey: `devpulse:project:user:31:v${version}:7`
    });
    projectCache.setProject = async () => true;
    projectCache.invalidateProjectLists = async () => true;
    projectCache.invalidateProject = async () => { version += 1; return true; };
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        if (databaseReads === 1) {
            markOldReadStarted();
            await oldReadGate;
            return owned;
        }
        if (databaseReads === 2) return owned; // update authorization read
        return freshProject;
    };
    projectRepository.updateProject = async () => freshProject;

    const oldRead = projectService.getProjectById("7", user);
    await oldReadStarted;
    await projectService.updateProject("7", "Fresh", "development", user);

    // This read starts after the update and its version invalidation completed.
    // It must not share the still-running load that used version 0.
    const newRead = projectService.getProjectById("7", user);
    releaseOldRead();

    assert.deepEqual(await oldRead, owned);
    assert.deepEqual(await newRead, freshProject);
    assert.equal(databaseReads, 3);
});

test("individual cache hits strip unexpected authentication fields", async () => {
    projectCache.getProject = async () => ({
        value: {
            ...owned,
            password_hash: "never return",
            token: "never return",
            email: "never return"
        },
        cacheKey: "devpulse:project:user:31:v0:7"
    });
    projectRepository.getProjectById = async () => {
        assert.fail("a valid cache hit must not query PostgreSQL");
    };

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
});

test("valid cache hit returns the project without querying PostgreSQL", async () => {
    let cacheWrites = 0;
    projectCache.getProject = async () => cacheContext(owned);
    projectCache.setProject = async () => { cacheWrites += 1; };
    projectRepository.getProjectById = async () => {
        assert.fail("PostgreSQL must not be queried on a valid cache hit");
    };

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(cacheWrites, 0);
});

test("wrong project ID in cache falls back to PostgreSQL", async () => {
    let cacheReads = 0;
    let databaseReads = 0;
    projectCache.getProject = async () => {
        cacheReads += 1;
        return cacheContext({ ...owned, id: 8 });
    };
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return owned;
    };
    projectCache.setProject = async () => true;

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(cacheReads, 1);
    assert.equal(databaseReads, 1);
});

test("incomplete cached project data falls back to PostgreSQL", async () => {
    let cacheReads = 0;
    let databaseReads = 0;
    projectCache.getProject = async () => {
        cacheReads += 1;
        return cacheContext({ id: 7, owner_id: 31 });
    };
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return owned;
    };
    projectCache.setProject = async () => true;

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(cacheReads, 1);
    assert.equal(databaseReads, 1);
});

for (const cachedOwner of [44, null]) {
    test(`cached owner ${cachedOwner} cannot bypass current database authorization`, async () => {
        let cacheReads = 0;
        let cacheWrites = 0;
        projectCache.getProject = async () => {
            cacheReads += 1;
            return cacheContext({ ...owned, owner_id: cachedOwner });
        };
        projectRepository.getProjectById = async () => ({ ...owned, owner_id: cachedOwner });
        projectCache.setProject = async () => { cacheWrites += 1; };

        await assert.rejects(
            projectService.getProjectById("7", user),
            (error) => error.statusCode === 403
        );
        assert.equal(cacheReads, 1);
        assert.equal(cacheWrites, 0);
    });
}

test("administrator cache hits retain access to owned and legacy projects", async () => {
    let databaseReads = 0;
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return undefined;
    };

    projectCache.getProject = async () => cacheContext(
        { ...owned, owner_id: 44 },
        "devpulse:project:admin:v0:7"
    );
    assert.equal((await projectService.getProjectById("7", admin)).owner_id, 44);

    projectCache.getProject = async () => cacheContext(
        { ...owned, owner_id: null },
        "devpulse:project:admin:v0:7"
    );
    assert.equal((await projectService.getProjectById("7", admin)).owner_id, null);
    assert.equal(databaseReads, 0);
});

test("404 and PostgreSQL errors are not cached", async () => {
    let cacheReads = 0;
    let cacheWrites = 0;
    projectCache.getProject = async () => {
        cacheReads += 1;
        return cacheContext(undefined);
    };
    projectCache.setProject = async () => { cacheWrites += 1; };
    projectRepository.getProjectById = async () => undefined;

    await assert.rejects(
        projectService.getProjectById("99", user),
        (error) => error.statusCode === 404
    );

    const databaseError = new Error("database unavailable");
    projectRepository.getProjectById = async () => { throw databaseError; };
    await assert.rejects(
        projectService.getProjectById("99", user),
        (error) => error === databaseError
    );
    assert.equal(cacheReads, 2);
    assert.equal(cacheWrites, 0);
});

test("invalid IDs are rejected before cache or PostgreSQL access", async () => {
    let cacheReads = 0;
    let databaseReads = 0;
    projectCache.getProject = async () => { cacheReads += 1; };
    projectRepository.getProjectById = async () => { databaseReads += 1; };

    await assert.rejects(
        projectService.getProjectById("abc", user),
        (error) => error.statusCode === 400
    );
    assert.equal(cacheReads, 0);
    assert.equal(databaseReads, 0);
});

test("Redis miss or failed cache population still returns PostgreSQL data", async () => {
    let cacheReads = 0;
    projectCache.getProject = async () => {
        cacheReads += 1;
        return cacheContext(undefined);
    };
    projectRepository.getProjectById = async () => owned;
    projectCache.setProject = async () => false;

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(cacheReads, 1);
});

test("a Redis GET that stops responding falls back to PostgreSQL", async () => {
    console.warn = () => {};
    let databaseReads = 0;
    let recycledClients = 0;
    redisConfig.redisClient = {
        isReady: true,
        get: async () => new Promise(() => {}),
        destroy: () => {}
    };
    redisConfig.getRedisOperationTimeoutMs = () => 10;
    redisConfig.recycleRedisClient = () => {
        recycledClients += 1;
        redisConfig.redisClient = null;
    };
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return owned;
    };

    assert.deepEqual(
        await withTestDeadline(projectService.getProjectById("7", user)),
        owned
    );
    assert.equal(databaseReads, 1);
    assert.equal(recycledClients, 1);
});

test("a Redis SET that stops responding does not block a PostgreSQL read", async () => {
    console.warn = () => {};
    let recycledClients = 0;
    redisConfig.redisClient = {
        isReady: true,
        get: async () => null,
        set: async () => new Promise(() => {}),
        destroy: () => {}
    };
    redisConfig.getRedisOperationTimeoutMs = () => 10;
    redisConfig.recycleRedisClient = () => {
        recycledClients += 1;
        redisConfig.redisClient = null;
    };
    projectRepository.getProjectById = async () => owned;

    assert.deepEqual(
        await withTestDeadline(projectService.getProjectById("7", user)),
        owned
    );
    assert.equal(recycledClients, 1);
});

test("paginated list queries never use the individual-project cache", async () => {
    let cacheCalls = 0;
    projectCache.getProject = async () => { cacheCalls += 1; };
    projectCache.setProject = async () => { cacheCalls += 1; };
    projectRepository.queryProjects = async () => ({ projects: [owned], total: 1 });

    const result = await projectService.getProjects({}, user);
    assert.deepEqual(result.projects, [owned]);
    assert.equal(cacheCalls, 0);
});

test("update invalidates owner and admin caches after PostgreSQL succeeds", async () => {
    const order = [];
    const invalidations = [];
    const updated = { ...owned, name: "Updated", environment: "production" };
    projectRepository.getProjectById = async () => owned;
    projectRepository.updateProject = async () => {
        order.push("database");
        return updated;
    };
    projectCache.invalidateProject = async (...args) => {
        order.push("cache");
        invalidations.push(args);
        return true;
    };

    assert.deepEqual(
        await projectService.updateProject("7", "Updated", "production", user),
        updated
    );
    assert.deepEqual(order, ["database", "cache"]);
    assert.deepEqual(invalidations, [[7, 31]]);
});

test("failed PostgreSQL update does not invalidate cache", async () => {
    const databaseError = new Error("update failed");
    let invalidations = 0;
    projectRepository.getProjectById = async () => owned;
    projectRepository.updateProject = async () => { throw databaseError; };
    projectCache.invalidateProject = async () => { invalidations += 1; };

    await assert.rejects(
        projectService.updateProject("7", "Updated", "production", user),
        (error) => error === databaseError
    );
    assert.equal(invalidations, 0);
});

test("delete invalidates owner and admin caches after PostgreSQL succeeds", async () => {
    const order = [];
    const invalidations = [];
    projectRepository.getProjectById = async () => owned;
    projectRepository.deleteProject = async () => {
        order.push("database");
        return { id: 7 };
    };
    projectCache.invalidateProject = async (...args) => {
        order.push("cache");
        invalidations.push(args);
        return true;
    };

    await projectService.deleteProject("7", user);
    assert.deepEqual(order, ["database", "cache"]);
    assert.deepEqual(invalidations, [[7, 31]]);
});

test("missing delete result and unauthorized mutations do not invalidate cache", async () => {
    let invalidations = 0;
    projectCache.invalidateProject = async () => { invalidations += 1; };
    projectRepository.getProjectById = async () => owned;
    projectRepository.deleteProject = async () => undefined;

    await assert.rejects(
        projectService.deleteProject("7", user),
        (error) => error.statusCode === 404
    );

    projectRepository.getProjectById = async () => ({ ...owned, owner_id: 44 });
    await assert.rejects(
        projectService.updateProject("7", "Updated", "production", user),
        (error) => error.statusCode === 403
    );
    assert.equal(invalidations, 0);
});

test("admin mutations invalidate the actual owner scope including legacy NULL", async () => {
    const invalidations = [];
    projectCache.invalidateProject = async (...args) => {
        invalidations.push(args);
        return true;
    };
    projectRepository.getProjectById = async () => ({ ...owned, owner_id: 44 });
    projectRepository.updateProject = async () => ({ ...owned, owner_id: 44 });
    await projectService.updateProject("7", "Updated", "production", admin);

    projectRepository.getProjectById = async () => ({ ...owned, owner_id: null });
    projectRepository.deleteProject = async () => ({ id: 7 });
    await projectService.deleteProject("7", admin);

    assert.deepEqual(invalidations, [[7, 44], [7, null]]);
});

test("cache invalidation failure does not change successful database responses", async () => {
    const updated = { ...owned, name: "Updated", environment: "production" };
    projectRepository.getProjectById = async () => owned;
    projectRepository.updateProject = async () => updated;
    projectRepository.deleteProject = async () => ({ id: 7 });
    projectCache.invalidateProject = async () => false;

    assert.deepEqual(
        await projectService.updateProject("7", "Updated", "production", user),
        updated
    );
    await assert.doesNotReject(projectService.deleteProject("7", user));
});

test("a Redis version invalidation that stops responding does not block an update", async () => {
    console.warn = () => {};
    const updated = { ...owned, name: "Updated", environment: "production" };
    let recycledClients = 0;
    redisConfig.redisClient = {
        isReady: true,
        multi: () => ({
            incr() { return this; },
            exec: async () => new Promise(() => {})
        }),
        destroy: () => {}
    };
    redisConfig.getRedisOperationTimeoutMs = () => 10;
    redisConfig.recycleRedisClient = () => {
        recycledClients += 1;
        redisConfig.redisClient = null;
    };
    projectRepository.getProjectById = async () => owned;
    projectRepository.updateProject = async () => updated;

    assert.deepEqual(
        await withTestDeadline(
            projectService.updateProject("7", "Updated", "production", user)
        ),
        updated
    );
    assert.equal(recycledClients, 1);
});
