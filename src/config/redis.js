require("dotenv").config();

const { createClient: createNodeRedisClient } = require("redis");

const DEFAULT_PROJECT_CACHE_TTL_SECONDS = 60;

// TTL means "time to live": Redis automatically removes the cached value
// after this many seconds, which limits how long stale data can survive.
const getProjectCacheTtlSeconds = (env = process.env) => {
    const rawTtl = env.REDIS_PROJECT_TTL_SECONDS;
    if (!/^\d+$/.test(rawTtl ?? "")) return DEFAULT_PROJECT_CACHE_TTL_SECONDS;

    const ttl = Number(rawTtl);
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

    // Redis is an optional cache. Without a URL, DevPulse simply uses
    // PostgreSQL for every request instead of guessing connection settings.
    if (!url) return null;

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
    // listener keeps a Redis outage from terminating the API process. Log only
    // the error message; never print REDIS_URL because it may contain secrets.
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
        // Redis improves performance but is not required for correctness.
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
