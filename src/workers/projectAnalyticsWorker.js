const { UnrecoverableError, Worker } = require("bullmq");
const AppError = require("../errors/Apperror");
const { getQueueConfig } = require("../config/queue");
const {
    generateProjectAnalyticsSnapshot
} = require("../services/projectAnalyticsService");
const { getErrorLogMessage } = require("../utils/errorDiagnostics");
const { logger: defaultLogger } = require("../utils/structuredLogger");

const getAttemptNumber = job => Math.max(1, (job.attemptsMade || 0) + 1);

const getSafeFailureReason = error => getErrorLogMessage(error);

const isPermanentJobError = error => error instanceof AppError && error.isOperational;

const createProjectAnalyticsProcessor = ({
    generateSnapshot = generateProjectAnalyticsSnapshot,
    logger = defaultLogger,
    env = process.env
} = {}) => async job => {
    const config = getQueueConfig(env);
    const startedAt = process.hrtime.bigint();
    const fields = {
        jobId: String(job.id),
        jobName: job.name,
        attempt: getAttemptNumber(job)
    };
    logger.info("project.analytics_job_started", fields);

    try {
        if (job.name !== config.jobName) {
            throw new AppError("Unsupported project analytics job name", 400);
        }

        const result = await generateSnapshot(job.data);
        logger.info("project.analytics_job_completed", {
            ...fields,
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
            success: true
        });
        return result;
    } catch (error) {
        const failureReason = getSafeFailureReason(error);
        logger.error("project.analytics_job_attempt_failed", {
            ...fields,
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
            success: false,
            failureReason
        });

        if (isPermanentJobError(error)) {
            // BullMQ's UnrecoverableError marks invalid/business jobs failed
            // immediately; transient infrastructure errors remain retryable.
            throw new UnrecoverableError(failureReason);
        }

        // BullMQ stores failedReason on the job, so only pass a sanitized
        // message onward rather than a raw database/Redis exception.
        throw new Error(failureReason);
    }
};

const createProjectAnalyticsWorker = ({
    connection,
    env = process.env,
    logger = defaultLogger,
    WorkerClass = Worker,
    processor
}) => {
    if (!connection) throw new Error("REDIS_URL is required for background job workers");
    const config = getQueueConfig(env, { requireRedis: true });

    // A worker is the queue consumer. BullMQ duplicates the supplied node-redis
    // client because blocking job waits must not block normal Redis commands.
    const worker = new WorkerClass(
        config.queueName,
        processor || createProjectAnalyticsProcessor({ logger, env }),
        {
            connection,
            prefix: config.prefix,
            // A small default protects PostgreSQL; operators can raise it when
            // throughput needs justify the extra CPU and database load.
            concurrency: config.concurrency
        }
    );

    worker.on?.("failed", (job, error) => {
        const attemptsMade = job?.attemptsMade;
        const maxAttempts = job?.opts?.attempts || config.attempts;
        logger.error("project.analytics_job_failed", {
            jobId: job?.id === undefined ? undefined : String(job.id),
            jobName: job?.name,
            attemptsMade,
            maxAttempts,
            willRetry: !(error instanceof UnrecoverableError)
                && attemptsMade < maxAttempts,
            failureReason: getSafeFailureReason(error)
        });
    });
    worker.on?.("error", error => logger.error("worker.redis_error", {
        queueName: config.queueName,
        message: getErrorLogMessage(error)
    }));
    return worker;
};

module.exports = {
    createProjectAnalyticsProcessor,
    createProjectAnalyticsWorker
};
