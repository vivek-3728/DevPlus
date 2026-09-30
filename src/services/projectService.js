// Services contain project rules. They do not read HTTP requests or write SQL.
const projectRepository = require("../repositories/projectRepository");
const projectCache = require("./projectCache");
const { runSingleFlight } = require("./cacheSingleFlight");
const Apperror = require("../errors/Apperror");

// URL parameters are strings. Accept decimal positive integers that JavaScript
// can represent exactly; reject fractions, negative values and malformed IDs.
const validateId = (id) => {
    const projectId = Number(id);
    if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(projectId) || projectId <= 0) {
        throw new Apperror("Project ID must be a positive integer", 400);
    }
    return projectId;
};

const ALLOWED_ENVIRONMENTS = new Set(["production", "development"]);

// POST, PUT, and list filtering share the same environment values. Keeping one
// set prevents the write and read endpoints from slowly developing different rules.
const validateProject = (name, environment) => {
    if (typeof name !== "string" || name.trim().length === 0) {
        throw new Apperror("Name must be a nonblank string", 400);
    }
    if (!ALLOWED_ENVIRONMENTS.has(environment)) {
        throw new Apperror("Environment must be production or development", 400);
    }
};

// Administrators may inspect every project. A normal user's owner condition is
// applied in SQL so projects belonging to someone else never enter the result.
const getAllProjects = (actor) => actor.role === "admin"
    ? projectRepository.getAllProjects()
    : projectRepository.getProjectsByOwnerId(actor.userId);

const actorCanAccessProject = (project, actor) =>
    actor.role === "admin" || project.owner_id === actor.userId;

const getAuthorizedProject = async (projectId, actor) => {
    const project = await projectRepository.getProjectById(projectId);
    if (!project) {
        throw new Apperror("Project not found", 404);
    }

    // Strict ownership also keeps legacy NULL-owned projects hidden from
    // normal users. Administrators retain the Phase 3 bypass behavior.
    if (!actorCanAccessProject(project, actor)) {
        throw new Apperror("Forbidden", 403);
    }

    return project;
};

const isUsableCachedProject = (project, projectId, actor) => {
    // Redis contains serialized JSON, so treat its contents as untrusted input.
    // Checking the shape prevents a damaged or manually edited cache entry from
    // producing a partial API response.
    const hasProjectShape = project !== null
        && typeof project === "object"
        && !Array.isArray(project)
        && Number.isSafeInteger(project.id)
        && project.id > 0
        && typeof project.name === "string"
        && ALLOWED_ENVIRONMENTS.has(project.environment)
        && (project.owner_id === null
            || (Number.isSafeInteger(project.owner_id) && project.owner_id > 0))
        && (project.created_at === undefined
            || typeof project.created_at === "string");

    return hasProjectShape
        && project.id === projectId
        && actorCanAccessProject(project, actor);
};

// Cache hits are projected onto the public project shape. Redis is not trusted
// to decide which fields the API may expose, so unexpected authentication or
// internal properties are discarded.
const toPublicProject = (project) => ({
    id: project.id,
    name: project.name,
    environment: project.environment,
    owner_id: project.owner_id,
    ...(project.created_at === undefined
        ? {}
        : { created_at: project.created_at })
});

const ALLOWED_SORT_COLUMNS = new Set(["id", "name", "environment", "created_at"]);
const ALLOWED_SORT_ORDERS = new Set(["asc", "desc"]);
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

const readSingleQueryValue = (value, parameterName) => {
    if (value === undefined) return undefined;
    // Express represents repeated parameters such as ?page=1&page=2 as an
    // array. This API requires exactly one value for every supported option.
    if (typeof value !== "string") {
        throw new Apperror(`${parameterName} must have one value`, 400);
    }
    return value;
};

