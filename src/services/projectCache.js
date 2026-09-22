const redisConfig = require("../config/redis");

// Cache keys include the authorization scope. A normal user's verified JWT ID
// becomes part of the key, while administrators use a separate namespace.
const buildProjectCacheKey = (projectId, actor, version) => actor.role === "admin"
    ? `devpulse:project:admin:v${version}:${projectId}`
    : `devpulse:project:user:${actor.userId}:v${version}:${projectId}`;

const buildProjectVersionKey = (projectId) =>
    `devpulse:project-version:${projectId}`;

const toCacheableProject = (project) => ({
    id: project.id,
    name: project.name,
    environment: project.environment,
    owner_id: project.owner_id,
    ...(project.created_at === undefined
        ? {}
        : { created_at: project.created_at })
});

const toCacheableProjectList = (response) => ({
    page: response.page,
    limit: response.limit,
    total: response.total,
    totalPages: response.totalPages,
    projects: response.projects.map(toCacheableProject)
});

// List caches use a separate namespace for each authorization scope. An admin
// can see every project, while a normal user can see only their own projects,
// so those responses must never share a key.
const buildProjectListScope = (actor) => actor.role === "admin"
    ? "admin"
    : `user:${actor.userId}`;

const buildProjectListVersionKey = (actor) =>
    `devpulse:projects:list-version:${buildProjectListScope(actor)}`;

const buildProjectListVersionKeys = (ownerId) => [
    "devpulse:projects:list-version:admin",
    ...(ownerId == null
        ? []
        : [`devpulse:projects:list-version:user:${ownerId}`])
];

// The service passes an already-normalized query. Writing fields in one fixed
// order means equivalent requests create exactly the same deterministic key,
// even if their original URL parameters appeared in a different order.
const buildProjectListQueryFingerprint = (query) => [
    ["page", query.page],
    ["limit", query.limit],
    ["environment", query.environment ?? ""],
    ["search", query.search ?? ""],
    ["sort", query.sort],
    ["order", query.order]
]
    .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
    .join("&");

const buildProjectListCacheKey = (query, actor, version) =>
    `devpulse:projects:list:${buildProjectListScope(actor)}:v${version}:${buildProjectListQueryFingerprint(query)}`;

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
        const storedVersion = await runRedisCommand(
            client,
            () => client.get(buildProjectVersionKey(projectId))
        );
        const version = storedVersion ?? "0";
        if (!/^\d+$/.test(version)) {
            throw new Error("Redis project cache version is invalid");
        }

        const cacheKey = buildProjectCacheKey(projectId, actor, version);
        const value = await runRedisCommand(
            client,
            () => client.get(cacheKey)
        );
        return {
            value: value === null ? undefined : JSON.parse(value),
            cacheKey
        };
    } catch (error) {
        // A cache read failure is the same as a cache miss. The project service
        // will continue to PostgreSQL, which remains the source of truth.
        console.warn("Redis project cache read failed:", error.message);
        return undefined;
    }
};

const setProject = async (cacheKey, project) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady || !cacheKey) return false;

    try {
        await runRedisCommand(
            client,
            () => client.set(
                cacheKey,
                JSON.stringify(toCacheableProject(project)),
                // EX applies a TTL in seconds, so Redis removes old data
                // automatically even if an invalidation is temporarily missed.
                { EX: redisConfig.getProjectCacheWriteTtlSeconds() }
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
        await runRedisCommand(client, async () => {
            // One shared project version invalidates both the owner's and the
            // administrator's scoped keys. A read already in progress keeps
            // its old key, so it cannot repopulate the new active namespace.
            const transaction = client.multi();
            transaction.incr(buildProjectVersionKey(projectId));
            await transaction.exec();
        });
        return true;
    } catch (error) {
        // The database mutation has already succeeded. A failed version bump must not
        // turn that successful source-of-truth write into an HTTP error.
        console.warn("Redis project cache invalidation failed:", error.message);
        return false;
    }
};

const getProjectList = async (query, actor) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return undefined;

    try {
        const storedVersion = await runRedisCommand(
            client,
            () => client.get(buildProjectListVersionKey(actor))
        );
        const version = storedVersion ?? "0";
        if (!/^\d+$/.test(version)) {
            throw new Error("Redis project list version is invalid");
        }

        const cacheKey = buildProjectListCacheKey(query, actor, version);
        const value = await runRedisCommand(client, () => client.get(cacheKey));

        // Returning the exact key used for the read prevents a concurrent
        // mutation from making this request populate a newer namespace with
        // an older PostgreSQL result.
        return {
            value: value === null ? undefined : JSON.parse(value),
            cacheKey
        };
    } catch (error) {
        console.warn("Redis project list cache read failed:", error.message);
        return undefined;
    }
};

const setProjectList = async (cacheKey, query, response) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady || !cacheKey) return false;

    try {
        await runRedisCommand(
            client,
            () => client.set(
                cacheKey,
                // The fingerprint travels with the response. On a cache hit,
                // the service verifies that Redis returned data for the exact
                // normalized query requested by this caller.
                JSON.stringify({
                    queryFingerprint: buildProjectListQueryFingerprint(query),
                    response: toCacheableProjectList(response)
                }),
                { EX: redisConfig.getProjectCacheWriteTtlSeconds() }
            )
        );
        return true;
    } catch (error) {
        console.warn("Redis project list cache write failed:", error.message);
        return false;
    }
};

const invalidateProjectLists = async (ownerId) => {
    const client = redisConfig.redisClient;
    if (!client?.isReady) return false;

    try {
        await runRedisCommand(client, async () => {
            // Incrementing small version keys makes every older list cache key
            // unreachable immediately. Old values disappear through TTL, so
            // this never scans Redis with KEYS or deletes an unknown key set.
            const transaction = client.multi();
            for (const key of buildProjectListVersionKeys(ownerId)) {
                transaction.incr(key);
            }
            await transaction.exec();
        });
        return true;
    } catch (error) {
        // PostgreSQL has already succeeded when mutations call this helper.
        // Redis remains optional, and TTL bounds staleness after a failure.
        console.warn("Redis project list cache invalidation failed:", error.message);
        return false;
    }
};

module.exports = {
    buildProjectCacheKey,
    buildProjectVersionKey,
    buildProjectListCacheKey,
    buildProjectListQueryFingerprint,
    buildProjectListVersionKeys,
    getProject,
    setProject,
    invalidateProject,
    getProjectList,
    setProjectList,
    invalidateProjectLists
};
