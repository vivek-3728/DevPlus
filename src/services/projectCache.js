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

const getProject = async (projectId, actor) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return undefined;

    try {
        const value = await client.get(buildProjectCacheKey(projectId, actor));
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
        await client.set(
            buildProjectCacheKey(project.id, actor),
            JSON.stringify(project),
            // EX applies a TTL in seconds, so Redis removes old data
            // automatically even if an invalidation is temporarily missed.
            { EX: redisConfig.getProjectCacheTtlSeconds() }
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
        await client.del(buildInvalidationKeys(projectId, ownerId));
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
