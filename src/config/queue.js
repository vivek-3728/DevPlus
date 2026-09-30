const PROJECT_ANALYTICS_QUEUE_NAME = "project-analytics";
const PROJECT_ANALYTICS_JOB_NAME = "project.analytics.snapshot";
const DEFAULT_QUEUE_PREFIX = "devpulse";
const DEFAULT_WORKER_CONCURRENCY = 1;
const PROJECT_ANALYTICS_ATTEMPTS = 3;
const PROJECT_ANALYTICS_BACKOFF_DELAY_MS = 1000;
const FAILED_JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const FAILED_JOB_RETENTION_COUNT = 1000;

const readPositiveInteger = (value, fallback, maximum) => {
    if (value === undefined || value === "") return fallback;
    if (!/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
        ? parsed
        : undefined;
};

const validateRedisUrl = (value) => {
    if (!value?.trim()) return undefined;
    try {
        const url = new URL(value);
        if (!new Set(["redis:", "rediss:"]).has(url.protocol)) throw new Error();
        return value.trim();
    } catch {
        // Name the setting, never echo a URL that may contain credentials.
        throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
    }
};

const readSafeName = (value, fallback, name) => {
    const candidate = value?.trim() || fallback;
    if (!/^[a-z0-9_-]{1,64}$/i.test(candidate)) {
        throw new Error(`${name} must contain only letters, numbers, _ or -`);
    }
    return candidate;
};

const getQueueConfig = (env = process.env, { requireRedis = false } = {}) => {
    const redisUrl = validateRedisUrl(env.REDIS_URL);
    if (requireRedis && !redisUrl) {
        throw new Error("REDIS_URL is required for background job workers");
    }

    const concurrency = readPositiveInteger(
        env.PROJECT_ANALYTICS_WORKER_CONCURRENCY,
        DEFAULT_WORKER_CONCURRENCY,
        10
    );
    if (concurrency === undefined) {
        throw new Error(
            "PROJECT_ANALYTICS_WORKER_CONCURRENCY must be an integer from 1 to 10"
        );
    }

    return {
        redisUrl,
        queueName: readSafeName(
            env.PROJECT_ANALYTICS_QUEUE_NAME,
            PROJECT_ANALYTICS_QUEUE_NAME,
            "PROJECT_ANALYTICS_QUEUE_NAME"
        ),
        prefix: readSafeName(env.BULLMQ_PREFIX, DEFAULT_QUEUE_PREFIX, "BULLMQ_PREFIX"),
        concurrency,
        attempts: PROJECT_ANALYTICS_ATTEMPTS,
        // BullMQ exponential backoff multiplies this 1-second base delay by
        // 2 after each retry: 1s, then 2s before the final attempt.
        backoff: {
            type: "exponential",
            delay: PROJECT_ANALYTICS_BACKOFF_DELAY_MS
        },
        // Failed jobs remain inspectable for up to seven days, capped at 1,000
        // records so queue diagnostics cannot grow Redis storage without bound.
        removeOnFail: {
            age: FAILED_JOB_RETENTION_SECONDS,
            count: FAILED_JOB_RETENTION_COUNT
        },
        jobName: PROJECT_ANALYTICS_JOB_NAME
    };
};

module.exports = {
    getQueueConfig,
    PROJECT_ANALYTICS_QUEUE_NAME,
    PROJECT_ANALYTICS_JOB_NAME,
    PROJECT_ANALYTICS_ATTEMPTS
};
