const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const redisConfig = require("../src/config/redis");
const projectCache = require("../src/services/projectCache");

const originalClient = redisConfig.redisClient;
const originalGetTtl = redisConfig.getProjectCacheTtlSeconds;
const originalWarn = console.warn;

afterEach(() => {
    redisConfig.redisClient = originalClient;
    redisConfig.getProjectCacheTtlSeconds = originalGetTtl;
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
        projectCache.buildProjectCacheKey(7, user),
        "devpulse:project:user:31:7"
    );
    assert.equal(
        projectCache.buildProjectCacheKey(7, { userId: 44, role: "user" }),
        "devpulse:project:user:44:7"
    );
    assert.equal(
        projectCache.buildProjectCacheKey(7, admin),
        "devpulse:project:admin:7"
    );
});

test("cache hit parses and returns the stored project", async () => {
    const calls = [];
    redisConfig.redisClient = {
        isReady: true,
        get: async (key) => {
            calls.push(key);
            return JSON.stringify(project);
        }
    };

    assert.deepEqual(await projectCache.getProject(7, user), project);
    assert.deepEqual(calls, ["devpulse:project:user:31:7"]);
});

test("cache miss and unavailable Redis return undefined", async () => {
    let getCalls = 0;
    redisConfig.redisClient = {
        isReady: false,
        get: async () => { getCalls += 1; }
    };
    assert.equal(await projectCache.getProject(7, user), undefined);
    assert.equal(getCalls, 0);

    redisConfig.redisClient = { isReady: true, get: async () => null };
    assert.equal(await projectCache.getProject(7, user), undefined);
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
    redisConfig.getProjectCacheTtlSeconds = () => 45;
    redisConfig.redisClient = {
        isReady: true,
        set: async (...args) => { calls.push(args); }
    };

    assert.equal(await projectCache.setProject(project, user), true);
    assert.deepEqual(calls, [[
        "devpulse:project:user:31:7",
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
    assert.equal(await projectCache.setProject(project, user), false);

    redisConfig.redisClient = { isReady: false };
    assert.equal(await projectCache.setProject(project, user), false);
});

test("invalidation clears administrator and owner keys", async () => {
    const calls = [];
    redisConfig.redisClient = {
        isReady: true,
        del: async (keys) => { calls.push(keys); }
    };

    assert.deepEqual(projectCache.buildInvalidationKeys(7, 31), [
        "devpulse:project:admin:7",
        "devpulse:project:user:31:7"
    ]);
    assert.equal(await projectCache.invalidateProject(7, 31), true);
    assert.deepEqual(calls, [[
        "devpulse:project:admin:7",
        "devpulse:project:user:31:7"
    ]]);
});

test("legacy invalidation clears only the admin key and failures stay non-fatal", async () => {
    const calls = [];
    redisConfig.redisClient = {
        isReady: true,
        del: async (keys) => { calls.push(keys); }
    };
    assert.equal(await projectCache.invalidateProject(7, null), true);
    assert.deepEqual(calls, [["devpulse:project:admin:7"]]);

    console.warn = () => {};
    redisConfig.redisClient = {
        isReady: true,
        del: async () => { throw new Error("Redis unavailable"); }
    };
    assert.equal(await projectCache.invalidateProject(7, 31), false);
});
