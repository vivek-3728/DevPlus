const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const projectRepository = require("../src/repositories/projectRepository");
const projectCache = require("../src/services/projectCache");
const projectService = require("../src/services/projectService");

const originalRepository = { ...projectRepository };
const originalCache = { ...projectCache };

afterEach(() => {
    for (const [name, implementation] of Object.entries(originalRepository)) {
        projectRepository[name] = implementation;
    }
    for (const [name, implementation] of Object.entries(originalCache)) {
        projectCache[name] = implementation;
    }
});

const user = { userId: 31, role: "user" };
const admin = { userId: 1, role: "admin" };
const owned = {
    id: 7,
    name: "Owned",
    environment: "development",
    owner_id: 31
};

test("cache miss queries PostgreSQL and caches only the authorized project", async () => {
    const writes = [];
    let databaseReads = 0;
    projectCache.getProject = async () => undefined;
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return owned;
    };
    projectCache.setProject = async (...args) => {
        writes.push(args);
        return true;
    };

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(databaseReads, 1);
    assert.deepEqual(writes, [[owned, user]]);
});

test("valid cache hit returns the project without querying PostgreSQL", async () => {
    let cacheWrites = 0;
    projectCache.getProject = async () => owned;
    projectCache.setProject = async () => { cacheWrites += 1; };
    projectRepository.getProjectById = async () => {
        assert.fail("PostgreSQL must not be queried on a valid cache hit");
    };

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(cacheWrites, 0);
});

test("wrong project ID in cache falls back to PostgreSQL", async () => {
    let cacheReads = 0;
    let databaseReads = 0;
    projectCache.getProject = async () => {
        cacheReads += 1;
        return { ...owned, id: 8 };
    };
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return owned;
    };
    projectCache.setProject = async () => true;

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(cacheReads, 1);
    assert.equal(databaseReads, 1);
});

test("incomplete cached project data falls back to PostgreSQL", async () => {
    let cacheReads = 0;
    let databaseReads = 0;
    projectCache.getProject = async () => {
        cacheReads += 1;
        return { id: 7, owner_id: 31 };
    };
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return owned;
    };
    projectCache.setProject = async () => true;

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(cacheReads, 1);
    assert.equal(databaseReads, 1);
});

for (const cachedOwner of [44, null]) {
    test(`cached owner ${cachedOwner} cannot bypass current database authorization`, async () => {
        let cacheReads = 0;
        let cacheWrites = 0;
        projectCache.getProject = async () => {
            cacheReads += 1;
            return { ...owned, owner_id: cachedOwner };
        };
        projectRepository.getProjectById = async () => ({ ...owned, owner_id: cachedOwner });
        projectCache.setProject = async () => { cacheWrites += 1; };

        await assert.rejects(
            projectService.getProjectById("7", user),
            (error) => error.statusCode === 403
        );
        assert.equal(cacheReads, 1);
        assert.equal(cacheWrites, 0);
    });
}

test("administrator cache hits retain access to owned and legacy projects", async () => {
    let databaseReads = 0;
    projectRepository.getProjectById = async () => {
        databaseReads += 1;
        return undefined;
    };

    projectCache.getProject = async () => ({ ...owned, owner_id: 44 });
    assert.equal((await projectService.getProjectById("7", admin)).owner_id, 44);

    projectCache.getProject = async () => ({ ...owned, owner_id: null });
    assert.equal((await projectService.getProjectById("7", admin)).owner_id, null);
    assert.equal(databaseReads, 0);
});

test("404 and PostgreSQL errors are not cached", async () => {
    let cacheReads = 0;
    let cacheWrites = 0;
    projectCache.getProject = async () => { cacheReads += 1; return undefined; };
    projectCache.setProject = async () => { cacheWrites += 1; };
    projectRepository.getProjectById = async () => undefined;

    await assert.rejects(
        projectService.getProjectById("99", user),
        (error) => error.statusCode === 404
    );

    const databaseError = new Error("database unavailable");
    projectRepository.getProjectById = async () => { throw databaseError; };
    await assert.rejects(
        projectService.getProjectById("99", user),
        (error) => error === databaseError
    );
    assert.equal(cacheReads, 2);
    assert.equal(cacheWrites, 0);
});

test("invalid IDs are rejected before cache or PostgreSQL access", async () => {
    let cacheReads = 0;
    let databaseReads = 0;
    projectCache.getProject = async () => { cacheReads += 1; };
    projectRepository.getProjectById = async () => { databaseReads += 1; };

    await assert.rejects(
        projectService.getProjectById("abc", user),
        (error) => error.statusCode === 400
    );
    assert.equal(cacheReads, 0);
    assert.equal(databaseReads, 0);
});

test("Redis miss or failed cache population still returns PostgreSQL data", async () => {
    let cacheReads = 0;
    projectCache.getProject = async () => { cacheReads += 1; return undefined; };
    projectRepository.getProjectById = async () => owned;
    projectCache.setProject = async () => false;

    assert.deepEqual(await projectService.getProjectById("7", user), owned);
    assert.equal(cacheReads, 1);
});

test("paginated list queries never use the individual-project cache", async () => {
    let cacheCalls = 0;
    projectCache.getProject = async () => { cacheCalls += 1; };
    projectCache.setProject = async () => { cacheCalls += 1; };
    projectRepository.queryProjects = async () => ({ projects: [owned], total: 1 });

    const result = await projectService.getProjects({}, user);
    assert.deepEqual(result.projects, [owned]);
    assert.equal(cacheCalls, 0);
});
