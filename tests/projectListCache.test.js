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
const query = {
    page: 2,
    limit: 25,
    offset: 25,
    environment: "production",
    search: "dev api",
    sort: "name",
    order: "desc"
};
const response = {
    page: 2,
    limit: 25,
    total: 30,
    totalPages: 2,
    projects: [{
        id: 7,
        name: "Dev API",
        environment: "production",
        owner_id: 31
    }]
};

test("normalized list queries build deterministic actor-scoped cache keys", () => {
    const reorderedQuery = {
        order: "desc",
        search: "dev api",
        environment: "production",
        offset: 25,
        limit: 25,
        page: 2,
        sort: "name"
    };

    const expectedUserKey = "devpulse:projects:list:user:31:v4:page=2&limit=25&environment=production&search=dev%20api&sort=name&order=desc";
    assert.equal(projectCache.buildProjectListCacheKey(query, user, 4), expectedUserKey);
    assert.equal(projectCache.buildProjectListCacheKey(reorderedQuery, user, 4), expectedUserKey);
    assert.equal(
        projectCache.buildProjectListCacheKey(query, { userId: 44, role: "user" }, 4),
        expectedUserKey.replace("user:31", "user:44")
    );
    assert.equal(
        projectCache.buildProjectListCacheKey(query, admin, 4),
        expectedUserKey.replace("user:31", "admin")
    );
});

test("list cache reads the scope version before reading the cached response", async () => {
    const calls = [];
    redisConfig.redisClient = {
        isReady: true,
        get: async (key) => {
            calls.push(key);
            if (key === "devpulse:projects:list-version:user:31") return "4";
            return JSON.stringify({
                queryFingerprint: "page=2&limit=25&environment=production&search=dev%20api&sort=name&order=desc",
                response
            });
        }
    };

    const result = await projectCache.getProjectList(query, user);
    assert.deepEqual(result, {
        value: {
            queryFingerprint: "page=2&limit=25&environment=production&search=dev%20api&sort=name&order=desc",
            response
        },
        cacheKey: "devpulse:projects:list:user:31:v4:page=2&limit=25&environment=production&search=dev%20api&sort=name&order=desc"
    });
    assert.deepEqual(calls, [
        "devpulse:projects:list-version:user:31",
        "devpulse:projects:list:user:31:v4:page=2&limit=25&environment=production&search=dev%20api&sort=name&order=desc"
    ]);
});

test("missing version and list value produce a writable cache miss context", async () => {
    redisConfig.redisClient = { isReady: true, get: async () => null };

    assert.deepEqual(await projectCache.getProjectList(query, admin), {
        value: undefined,
        cacheKey: "devpulse:projects:list:admin:v0:page=2&limit=25&environment=production&search=dev%20api&sort=name&order=desc"
    });
});

test("list cache writes use the existing configurable project TTL", async () => {
    const calls = [];
    redisConfig.getProjectCacheWriteTtlSeconds = () => 45;
    redisConfig.redisClient = {
        isReady: true,
        set: async (...args) => { calls.push(args); }
    };
    const cacheKey = "devpulse:projects:list:user:31:v4:query";

    assert.equal(await projectCache.setProjectList(cacheKey, query, response), true);
    assert.deepEqual(calls, [[
        cacheKey,
        JSON.stringify({
            queryFingerprint: "page=2&limit=25&environment=production&search=dev%20api&sort=name&order=desc",
            response
        }),
        { EX: 45 }
    ]]);
});

test("list cache storage strips unexpected sensitive project fields", async () => {
    const calls = [];
    redisConfig.getProjectCacheWriteTtlSeconds = () => 60;
    redisConfig.redisClient = {
        isReady: true,
        set: async (...args) => { calls.push(args); }
    };
    const pollutedResponse = {
        ...response,
        projects: [{
            ...response.projects[0],
            password_hash: "must not be cached",
            token: "must not be cached"
        }]
    };

    await projectCache.setProjectList("list-key", query, pollutedResponse);

    const storedEnvelope = JSON.parse(calls[0][1]);
    assert.deepEqual(storedEnvelope.response, response);
});

test("list namespace invalidation increments owner and admin versions without scanning", async () => {
    const commands = [];
    const transaction = {
        incr: (key) => { commands.push(["incr", key]); return transaction; },
        exec: async () => { commands.push(["exec"]); }
    };
    redisConfig.redisClient = {
        isReady: true,
        multi: () => transaction
    };

    assert.equal(await projectCache.invalidateProjectLists(31), true);
    assert.deepEqual(commands, [
        ["incr", "devpulse:projects:list-version:admin"],
        ["incr", "devpulse:projects:list-version:user:31"],
        ["exec"]
    ]);
});

test("legacy list invalidation increments only the administrator namespace", async () => {
    const commands = [];
    const transaction = {
        incr: (key) => { commands.push(key); return transaction; },
        exec: async () => {}
    };
    redisConfig.redisClient = { isReady: true, multi: () => transaction };

    assert.equal(await projectCache.invalidateProjectLists(null), true);
    assert.deepEqual(commands, ["devpulse:projects:list-version:admin"]);
});

test("Redis list read, write, and invalidation failures remain non-fatal", async () => {
    console.warn = () => {};
    redisConfig.redisClient = {
        isReady: true,
        get: async () => { throw new Error("Redis unavailable"); },
        set: async () => { throw new Error("Redis unavailable"); },
        multi: () => ({
            incr() { return this; },
            exec: async () => { throw new Error("Redis unavailable"); }
        })
    };

    assert.equal(await projectCache.getProjectList(query, user), undefined);
    assert.equal(await projectCache.setProjectList("list-key", query, response), false);
    assert.equal(await projectCache.invalidateProjectLists(31), false);
});
