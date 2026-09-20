const redisConfig = require("../config/redis");

// Cache keys include the authorization scope. A normal user's verified JWT ID
// becomes part of the key, while administrators use a separate namespace.
const buildProjectCacheKey = (projectId, actor) => actor.role === "admin"
    ? `devpulse:project:admin:${projectId}`
    : `devpulse:project:user:${actor.userId}:${projectId}`;

// Updates and deletes can affect both the owner's cached view and the
// administrator's view. Legacy NULL-owned rows have no user key to remove.
const buildInvalidationKeys = (projectId, ownerId) => [
    `devpulse:project:admin:${projectId}`,
    ...(ownerId == null
        ? []
        : [`devpulse:project:user:${ownerId}:${projectId}`])
];

const runRedisCommand = async (client, command) => {
    const timeoutMs = redisConfig.getRedisOperationTimeoutMs();
    let timeoutId;
    const timeoutError = new Error(`Redis cache operation timed out after ${timeoutMs}ms`);
    timeoutError.code = "REDIS_CACHE_TIMEOUT";

    try {
        return await Promise.race([
            // Starting from a resolved Promise also converts a synchronous
            // client exception into a normal rejected Promise.
            Promise.resolve().then(command),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(timeoutError), timeoutMs);
            })
        ]);
    } catch (error) {
        if (error.code === "REDIS_CACHE_TIMEOUT") {
            // A timed-out command can remain queued inside node-redis. Destroy
            // that connection so pending commands reject, then reconnect a
            // fresh optional client for later requests.
            redisConfig.recycleRedisClient(client);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
};

const getProject = async (projectId, actor) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return undefined;

    try {
        const value = await runRedisCommand(
            client,
            () => client.get(buildProjectCacheKey(projectId, actor))
        );
        return value === null ? undefined : JSON.parse(value);
    } catch (error) {
        // A cache read failure is the same as a cache miss. The project service
        // will continue to PostgreSQL, which remains the source of truth.
        console.warn("Redis project cache read failed:", error.message);
        return undefined;
    }
};

const setProject = async (project, actor) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return false;

    try {
        await runRedisCommand(
            client,
            () => client.set(
                buildProjectCacheKey(project.id, actor),
                JSON.stringify(project),
                // EX applies a TTL in seconds, so Redis removes old data
                // automatically even if an invalidation is temporarily missed.
                { EX: redisConfig.getProjectCacheTtlSeconds() }
            )
        );
        return true;
    } catch (error) {
        // Returning false keeps Redis failures local to this optional layer.
        // PostgreSQL errors are handled elsewhere and are never swallowed here.
        console.warn("Redis project cache write failed:", error.message);
        return false;
    }
};

const invalidateProject = async (projectId, ownerId) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return false;

    try {
        await runRedisCommand(
            client,
            () => client.del(buildInvalidationKeys(projectId, ownerId))
        );
        return true;
    } catch (error) {
        // The database mutation has already succeeded. A failed DEL must not
        // turn that successful source-of-truth write into an HTTP error.
        console.warn("Redis project cache invalidation failed:", error.message);
        return false;
    }
};

module.exports = {
    buildProjectCacheKey,
    buildInvalidationKeys,
    getProject,
    setProject,
    invalidateProject
};
