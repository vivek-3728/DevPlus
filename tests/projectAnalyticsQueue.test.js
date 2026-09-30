const test = require("node:test");
const assert = require("node:assert/strict");

const { getQueueConfig } = require("../src/config/queue");
const {
    createProjectAnalyticsQueue,
    addProjectAnalyticsJob
} = require("../src/queues/projectAnalyticsQueue");

const queueEnv = {
    REDIS_URL: "redis://queue-user:private@redis.internal:6379",
    PROJECT_ANALYTICS_QUEUE_NAME: "analytics-test",
    BULLMQ_PREFIX: "devpulse-test",
    PROJECT_ANALYTICS_WORKER_CONCURRENCY: "2"
};

test("queue configuration is environment-aware and requires Redis for workers", () => {
    assert.deepEqual(getQueueConfig(queueEnv, { requireRedis: true }), {
        redisUrl: queueEnv.REDIS_URL,
        queueName: "analytics-test",
        prefix: "devpulse-test",
        concurrency: 2,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnFail: { age: 604800, count: 1000 },
        jobName: "project.analytics.snapshot"
    });
    assert.throws(
        () => getQueueConfig({}, { requireRedis: true }),
        /REDIS_URL is required for background job workers/
    );
});

test("queue creation passes the shared node-redis client to BullMQ", () => {
    const calls = [];
    class FakeQueue {
        constructor(name, options) { calls.push({ name, options }); }
        on() {}
    }
    const connection = { kind: "existing-node-redis-client" };

    const queue = createProjectAnalyticsQueue({
        connection,
        env: queueEnv,
        QueueClass: FakeQueue,
        logger: { warn() {} }
    });

    assert.ok(queue instanceof FakeQueue);
    assert.equal(calls[0].name, "analytics-test");
    assert.equal(calls[0].options.connection, connection);
    assert.equal(calls[0].options.prefix, "devpulse-test");
    assert.equal(calls[0].options.skipWaitingForReady, true);
    assert.deepEqual(calls[0].options.defaultJobOptions, {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnFail: { age: 604800, count: 1000 }
    });
});

test("producer adds the expected job name and minimal payload", async () => {
    const calls = [];
    const queue = {
        add: async (...args) => {
            calls.push(args);
            return { id: "job-42" };
        }
    };

    const job = await addProjectAnalyticsJob(42, { queue, env: queueEnv });

    assert.equal(job.id, "job-42");
    assert.deepEqual(calls, [[
        "project.analytics.snapshot",
        { projectId: 42 },
        {
            attempts: 3,
            backoff: { type: "exponential", delay: 1000 },
            removeOnFail: { age: 604800, count: 1000 }
        }
    ]]);
});
