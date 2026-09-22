const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const redisConfig = require("../src/config/redis");
const projectCache = require("../src/services/projectCache");

const originalClient = redisConfig.redisClient;
const originalGetTtl = redisConfig.getProjectCacheTtlSeconds;
const originalGetWriteTtl = redisConfig.getProjectCacheWriteTtlSeconds;
const originalWarn = console.warn;

afterEach(() => {
    redisConfig.redisClient = originalClient;
    redisConfig.getProjectCacheTtlSeconds = originalGetTtl;
    redisConfig.getProjectCacheWriteTtlSeconds = originalGetWriteTtl;
    console.warn = originalWarn;
});

const user = { userId: 31, role: "user" };
const admin = { userId: 1, role: "admin" };
const project = {
    id: 7,
    name: "Cached",
    environment: "development",
    owner_id: 31
};

test("cache keys separate each user from the administrator scope", () => {
    assert.equal(
        projectCache.buildProjectCacheKey(7, user, 4),
        "devpulse:project:user:31:v4:7"
    );
    assert.equal(
        projectCache.buildProjectCacheKey(7, { userId: 44, role: "user" }, 4),
        "devpulse:project:user:44:v4:7"
    );
    assert.equal(
        projectCache.buildProjectCacheKey(7, admin, 4),
        "devpulse:project:admin:v4:7"
    );
});

test("cache hit parses and returns the stored project", async () => {
    const calls = [];
    redisConfig.redisClient = {
        isReady: true,
        get: async (key) => {
            calls.push(key);
            if (key === "devpulse:project-version:7") return "4";
            return JSON.stringify(project);
        }
    };

    assert.deepEqual(await projectCache.getProject(7, user), {
        value: project,
        cacheKey: "devpulse:project:user:31:v4:7"
    });
    assert.deepEqual(calls, [
        "devpulse:project-version:7",
        "devpulse:project:user:31:v4:7"
    ]);
});

test("cache miss returns its exact versioned key while unavailable Redis returns undefined", async () => {
    let getCalls = 0;
    redisConfig.redisClient = {
        isReady: false,
        get: async () => { getCalls += 1; }
    };
    assert.equal(await projectCache.getProject(7, user), undefined);
    assert.equal(getCalls, 0);

    redisConfig.redisClient = { isReady: true, get: async () => null };
    assert.deepEqual(await projectCache.getProject(7, user), {
        value: undefined,
        cacheKey: "devpulse:project:user:31:v0:7"
    });
});

test("malformed JSON and Redis read failures become cache misses", async () => {
    console.warn = () => {};
    redisConfig.redisClient = { isReady: true, get: async () => "not-json" };
    assert.equal(await projectCache.getProject(7, user), undefined);

    redisConfig.redisClient = {
        isReady: true,
        get: async () => { throw new Error("Redis unavailable"); }
    };
    assert.equal(await projectCache.getProject(7, user), undefined);
});

test("cache writes JSON using the configured TTL", async () => {
    const calls = [];
    redisConfig.getProjectCacheWriteTtlSeconds = () => 45;
    redisConfig.redisClient = {
        isReady: true,
        set: async (...args) => { calls.push(args); }
    };

    assert.equal(await projectCache.setProject("project-cache-key", {
        ...project,
        password_hash: "must not be cached",
        token: "must not be cached"
    }), true);
    assert.deepEqual(calls, [[
        "project-cache-key",
        JSON.stringify(project),
        { EX: 45 }
    ]]);
});

test("cache write failures remain non-fatal", async () => {
    console.warn = () => {};
    redisConfig.redisClient = {
        isReady: true,
        set: async () => { throw new Error("Redis unavailable"); }
    };
    assert.equal(await projectCache.setProject("project-cache-key", project), false);

    redisConfig.redisClient = { isReady: false };
    assert.equal(await projectCache.setProject("project-cache-key", project), false);
});

test("invalidation advances the shared project version without scanning", async () => {
    const commands = [];
    const transaction = {
        incr: (key) => { commands.push(["incr", key]); return transaction; },
        exec: async () => { commands.push(["exec"]); }
    };
    redisConfig.redisClient = {
        isReady: true,
        multi: () => transaction
    };

    assert.equal(await projectCache.invalidateProject(7, 31), true);
    assert.deepEqual(commands, [
        ["incr", "devpulse:project-version:7"],
        ["exec"]
    ]);
});

test("successful invalidation makes an overlapping stale fill unreachable", async () => {
    const values = new Map();
    const client = {
        isReady: true,
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => { values.set(key, value); },
        multi: () => {
            const commands = [];
            return {
                incr(key) { commands.push(key); return this; },
                async exec() {
                    for (const key of commands) {
                        values.set(key, String(Number(values.get(key) ?? 0) + 1));
                    }
                }
            };
        }
    };
    redisConfig.redisClient = client;
    redisConfig.getProjectCacheWriteTtlSeconds = () => 60;

    const oldContext = await projectCache.getProject(7, user);
    assert.equal(oldContext.cacheKey, "devpulse:project:user:31:v0:7");

    await projectCache.invalidateProject(7, 31);
    await projectCache.setProject(oldContext.cacheKey, project);

    const currentContext = await projectCache.getProject(7, user);
    assert.equal(currentContext.cacheKey, "devpulse:project:user:31:v1:7");
    assert.equal(currentContext.value, undefined);
});

test("individual invalidation failures stay non-fatal", async () => {
    redisConfig.redisClient = {
        isReady: true,
        multi: () => ({
            incr() { return this; },
            exec: async () => { throw new Error("Redis unavailable"); }
        })
    };
    console.warn = () => {};
    assert.equal(await projectCache.invalidateProject(7, 31), false);
});
