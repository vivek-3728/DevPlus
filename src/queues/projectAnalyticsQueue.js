const { Queue } = require("bullmq");
const redisConfig = require("../config/redis");
const { getQueueConfig } = require("../config/queue");
const { getErrorLogMessage } = require("../utils/errorDiagnostics");
const { logger: defaultLogger } = require("../utils/structuredLogger");

let activeQueue;
let activeConnection;
let queueCreationPromise;
let queueCreationConnection;

const getAnalyticsJobOptions = config => ({
    attempts: config.attempts,
    backoff: config.backoff,
    removeOnFail: config.removeOnFail
});

const createProjectAnalyticsQueue = ({
    connection,
    env = process.env,
    logger = defaultLogger,
    QueueClass = Queue
}) => {
    if (!connection) throw new Error("Background job Redis connection is unavailable");
    const config = getQueueConfig(env, { requireRedis: true });

    // A queue stores jobs in Redis. It is only the producer-facing data
    // structure; it does not execute the work itself.
    const queue = new QueueClass(config.queueName, {
        connection,
        prefix: config.prefix,
        skipWaitingForReady: true,
        // Queue defaults also protect jobs added by another producer path.
        defaultJobOptions: getAnalyticsJobOptions(config)
    });
    queue.on?.("error", error => logger.warn("queue.redis_error", {
        queueName: config.queueName,
        message: getErrorLogMessage(error)
    }));
    return queue;
};

const getProjectAnalyticsQueue = async ({
    env = process.env,
    logger = defaultLogger
} = {}) => {
    getQueueConfig(env, { requireRedis: true });
    const connection = redisConfig.redisClient;
    if (!connection) throw new Error("Background job Redis connection is unavailable");

    if (!connection.isReady) {
        await redisConfig.connectRedis(connection, logger);
    }
    if (!connection.isReady) {
        throw new Error("Background job Redis connection is unavailable");
    }

    if (activeQueue && activeConnection === connection) return activeQueue;
    if (queueCreationPromise && queueCreationConnection === connection) {
        return queueCreationPromise;
    }

    queueCreationConnection = connection;
    queueCreationPromise = (async () => {
        if (activeQueue) {
            const previousQueue = activeQueue;
            activeQueue = undefined;
            activeConnection = undefined;
            try {
                await previousQueue.close();
            } catch (error) {
                // A recycled cache connection may already be closed. That old
                // wrapper must not prevent a new healthy producer from forming.
                logger.warn("queue.previous_instance_close_failed", {
                    message: getErrorLogMessage(error)
                });
            }
        }
        activeQueue = createProjectAnalyticsQueue({ connection, env, logger });
        activeConnection = connection;
        return activeQueue;
    })();

    try {
        return await queueCreationPromise;
    } finally {
        queueCreationPromise = undefined;
        queueCreationConnection = undefined;
    }
};

const addProjectAnalyticsJob = async (
    projectId,
    { queue, env = process.env, logger = defaultLogger } = {}
) => {
    const config = getQueueConfig(env, { requireRedis: true });
    const targetQueue = queue || await getProjectAnalyticsQueue({ env, logger });
    return targetQueue.add(
        config.jobName,
        { projectId },
        getAnalyticsJobOptions(config)
    );
};

const closeProjectAnalyticsQueue = async () => {
    if (queueCreationPromise) {
        try {
            await queueCreationPromise;
        } catch {
            // Failed creation has no live Queue resource to close.
        }
    }
    const queue = activeQueue;
    activeQueue = undefined;
    activeConnection = undefined;
    queueCreationPromise = undefined;
    queueCreationConnection = undefined;
    if (queue) await queue.close();
};

module.exports = {
    createProjectAnalyticsQueue,
    getProjectAnalyticsQueue,
    addProjectAnalyticsJob,
    closeProjectAnalyticsQueue,
    getAnalyticsJobOptions
};
