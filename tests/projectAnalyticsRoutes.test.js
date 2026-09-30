const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

const routes = require("../src/routes/projectRoutes");
const errorHandler = require("../src/middleware/errorHandler");
const jobService = require("../src/services/projectAnalyticsJobService");
const AppError = require("../src/errors/Apperror");
const { getJwtSecret } = require("../src/config/auth");

const startApp = async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/projects", routes);
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve))
    };
};

test("POST analytics job endpoint returns 202 and the BullMQ job ID", async (t) => {
    const original = jobService.enqueueProjectAnalyticsSnapshot;
    t.after(() => { jobService.enqueueProjectAnalyticsSnapshot = original; });
    const calls = [];
    jobService.enqueueProjectAnalyticsSnapshot = async (id, actor) => {
        calls.push({ id, actor });
        return { jobId: "bull-job-123" };
    };
    const running = await startApp();
    t.after(running.close);
    const token = jwt.sign({ userId: 31, role: "user" }, getJwtSecret());

    const response = await fetch(`${running.baseUrl}/api/projects/7/analytics-jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
        status: "queued",
        jobId: "bull-job-123"
    });
    assert.deepEqual(calls, [{
        id: "7",
        actor: { userId: 31, role: "user" }
    }]);
});

test("analytics endpoint returns 503 when Redis did not accept the job", async (t) => {
    const original = jobService.enqueueProjectAnalyticsSnapshot;
    t.after(() => { jobService.enqueueProjectAnalyticsSnapshot = original; });
    jobService.enqueueProjectAnalyticsSnapshot = async () => {
        throw new AppError("Background job queue is unavailable", 503);
    };
    const running = await startApp();
    t.after(running.close);
    const token = jwt.sign({ userId: 1, role: "admin" }, getJwtSecret());

    const response = await fetch(`${running.baseUrl}/api/projects/7/analytics-jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
        error: "Background job queue is unavailable"
    });
});