const parsePositiveInteger = (value, parameterName, defaultValue, maximum) => {
    const rawValue = readSingleQueryValue(value, parameterName);
    if (rawValue === undefined) return defaultValue;

    if (!/^\d+$/.test(rawValue)) {
        throw new Apperror(`${parameterName} must be a positive integer`, 400);
    }

    const parsedValue = Number(rawValue);
    if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
        throw new Apperror(`${parameterName} must be a positive integer`, 400);
    }
    if (maximum !== undefined && parsedValue > maximum) {
        throw new Apperror(`${parameterName} must be at most ${maximum}`, 400);
    }
    return parsedValue;
};

const normalizeProjectQuery = (rawQuery = {}) => {
    const page = parsePositiveInteger(rawQuery.page, "page", DEFAULT_PAGE);
    const limit = parsePositiveInteger(rawQuery.limit, "limit", DEFAULT_LIMIT, MAX_LIMIT);
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) {
        throw new Apperror("page is too large", 400);
    }

    const environment = readSingleQueryValue(rawQuery.environment, "environment");
    if (environment !== undefined && !ALLOWED_ENVIRONMENTS.has(environment)) {
        throw new Apperror("Environment must be production or development", 400);
    }

    const rawSearch = readSingleQueryValue(rawQuery.search, "search");
    const search = rawSearch?.trim() || undefined;
    if (search && search.length > 100) {
        throw new Apperror("search must be at most 100 characters", 400);
    }

    const sort = readSingleQueryValue(rawQuery.sort, "sort") ?? "id";
    if (!ALLOWED_SORT_COLUMNS.has(sort)) {
        throw new Apperror("sort must be id, name, environment, or created_at", 400);
    }

    const orderValue = readSingleQueryValue(rawQuery.order, "order") ?? "asc";
    const order = orderValue.toLowerCase();
    if (!ALLOWED_SORT_ORDERS.has(order)) {
        throw new Apperror("order must be asc or desc", 400);
    }

    return { page, limit, offset, environment, search, sort, order };
};

const getProjects = async (rawQuery, actor) => {
    const query = normalizeProjectQuery(rawQuery);
    const cachedList = await projectCache.getProjectList(query, actor);

    // Redis data is serialized external input, so validate both pagination
    // metadata and every row's ownership before returning a cached response.
    // Actor-scoped keys are the first boundary; this check is a second one.
        const cachedEnvelope = cachedList?.value;
        const cachedResponse = cachedEnvelope?.response;
        const isUsableCachedList = cachedEnvelope !== null
            && typeof cachedEnvelope === "object"
            && !Array.isArray(cachedEnvelope)
            && cachedEnvelope.queryFingerprint
                === projectCache.buildProjectListQueryFingerprint(query)
            && cachedResponse !== null
            && typeof cachedResponse === "object"
            && !Array.isArray(cachedResponse)
            && cachedResponse.page === query.page
            && cachedResponse.limit === query.limit
            && Number.isSafeInteger(cachedResponse.total)
            && cachedResponse.total >= 0
            && cachedResponse.totalPages
                === Math.ceil(cachedResponse.total / query.limit)
            && Array.isArray(cachedResponse.projects)
            && cachedResponse.projects.length <= query.limit
            && cachedResponse.projects.length <= cachedResponse.total
            && cachedResponse.projects.every((project) =>
                isUsableCachedProject(project, project?.id, actor));

        if (isUsableCachedList) {
        // Return only the public project fields. This prevents an accidentally
        // polluted Redis value from adding internal properties to the API.
            return {
                page: cachedResponse.page,
                limit: cachedResponse.limit,
                total: cachedResponse.total,
                totalPages: cachedResponse.totalPages,
                projects: cachedResponse.projects.map(toPublicProject)
            };
        }

    const loadFromDatabase = async () => {
    // The owner restriction is part of both SQL queries. This prevents counts
    // and empty/non-empty pages from revealing another user's projects.
        const result = await projectRepository.queryProjects({
            ...query,
            ownerId: actor.role === "admin" ? undefined : actor.userId
        });

        const response = {
            page: query.page,
            limit: query.limit,
            total: result.total,
            totalPages: Math.ceil(result.total / query.limit),
            projects: result.projects
        };

    // A failed Redis read returns no cache key. PostgreSQL still serves the
    // request, but we avoid a second Redis attempt during the same failure.
        if (cachedList?.cacheKey) {
            await projectCache.setProjectList(cachedList.cacheKey, query, response);
        }
        return response;
    };

    // The exact versioned cache key is also the single-flight boundary. If a
    // mutation advances the namespace, a later request gets a different key
    // and cannot join work that started before the mutation completed.
    return cachedList?.cacheKey
        ? runSingleFlight(`load:${cachedList.cacheKey}`, loadFromDatabase)
        : loadFromDatabase();
};

