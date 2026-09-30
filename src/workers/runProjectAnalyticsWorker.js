require("dotenv").config({ quiet: true });

const { logger } = require("../utils/structuredLogger");
const { validateWorkerEnvironment } = require("../config/environment");

let startupConfig;
try {
    startupConfig = validateWorkerEnvironment(process.env);
} catch (error) {
    logger.error("worker.configuration_invalid", { message: error.message });
    throw error;
}

const pool = require("../config/db");
const redisConfig = require("../config/redis");
const { createProjectAnalyticsWorker } = require("./projectAnalyticsWorker");
const { registerWorkerShutdownHandlers } = require("../services/serverLifecycle");

const worker = createProjectAnalyticsWorker({
    connection: redisConfig.redisClient,
    env: process.env,
    logger
});

logger.info("worker.started", {
    queueName: startupConfig.queue.queueName,
    concurrency: startupConfig.queue.concurrency
});

registerWorkerShutdownHandlers({
    worker,
    pool,
    disconnectRedis: redisConfig.disconnectRedis,
    shutdownTimeoutMs: startupConfig.shutdownTimeoutMs,
    logger
});
