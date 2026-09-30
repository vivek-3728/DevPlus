const test = require("node:test");
const assert = require("node:assert/strict");

const projectService = require("../src/services/projectService");
const projectController = require("../src/controllers/projectController");

const makeResponse = () => ({
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; }
});

const makeRequest = (publisher, overrides = {}) => ({
    app: { get: name => name === "projectEventPublisher" ? publisher : undefined },
    body: { name: "Realtime", environment: "development" },
    params: { id: "42" },
    user: { userId: 31, role: "user" },
    requestId: "rest-request-42",
    ...overrides
});

test("successful REST create and update publish only after service completion", async (t) => {
    const originals = {
        createProject: projectService.createProject,
        updateProject: projectService.updateProject
    };
    t.after(() => Object.assign(projectService, originals));
    const events = [];
    const publisher = {
        created: (project, context) => events.push(["created", project, context]),
        updated: (project, context) => events.push(["updated", project, context])
    };
    const project = {
        id: 42,
        name: "Realtime",
        environment: "development",
        owner_id: 31
    };
    projectService.createProject = async () => project;
    projectService.updateProject = async () => ({ ...project, name: "Updated" });

    const createResponse = makeResponse();
    await projectController.createProject(makeRequest(publisher), createResponse, assert.fail);
    assert.equal(createResponse.statusCode, 201);
    assert.deepEqual(events[0], ["created", project, { requestId: "rest-request-42" }]);

    const updateResponse = makeResponse();
    await projectController.updateProject(makeRequest(publisher), updateResponse, assert.fail);
    assert.equal(updateResponse.statusCode, 200);
    assert.equal(events[1][0], "updated");
    assert.equal(events[1][1].name, "Updated");
});

test("successful REST delete publishes its safe routing metadata", async (t) => {
    const original = projectService.deleteProject;
    t.after(() => { projectService.deleteProject = original; });
    const events = [];
    const publisher = {
        deleted: (project, context) => events.push({ project, context })
    };
    projectService.deleteProject = async () => ({ id: 42, owner_id: 31 });
    const response = makeResponse();

    await projectController.deleteProject(makeRequest(publisher), response, assert.fail);

    assert.equal(response.statusCode, 204);
    assert.deepEqual(events, [{
        project: { id: 42, owner_id: 31 },
        context: { requestId: "rest-request-42" }
    }]);
});

test("failed REST mutations never emit success events", async (t) => {
    const original = projectService.updateProject;
    t.after(() => { projectService.updateProject = original; });
    const expected = new Error("database failure");
    projectService.updateProject = async () => { throw expected; };
    let emitted = false;
    let forwarded;

    await projectController.updateProject(
        makeRequest({ updated: () => { emitted = true; } }),
        makeResponse(),
        error => { forwarded = error; }
    );

    assert.equal(forwarded, expected);
    assert.equal(emitted, false);
});
