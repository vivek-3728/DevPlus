const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const projectRepository = require("../src/repositories/projectRepository");
const projectCache = require("../src/services/projectCache");
const projectService = require("../src/services/projectService");

const originalRepository = { ...projectRepository };
const originalCache = { ...projectCache };

afterEach(() => {
    for (const name of Object.keys(projectRepository)) {
        if (!(name in originalRepository)) delete projectRepository[name];
    }
    for (const [name, implementation] of Object.entries(originalRepository)) {
        projectRepository[name] = implementation;
    }
    for (const name of Object.keys(projectCache)) {
        if (!(name in originalCache)) delete projectCache[name];
    }
    for (const [name, implementation] of Object.entries(originalCache)) {
        projectCache[name] = implementation;
    }
});

const user = { userId: 31, role: "user" };
const admin = { userId: 1, role: "admin" };
const owned = {
    id: 7,
    name: "Dev API",
    environment: "production",
    owner_id: 31
};
const databasePage = { projects: [owned], total: 1 };
const listResponse = {
    page: 1,
    limit: 10,
    total: 1,
    totalPages: 1,
    projects: [owned]
};
const defaultFingerprint = "page=1&limit=10&environment=&search=&sort=id&order=asc";
const defaultEnvelope = {
    queryFingerprint: defaultFingerprint,
    response: listResponse
};

test("list cache miss queries PostgreSQL and populates the same versioned key", async () => {
    const writes = [];
    let databaseReads = 0;
    projectCache.getProjectList = async () => ({ value: undefined, cacheKey: "list-v3" });
    projectCache.setProjectList = async (...args) => { writes.push(args); return true; };
    projectRepository.queryProjects = async () => { databaseReads += 1; return databasePage; };

    assert.deepEqual(await projectService.getProjects({}, user), listResponse);
    assert.equal(databaseReads, 1);
    assert.deepEqual(writes, [[
        "list-v3",
        {
            page: 1,
            limit: 10,
            offset: 0,
            environment: undefined,
            search: undefined,
            sort: "id",
            order: "asc"
        },
        listResponse
    ]]);
});

test("concurrent identical list misses share one PostgreSQL query", async () => {
    let releaseDatabase;
    const gate = new Promise(resolve => { releaseDatabase = resolve; });
    let databaseReads = 0;
    let cacheWrites = 0;
    projectCache.getProjectList = async () => ({ value: undefined, cacheKey: "list-v3" });
    projectCache.setProjectList = async () => { cacheWrites += 1; return true; };
    projectRepository.queryProjects = async () => {
        databaseReads += 1;
        await gate;
        return databasePage;
    };

    const first = projectService.getProjects({}, user);
    const second = projectService.getProjects({}, user);
    releaseDatabase();

    assert.deepEqual(await Promise.all([first, second]), [listResponse, listResponse]);
    assert.equal(databaseReads, 1);
    assert.equal(cacheWrites, 1);
});

test("a list read after create invalidation does not join an older version flight", async () => {
    let releaseOldRead;
    let markOldReadStarted;
    const oldReadGate = new Promise(resolve => { releaseOldRead = resolve; });
    const oldReadStarted = new Promise(resolve => { markOldReadStarted = resolve; });
    const created = { ...owned, id: 8, name: "New Project" };
    const freshPage = { projects: [owned, created], total: 2 };
    let version = 0;
    let databaseReads = 0;

    projectCache.getProjectList = async () => ({
        value: undefined,
        cacheKey: `devpulse:projects:list:user:31:v${version}:default`
    });
    projectCache.setProjectList = async () => true;
    projectCache.invalidateProjectLists = async () => { version += 1; return true; };
    projectRepository.queryProjects = async () => {
        databaseReads += 1;
        if (databaseReads === 1) {
            markOldReadStarted();
            await oldReadGate;
            return databasePage;
        }
        return freshPage;
    };
    projectRepository.createProject = async () => created;

    const oldRead = projectService.getProjects({}, user);
    await oldReadStarted;
    await projectService.createProject("New Project", "production", user);

    // The create bumped the list namespace before this request began, so this
    // request must not wait for or return the older version's in-flight page.
    const newRead = projectService.getProjects({}, user);
    releaseOldRead();

    assert.deepEqual(await oldRead, listResponse);
    assert.deepEqual(await newRead, {
        page: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
        projects: [owned, created]
    });
    assert.equal(databaseReads, 2);
});

test("valid list cache hit avoids PostgreSQL", async () => {
    let cacheWrites = 0;
    projectCache.getProjectList = async () => ({ value: defaultEnvelope, cacheKey: "list-v3" });
    projectCache.setProjectList = async () => { cacheWrites += 1; };
    projectRepository.queryProjects = async () => {
        assert.fail("PostgreSQL must not be queried on a valid list cache hit");
    };

    assert.deepEqual(await projectService.getProjects({}, user), listResponse);
    assert.equal(cacheWrites, 0);
});

