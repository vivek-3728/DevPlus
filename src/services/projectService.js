// Services contain project rules. They do not read HTTP requests or write SQL.
const projectRepository = require("../repositories/projectRepository");
const projectCache = require("./projectCache");
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
            || (Number.isSafeInteger(project.owner_id) && project.owner_id > 0));

    return hasProjectShape
        && project.id === projectId
        && actorCanAccessProject(project, actor);
};

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

    // The owner restriction is part of both SQL queries. This prevents counts
    // and empty/non-empty pages from revealing another user's projects.
    const result = await projectRepository.queryProjects({
        ...query,
        ownerId: actor.role === "admin" ? undefined : actor.userId
    });

    return {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit),
        projects: result.projects
    };
};

const getProjectById = async (id, actor) => {
    const projectId = validateId(id);
    const cachedProject = await projectCache.getProject(projectId, actor);

    // Actor-scoped keys are the first isolation boundary. This ownership check
    // is a second boundary, so even a misplaced cache value cannot grant access.
    if (isUsableCachedProject(cachedProject, projectId, actor)) {
        return cachedProject;
    }

    // Cache miss: read and authorize the source-of-truth row before caching it.
    // Consequently 403, 404, and PostgreSQL failures never become cache values.
    const project = await getAuthorizedProject(projectId, actor);
    await projectCache.setProject(project, actor);
    return project;
};

const createProject = async (name, environment, actor) => {
    validateProject(name, environment);
    // ownerId comes only from the verified JWT actor, never from req.body.
    return projectRepository.createProject({ name, environment, ownerId: actor.userId });
};

const updateProject = async (id, name, environment, actor) => {
    const projectId = validateId(id);
    validateProject(name, environment);
    await getAuthorizedProject(projectId, actor);
    // UPDATE ... RETURNING tells us whether a row existed in the same query.
    const project = await projectRepository.updateProject(projectId, { name, environment });
    if (!project) {
        throw new Apperror("Project not found", 404);
    }
    return project;
};

const deleteProject = async (id, actor) => {
    const projectId = validateId(id);
    await getAuthorizedProject(projectId, actor);
    const project = await projectRepository.deleteProject(projectId);
    if (!project) {
        throw new Apperror("Project not found", 404);
    }
};

module.exports = {
    getProjects,
    getAllProjects,
    getProjectById,
    createProject,
    updateProject,
    deleteProject
};
