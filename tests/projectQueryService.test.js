const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const projectRepository = require("../src/repositories/projectRepository");
const projectService = require("../src/services/projectService");

const originalQueryProjects = projectRepository.queryProjects;
afterEach(() => { projectRepository.queryProjects = originalQueryProjects; });

const user = { userId: 31, role: "user" };
const admin = { userId: 1, role: "admin" };

test("project queries use safe defaults and return pagination metadata", async () => {
    let received;
    projectRepository.queryProjects = async (query) => {
        received = query;
        return { projects: [{ id: 1 }], total: 21 };
    };

    const result = await projectService.getProjects({}, user);

    assert.deepEqual(received, {
        page: 1,
        limit: 10,
        offset: 0,
        environment: undefined,
        search: undefined,
        sort: "id",
        order: "asc",
        ownerId: 31
    });
    assert.deepEqual(result, {
        page: 1,
        limit: 10,
        total: 21,
        totalPages: 3,
        projects: [{ id: 1 }]
    });
});

test("query options are normalized and admins omit the owner scope", async () => {
    let received;
    projectRepository.queryProjects = async (query) => {
        received = query;
        return { projects: [], total: 0 };
    };

    const result = await projectService.getProjects({
        page: "2",
        limit: "25",
        environment: "production",
        search: "  DeV  ",
        sort: "created_at",
        order: "DESC"
    }, admin);

    assert.deepEqual(received, {
        page: 2,
        limit: 25,
        offset: 25,
        environment: "production",
        search: "DeV",
        sort: "created_at",
        order: "desc",
        ownerId: undefined
    });
    assert.deepEqual(result, {
        page: 2,
        limit: 25,
        total: 0,
        totalPages: 0,
        projects: []
    });
});

test("limit 100 is accepted and produces the correct offset", async () => {
    let received;
    projectRepository.queryProjects = async (query) => {
        received = query;
        return { projects: [], total: 205 };
    };

    const result = await projectService.getProjects(
        { page: "2", limit: "100" },
        user
    );

    assert.equal(received.limit, 100);
    assert.equal(received.offset, 100);
    assert.equal(result.totalPages, 3);
});

test("page 1 and limit 1 are accepted lower boundaries", async () => {
    let received;
    projectRepository.queryProjects = async (query) => {
        received = query;
        return { projects: [], total: 0 };
    };

    await projectService.getProjects({ page: "1", limit: "1" }, user);

    assert.equal(received.page, 1);
    assert.equal(received.limit, 1);
    assert.equal(received.offset, 0);
});

for (const [parameter, value] of [
    ["page", "0"], ["page", "-1"], ["page", "1.5"], ["page", "1e2"],
    ["page", "9007199254740992"], ["limit", "0"], ["limit", "101"],
    ["limit", ["10", "20"]], ["environment", "staging"],
    ["sort", "name; DROP TABLE projects"], ["order", "sideways"],
    ["search", "x".repeat(101)]
]) {
    test(`invalid ${parameter} value is rejected before querying`, async () => {
        let called = false;
        projectRepository.queryProjects = async () => { called = true; };

        await assert.rejects(
            projectService.getProjects({ [parameter]: value }, user),
            (error) => error.statusCode === 400
        );
        assert.equal(called, false);
    });
}

test("a blank search is treated as no search filter", async () => {
    let received;
    projectRepository.queryProjects = async (query) => {
        received = query;
        return { projects: [], total: 0 };
    };

    await projectService.getProjects({ search: "   " }, user);
    assert.equal(received.search, undefined);
});