test("foreign-owner cached rows cannot bypass list ownership", async () => {
    let databaseReads = 0;
    projectCache.getProjectList = async () => ({
        value: {
            queryFingerprint: defaultFingerprint,
            response: { ...listResponse, projects: [{ ...owned, owner_id: 44 }] }
        },
        cacheKey: "user-31-list"
    });
    projectCache.setProjectList = async () => true;
    projectRepository.queryProjects = async (query) => {
        databaseReads += 1;
        assert.equal(query.ownerId, 31);
        return databasePage;
    };

    assert.deepEqual(await projectService.getProjects({}, user), listResponse);
    assert.equal(databaseReads, 1);
});

test("a cached response for a different normalized query is ignored", async () => {
    let databaseReads = 0;
    projectCache.getProjectList = async () => ({
        value: {
            queryFingerprint: "page=1&limit=10&environment=development&search=&sort=id&order=asc",
            response: listResponse
        },
        cacheKey: "production-list"
    });
    projectCache.setProjectList = async () => true;
    projectRepository.queryProjects = async () => { databaseReads += 1; return databasePage; };

    await projectService.getProjects({ environment: "production" }, user);
    assert.equal(databaseReads, 1);
});

test("cache hits return only the documented project and pagination fields", async () => {
    projectCache.getProjectList = async () => ({
        value: {
            queryFingerprint: defaultFingerprint,
            response: {
                ...listResponse,
                internal: "do not return",
                projects: [{ ...owned, password_hash: "do not return" }]
            }
        },
        cacheKey: "user-31-list"
    });
    projectRepository.queryProjects = async () => assert.fail("unexpected database query");

    assert.deepEqual(await projectService.getProjects({}, user), listResponse);
});

test("combined query parameters are normalized before cache lookup", async () => {
    let receivedQuery;
    projectCache.getProjectList = async (normalizedQuery, actor) => {
        receivedQuery = { normalizedQuery, actor };
        return {
            value: {
                queryFingerprint: "page=2&limit=10&environment=production&search=dev%20api&sort=name&order=desc",
                response: { ...listResponse, page: 2 }
            },
            cacheKey: "combined"
        };
    };
    projectRepository.queryProjects = async () => assert.fail("unexpected database query");

    const result = await projectService.getProjects({
        search: "  dev api  ",
        environment: "production",
        page: "2",
        limit: "10",
        sort: "name",
        order: "DESC"
    }, admin);

    assert.equal(result.page, 2);
    assert.deepEqual(receivedQuery, {
        normalizedQuery: {
            page: 2,
            limit: 10,
            offset: 10,
            environment: "production",
            search: "dev api",
            sort: "name",
            order: "desc"
        },
        actor: admin
    });
});

test("Redis list failure falls back to the existing owner-scoped PostgreSQL query", async () => {
    let writes = 0;
    projectCache.getProjectList = async () => undefined;
    projectCache.setProjectList = async () => { writes += 1; };
    projectRepository.queryProjects = async (query) => {
        assert.equal(query.ownerId, 31);
        return databasePage;
    };

    assert.deepEqual(await projectService.getProjects({}, user), listResponse);
    assert.equal(writes, 0);
});

test("successful create invalidates owner and admin list namespaces", async () => {
    const calls = [];
    projectRepository.createProject = async (project) => {
        calls.push(["database", project]);
        return owned;
    };
    projectCache.invalidateProjectLists = async (ownerId) => {
        calls.push(["lists", ownerId]);
        return true;
    };

    assert.deepEqual(
        await projectService.createProject("Dev API", "production", user),
        owned
    );
    assert.deepEqual(calls, [
        ["database", { name: "Dev API", environment: "production", ownerId: 31 }],
        ["lists", 31]
    ]);
});

test("failed create does not invalidate list namespaces", async () => {
    const databaseError = new Error("create failed");
    let invalidations = 0;
    projectRepository.createProject = async () => { throw databaseError; };
    projectCache.invalidateProjectLists = async () => { invalidations += 1; };

    await assert.rejects(
        projectService.createProject("Dev API", "production", user),
        (error) => error === databaseError
    );
    assert.equal(invalidations, 0);
});

test("successful update and delete invalidate list namespaces for the actual owner", async () => {
    const invalidations = [];
    projectRepository.getProjectById = async () => owned;
    projectRepository.updateProject = async () => ({ ...owned, name: "Updated" });
    projectRepository.deleteProject = async () => ({ id: 7 });
    projectCache.invalidateProject = async () => true;
    projectCache.invalidateProjectLists = async (ownerId) => {
        invalidations.push(ownerId);
        return true;
    };

    await projectService.updateProject("7", "Updated", "production", admin);
    await projectService.deleteProject("7", admin);

    assert.deepEqual(invalidations, [31, 31]);
});
