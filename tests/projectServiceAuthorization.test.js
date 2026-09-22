const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const projectRepository = require("../src/repositories/projectRepository");
const projectService = require("../src/services/projectService");

const originals = { ...projectRepository };
afterEach(() => {
    for (const [name, implementation] of Object.entries(originals)) {
        projectRepository[name] = implementation;
    }
});

const user = { userId: 31, role: "user" };
const admin = { userId: 1, role: "admin" };
const owned = { id: 7, name: "Owned", environment: "development", owner_id: 31 };

test("normal users list only their own projects while admins list all projects", async () => {
    let ownerId;
    let adminCalled = false;
    projectRepository.getProjectsByOwnerId = async (id) => { ownerId = id; return [owned]; };
    projectRepository.getAllProjects = async () => { adminCalled = true; return [owned]; };

    assert.deepEqual(await projectService.getAllProjects(user), [owned]);
    assert.equal(ownerId, 31);
    assert.deepEqual(await projectService.getAllProjects(admin), [owned]);
    assert.equal(adminCalled, true);
});

test("project creation derives ownership from the authenticated actor", async () => {
    let inserted;
    projectRepository.createProject = async (project) => { inserted = project; return project; };

    await projectService.createProject("Owned", "development", user);

    assert.deepEqual(inserted, {
        name: "Owned",
        environment: "development",
        ownerId: 31
    });
});

test("users can read their projects but not another user's or a legacy project", async () => {
    projectRepository.getProjectById = async (id) => ({
        ...owned,
        id,
        owner_id: id === 7 ? 31 : id === 8 ? 44 : null
    });

    assert.equal((await projectService.getProjectById("7", user)).id, 7);
    await assert.rejects(projectService.getProjectById("8", user), (error) => error.statusCode === 403);
    await assert.rejects(projectService.getProjectById("9", user), (error) => error.statusCode === 403);
    assert.equal((await projectService.getProjectById("9", admin)).owner_id, null);
});

test("missing projects remain 404 for users and admins", async () => {
    projectRepository.getProjectById = async () => undefined;

    await assert.rejects(projectService.getProjectById("99", user), (error) => error.statusCode === 404);
    await assert.rejects(projectService.getProjectById("99", admin), (error) => error.statusCode === 404);
});

test("authorization happens before update and delete mutations", async () => {
    let updates = 0;
    let deletes = 0;
    projectRepository.getProjectById = async () => ({ ...owned, owner_id: 44 });
    projectRepository.updateProject = async () => { updates += 1; return owned; };
    projectRepository.deleteProject = async () => { deletes += 1; return { id: 7 }; };

    await assert.rejects(
        projectService.updateProject("7", "Updated", "production", user),
        (error) => error.statusCode === 403
    );
    await assert.rejects(projectService.deleteProject("7", user), (error) => error.statusCode === 403);
    assert.equal(updates, 0);
    assert.equal(deletes, 0);

    await projectService.updateProject("7", "Updated", "production", admin);
    await projectService.deleteProject("7", admin);
    assert.equal(updates, 1);
    assert.equal(deletes, 1);
});

test("legacy projects cannot be mutated by users, while owners can mutate their rows", async () => {
    let currentOwner = null;
    let updates = 0;
    let deletes = 0;
    projectRepository.getProjectById = async () => ({ ...owned, owner_id: currentOwner });
    projectRepository.updateProject = async () => { updates += 1; return owned; };
    projectRepository.deleteProject = async () => { deletes += 1; return { id: 7 }; };

    await assert.rejects(
        projectService.updateProject("7", "Updated", "production", user),
        (error) => error.statusCode === 403
    );
    await assert.rejects(projectService.deleteProject("7", user), (error) => error.statusCode === 403);
    assert.equal(updates, 0);
    assert.equal(deletes, 0);

    currentOwner = 31;
    await projectService.updateProject("7", "Updated", "production", user);
    await projectService.deleteProject("7", user);
    assert.equal(updates, 1);
    assert.equal(deletes, 1);
});
