require("dotenv").config();

const { createClient: createNodeRedisClient } = require("redis");

const DEFAULT_PROJECT_CACHE_TTL_SECONDS = 60;
const DEFAULT_PROJECT_CACHE_TTL_JITTER_SECONDS = 10;
const DEFAULT_REDIS_OPERATION_TIMEOUT_MS = 500;
const connectionAttempts = new WeakMap();

const readPositiveInteger = (value, defaultValue) => {
    if (!/^\d+$/.test(value ?? "")) return defaultValue;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
};

// TTL means "time to live": Redis automatically removes the cached value
// after this many seconds, which limits how long stale data can survive.
const getProjectCacheTtlSeconds = (env = process.env) => {
    return readPositiveInteger(
        env.REDIS_PROJECT_TTL_SECONDS,
        DEFAULT_PROJECT_CACHE_TTL_SECONDS
    );
};

const readNonNegativeInteger = (value, defaultValue) => {
    if (!/^\d+$/.test(value ?? "")) return defaultValue;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : defaultValue;
};

// Adding a small random amount spreads expiration times across several
// seconds. This reduces the chance that many popular keys expire together and
// all send PostgreSQL queries at the same moment.
const getProjectCacheWriteTtlSeconds = (
    env = process.env,
    random = Math.random
) => {
    const baseTtl = getProjectCacheTtlSeconds(env);
    const configuredJitter = readNonNegativeInteger(
        env.REDIS_PROJECT_TTL_JITTER_SECONDS,
        DEFAULT_PROJECT_CACHE_TTL_JITTER_SECONDS
    );

    // Jitter is capped at 25% of the base TTL. A configuration mistake cannot
    // silently turn a short cache lifetime into a very long one.
    const boundedJitter = Math.min(configuredJitter, Math.floor(baseTtl / 4));
    const sample = Math.min(1, Math.max(0, Number(random()) || 0));
    const addedSeconds = Math.min(
        boundedJitter,
        Math.floor(sample * (boundedJitter + 1))
    );
    return baseTtl + addedSeconds;
};

// Cache operations have a short deadline so an unresponsive Redis connection
// cannot hold an HTTP request open indefinitely.
const getRedisOperationTimeoutMs = (env = process.env) => readPositiveInteger(
    env.REDIS_OPERATION_TIMEOUT_MS,
    DEFAULT_REDIS_OPERATION_TIMEOUT_MS
);

const createRedisClient = ({
    env = process.env,
    createClient = createNodeRedisClient,
    logger = console
} = {}) => {
    const url = env.REDIS_URL?.trim();

    // Redis is an optional cache. Without a URL, DevPulse simply uses
    // PostgreSQL for every request instead of guessing connection settings.
    if (!url) return null;

    try {
        const client = createClient({
            url,
            // Do not queue cache commands while Redis is offline. Failing quickly
            // lets the request fall back to PostgreSQL without an unnecessary wait.
            disableOfflineQueue: true
        });

        client.on("ready", () => logger.log("Redis cache ready"));
        client.on("reconnecting", () => logger.warn("Redis cache reconnecting"));
        client.on("end", () => logger.warn("Redis cache connection closed"));

        // Node.js EventEmitters throw unhandled "error" events. Registering this
        // listener keeps a Redis outage from terminating the API process.
        client.on("error", (error) => logger.error("Redis cache error:", error.message));
        return client;
    } catch {
        // URL parsing happens while createClient() runs and can throw before
        // connect(). Keep the diagnostic generic so credentials in REDIS_URL
        // are never copied into logs.
        logger.error("Redis cache configuration failed:");
        return null;
    }
};

const redisClient = createRedisClient();

const connectRedis = async (client = module.exports.redisClient, logger = console) => {
    if (!client) return false;

    // Startup and timeout recovery can ask for a connection simultaneously.
    // Reusing the same Promise prevents duplicate connect() calls on one client.
    const existingAttempt = connectionAttempts.get(client);
    if (existingAttempt) return existingAttempt;
    if (client.isOpen) return false;

    const attempt = (async () => {
        try {
            await client.connect();
            return true;
        } catch (error) {
            // Redis improves performance but is not required for correctness.
            logger.error("Redis cache connection failed:", error.message);
            return false;
        }
    })();
    connectionAttempts.set(client, attempt);

    try {
        return await attempt;
    } finally {
        if (connectionAttempts.get(client) === attempt) {
            connectionAttempts.delete(client);
        }
    }
};

const disconnectRedis = async (
    client = module.exports.redisClient,
    logger = console
) => {
    if (!client?.isOpen) return false;

    try {
        // Cached data is disposable, so destroy() is appropriate during
        // shutdown: it closes promptly and rejects commands still waiting.
        client.destroy();
        connectionAttempts.delete(client);
        return true;
    } catch (error) {
        logger.warn("Redis cache disconnect failed:", error.message);
        return false;
    }
};

const recycleRedisClient = (failedClient, {
    env = process.env,
    createClient = createNodeRedisClient,
    logger = console
} = {}) => {
    // Multiple requests can time out together. Only the first one that still
    // owns the shared client should destroy and replace it.
    if (!failedClient || failedClient !== module.exports.redisClient) return false;

    try {
        // destroy() rejects every command still waiting on the dead connection,
        // preventing timed-out Promises from accumulating in memory.
        failedClient.destroy();
    } catch {
        logger.warn("Redis cache client cleanup failed");
    }

    const replacement = createRedisClient({ env, createClient, logger });
    module.exports.redisClient = replacement;
    if (replacement) void connectRedis(replacement, logger);
    return true;
};

module.exports = {
    redisClient,
    connectRedis,
    disconnectRedis,
    createRedisClient,
    recycleRedisClient,
    getProjectCacheTtlSeconds,
    getProjectCacheWriteTtlSeconds,
    getRedisOperationTimeoutMs
};
