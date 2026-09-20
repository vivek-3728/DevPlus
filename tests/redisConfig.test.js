const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const redisConfig = require("../src/config/redis");
const {
    connectRedis,
    createRedisClient,
    getProjectCacheTtlSeconds
} = redisConfig;

test("Redis is disabled when REDIS_URL is absent", () => {
    let createCalls = 0;
    const client = createRedisClient({
        env: {},
        createClient: () => { createCalls += 1; }
    });

    assert.equal(client, null);
    assert.equal(createCalls, 0);
});

test("Redis client uses environment configuration and handles lifecycle events", () => {
    const fakeClient = new EventEmitter();
    const messages = [];
    let options;
    const logger = {
        log: (...values) => messages.push(values),
        warn: (...values) => messages.push(values),
        error: (...values) => messages.push(values)
    };

    const client = createRedisClient({
        env: { REDIS_URL: "redis://cache.internal:6379" },
        createClient: (receivedOptions) => {
            options = receivedOptions;
            return fakeClient;
        },
        logger
    });

    assert.equal(client, fakeClient);
    assert.deepEqual(options, {
        url: "redis://cache.internal:6379",
        disableOfflineQueue: true
    });
    assert.doesNotThrow(() => fakeClient.emit("error", new Error("offline")));
    fakeClient.emit("ready");
    fakeClient.emit("reconnecting");
    fakeClient.emit("end");
    assert.deepEqual(messages, [
        ["Redis cache error:", "offline"],
        ["Redis cache ready"],
        ["Redis cache reconnecting"],
        ["Redis cache connection closed"]
    ]);
});

test("invalid Redis configuration disables the optional cache instead of crashing", () => {
    const messages = [];
    const logger = {
        log() {},
        warn() {},
        error: (...values) => messages.push(values)
    };

    assert.doesNotThrow(() => {
        assert.equal(createRedisClient({
            env: { REDIS_URL: "http://user:secret@localhost:6379" },
            logger
        }), null);
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0][0], "Redis cache configuration failed:");
    assert.equal(messages.flat().join(" ").includes("secret"), false);
});

test("a throwing Redis client factory is handled as optional infrastructure", () => {
    const logger = { log() {}, warn() {}, error() {} };
    const client = createRedisClient({
        env: { REDIS_URL: "redis://localhost:6379" },
        createClient: () => { throw new Error("invalid configuration"); },
        logger
    });

    assert.equal(client, null);
});

test("project cache TTL defaults to 60 and accepts only positive integers", () => {
    assert.equal(getProjectCacheTtlSeconds({}), 60);
    assert.equal(getProjectCacheTtlSeconds({ REDIS_PROJECT_TTL_SECONDS: "120" }), 120);
    assert.equal(getProjectCacheTtlSeconds({ REDIS_PROJECT_TTL_SECONDS: "0" }), 60);
    assert.equal(getProjectCacheTtlSeconds({ REDIS_PROJECT_TTL_SECONDS: "1.5" }), 60);
    assert.equal(getProjectCacheTtlSeconds({ REDIS_PROJECT_TTL_SECONDS: "abc" }), 60);
});

test("Redis operation timeout defaults to 500 milliseconds and validates overrides", () => {
    assert.equal(redisConfig.getRedisOperationTimeoutMs({}), 500);
    assert.equal(redisConfig.getRedisOperationTimeoutMs({ REDIS_OPERATION_TIMEOUT_MS: "250" }), 250);
    assert.equal(redisConfig.getRedisOperationTimeoutMs({ REDIS_OPERATION_TIMEOUT_MS: "0" }), 500);
    assert.equal(redisConfig.getRedisOperationTimeoutMs({ REDIS_OPERATION_TIMEOUT_MS: "2.5" }), 500);
});

test("connectRedis is a no-op when Redis is disabled or already open", async () => {
    assert.equal(await connectRedis(null), false);

    let connectCalls = 0;
    const alreadyOpen = {
        isOpen: true,
        connect: async () => { connectCalls += 1; }
    };
    assert.equal(await connectRedis(alreadyOpen), false);
    assert.equal(connectCalls, 0);
});

test("connectRedis catches connection failures so Redis stays optional", async () => {
    const failure = new Error("connection refused");
    const messages = [];
    const logger = {
        error: (...values) => messages.push(values)
    };
    const client = {
        isOpen: false,
        connect: async () => { throw failure; }
    };

    assert.equal(await connectRedis(client, logger), false);
    assert.deepEqual(messages, [["Redis cache connection failed:", failure.message]]);
});

test("timed-out clients are destroyed and replaced for future cache attempts", async () => {
    let destroyed = 0;
    let connected = 0;
    const failedClient = { destroy: () => { destroyed += 1; } };
    const replacementClient = new EventEmitter();
    replacementClient.isOpen = false;
    replacementClient.connect = async () => { connected += 1; };
    const logger = { log() {}, warn() {}, error() {} };
    const originalClient = redisConfig.redisClient;
    redisConfig.redisClient = failedClient;

    try {
        assert.equal(redisConfig.recycleRedisClient(failedClient, {
            env: { REDIS_URL: "redis://localhost:6379" },
            createClient: () => replacementClient,
            logger
        }), true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(destroyed, 1);
        assert.equal(connected, 1);
        assert.equal(redisConfig.redisClient, replacementClient);
    } finally {
        redisConfig.redisClient = originalClient;
    }
});