const getProjectById = async (id, actor) => {
    const projectId = validateId(id);
    const cachedProject = await projectCache.getProject(projectId, actor);
    const cachedValue = cachedProject?.value;

    // Actor-scoped keys are the first isolation boundary. This ownership
    // check is a second boundary, so a misplaced value cannot grant access.
    if (isUsableCachedProject(cachedValue, projectId, actor)) {
        return toPublicProject(cachedValue);
    }

    const loadFromDatabase = async () => {
        // Cache miss: read and authorize PostgreSQL before caching. The exact
        // versioned miss key prevents a concurrent mutation from making this
        // older result active after invalidation.
        const project = await getAuthorizedProject(projectId, actor);
        if (cachedProject?.cacheKey) {
            await projectCache.setProject(cachedProject.cacheKey, project);
        }
        return project;
    };

    // Do not use a permanent logical flight key: it would let a request that
    // starts after invalidation join an older load. Redis failures provide no
    // trustworthy version context, so those requests simply use PostgreSQL.
    return cachedProject?.cacheKey
        ? runSingleFlight(`load:${cachedProject.cacheKey}`, loadFromDatabase)
        : loadFromDatabase();
};

const createProject = async (name, environment, actor) => {
    validateProject(name, environment);
    // ownerId comes only from the verified JWT actor, never from req.body.
    const project = await projectRepository.createProject({
        name,
        environment,
        ownerId: actor.userId
    });

    // The new row can change both the owner's query results and every admin
    // query. Version invalidation runs only after PostgreSQL commits.
    await projectCache.invalidateProjectLists(actor.userId);
    return project;
};

const updateProject = async (id, name, environment, actor) => {
    const projectId = validateId(id);
    validateProject(name, environment);
    const existingProject = await getAuthorizedProject(projectId, actor);
    // UPDATE ... RETURNING tells us whether a row existed in the same query.
    const project = await projectRepository.updateProject(projectId, { name, environment });
    if (!project) {
        throw new Apperror("Project not found", 404);
    }

    // PostgreSQL must succeed first because it is the source of truth. The
    // cache service treats Redis version-increment failures as non-fatal and the short TTL
    // still limits how long a stale value can remain.
    await projectCache.invalidateProject(projectId, existingProject.owner_id);
    await projectCache.invalidateProjectLists(existingProject.owner_id);
    return project;
};

const deleteProject = async (id, actor) => {
    const projectId = validateId(id);
    const existingProject = await getAuthorizedProject(projectId, actor);
    const project = await projectRepository.deleteProject(projectId);
    if (!project) {
        throw new Apperror("Project not found", 404);
    }
    await projectCache.invalidateProject(projectId, existingProject.owner_id);
    await projectCache.invalidateProjectLists(existingProject.owner_id);
    // The controller needs only this safe routing metadata to notify authorized
    // Socket.IO rooms after the deletion has committed.
    return { id: project.id, owner_id: existingProject.owner_id };
};

module.exports = {
    getProjects,
    getAllProjects,
    getProjectById,
    createProject,
    updateProject,
    deleteProject
};
