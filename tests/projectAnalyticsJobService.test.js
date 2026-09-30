const test = require("node:test");
const assert = require("node:assert/strict");

const projectService = require("../src/services/projectService");
const {
    enqueueProjectAnalyticsSnapshot
} = require("../src/services/projectAnalyticsJobService");

const actor = { userId: 31, role: "user" };

test("producer authorizes the project before enqueueing and returns its job ID", async (t) => {
    const original = projectService.getProjectById;
    t.after(() => { projectService.getProjectById = original; });
    const events = [];
    projectService.getProjectById = async (id, receivedActor) => {
        events.push(["authorize", id, receivedActor]);
        return { id: 7, owner_id: 31 };
    };

    const result = await enqueueProjectAnalyticsSnapshot("7", actor, {
        addJob: async projectId => {
            events.push(["enqueue", projectId]);
            return { id: 1234 };
        },
        jobLogger: { info() {}, warn() {} }
    });

    assert.deepEqual(result, { jobId: "1234" });
    assert.deepEqual(events, [
        ["authorize", "7", actor],
        ["enqueue", 7]
    ]);
});

test("authorization failure prevents job creation", async (t) => {
    const original = projectService.getProjectById;
    t.after(() => { projectService.getProjectById = original; });
    projectService.getProjectById = async () => {
        const error = new Error("Forbidden");
        error.statusCode = 403;
        throw error;
    };
    let enqueueCalls = 0;

    await assert.rejects(
        enqueueProjectAnalyticsSnapshot("8", actor, {
            addJob: async () => { enqueueCalls += 1; },
            jobLogger: { info() {}, warn() {} }
        }),
        error => error.statusCode === 403
    );
    assert.equal(enqueueCalls, 0);
});

test("queue failure returns a safe 503 instead of pretending acceptance", async (t) => {
    const original = projectService.getProjectById;
    t.after(() => { projectService.getProjectById = original; });
    projectService.getProjectById = async () => ({ id: 7, owner_id: 31 });

    await assert.rejects(
        enqueueProjectAnalyticsSnapshot("7", actor, {
            addJob: async () => { throw new Error("redis://user:secret@localhost"); },
            jobLogger: { info() {}, warn() {} }
        }),
        error => error.statusCode === 503
            && error.message === "Background job queue is unavailable"
    );
});
