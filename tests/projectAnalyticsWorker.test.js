const test = require("node:test");
const assert = require("node:assert/strict");
const { UnrecoverableError } = require("bullmq");
const AppError = require("../src/errors/Apperror");

const projectRepository = require("../src/repositories/projectRepository");
const {
    generateProjectAnalyticsSnapshot,
    validateProjectAnalyticsJobData
} = require("../src/services/projectAnalyticsService");
const {
    createProjectAnalyticsProcessor,
    createProjectAnalyticsWorker
} = require("../src/workers/projectAnalyticsWorker");

const workerEnv = {
    REDIS_URL: "redis://localhost:6379",
    PROJECT_ANALYTICS_QUEUE_NAME: "project-analytics",
    BULLMQ_PREFIX: "devpulse",
    PROJECT_ANALYTICS_WORKER_CONCURRENCY: "1"
};

test("analytics workload validates data and creates a deterministic snapshot", async (t) => {
    const original = projectRepository.getProjectById;
    t.after(() => { projectRepository.getProjectById = original; });
    projectRepository.getProjectById = async id => ({
        id,
        name: "DevPulse",
        environment: "production",
        owner_id: 31
    });

    assert.deepEqual(await generateProjectAnalyticsSnapshot({ projectId: 7 }), {
        projectId: 7,
        environment: "production",
        nameLength: 8,
        hasOwner: true
    });
    assert.throws(
        () => validateProjectAnalyticsJobData({ projectId: 7, token: "do-not-accept" }),
        /Invalid project analytics job payload/
    );
});

test("repeating the read-only snapshot creates no duplicate logical result", async (t) => {
    const original = projectRepository.getProjectById;
    t.after(() => { projectRepository.getProjectById = original; });
    let reads = 0;
    projectRepository.getProjectById = async id => {
        reads += 1;
        return { id, name: "DevPulse", environment: "production", owner_id: null };
    };

    const first = await generateProjectAnalyticsSnapshot({ projectId: 7 });
    const repeated = await generateProjectAnalyticsSnapshot({ projectId: 7 });

    assert.deepEqual(repeated, first);
    assert.equal(reads, 2);
});

test("worker processor logs start/completion and returns the snapshot", async () => {
    const logs = [];
    const processor = createProjectAnalyticsProcessor({
        env: workerEnv,
        logger: {
            info: (...args) => logs.push(args),
            error: (...args) => logs.push(args)
        },
        generateSnapshot: async data => ({
            projectId: validateProjectAnalyticsJobData(data),
            nameLength: 4
        })
    });

    const result = await processor({
        id: "job-9",
        name: "project.analytics.snapshot",
        data: { projectId: 9 }
    });

    assert.deepEqual(result, { projectId: 9, nameLength: 4 });
    assert.deepEqual(logs.map(entry => entry[0]), [
        "project.analytics_job_started",
        "project.analytics_job_completed"
    ]);
    assert.equal(logs[1][1].jobId, "job-9");

    await assert.rejects(
        processor({
            id: "bad-job",
            name: "project.analytics.snapshot",
            data: { projectId: "9" }
        }),
        /Invalid project analytics job payload/
    );
});

test("processor retries transient failures but marks business errors unrecoverable", async () => {
    const logs = [];
    let transientCalls = 0;
    const transientProcessor = createProjectAnalyticsProcessor({
        env: workerEnv,
        logger: { info() {}, error: (...args) => logs.push(args) },
        generateSnapshot: async () => {
            transientCalls += 1;
            if (transientCalls < 3) {
                throw new Error("database temporarily unavailable Bearer abc.def.ghi");
            }
            return { projectId: 9 };
        }
    });
    const job = {
        id: "transient-job",
        name: "project.analytics.snapshot",
        data: { projectId: 9, password: "payload-secret" },
        attemptsMade: 0
    };

    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        job.attemptsMade = attempt;
        try {
            result = await transientProcessor(job);
        } catch (error) {
            assert.match(error.message, /temporarily unavailable/);
        }
    }
    assert.deepEqual(result, { projectId: 9 });
    assert.equal(transientCalls, 3);
    assert.equal(logs.filter(([event]) => event === "project.analytics_job_attempt_failed").length, 2);
    assert.equal(JSON.stringify(logs).includes("abc.def.ghi"), false);
    assert.equal(JSON.stringify(logs).includes("payload-secret"), false);

    const permanentProcessor = createProjectAnalyticsProcessor({
        env: workerEnv,
        logger: { info() {}, error() {} },
        generateSnapshot: async () => {
            throw new AppError("Invalid project analytics job payload", 400);
        }
    });

    await assert.rejects(
        permanentProcessor({
            id: "invalid-job",
            name: "project.analytics.snapshot",
            data: { projectId: 9 }
        }),
        error => error instanceof UnrecoverableError
    );
});

test("worker factory configures one BullMQ consumer and failure logging", () => {
    const construction = [];
    const handlers = {};
    class FakeWorker {
        constructor(...args) { construction.push(args); }
        on(name, handler) { handlers[name] = handler; }
    }
    const errors = [];
    const connection = { duplicate() {} };
    const configuredEnv = { ...workerEnv, PROJECT_ANALYTICS_WORKER_CONCURRENCY: "2" };

    createProjectAnalyticsWorker({
        connection,
        env: configuredEnv,
        WorkerClass: FakeWorker,
        processor: async () => {},
        logger: {
            info() {},
            error: (...args) => errors.push(args)
        }
    });

    assert.equal(construction.length, 1);
    assert.equal(construction[0][0], "project-analytics");
    assert.equal(construction[0][2].connection, connection);
    assert.equal(construction[0][2].concurrency, 2);
    handlers.failed({
        id: "17",
        name: "project.analytics.snapshot",
        attemptsMade: 3,
        opts: { attempts: 3 }
    }, new Error("failed"));
    assert.equal(errors[0][0], "project.analytics_job_failed");
    assert.equal(errors[0][1].jobId, "17");
    assert.equal(errors[0][1].attemptsMade, 3);
    assert.equal(errors[0][1].willRetry, false);
});
