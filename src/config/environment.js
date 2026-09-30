const { getDatabaseConfig } = require("./database");
const { validateJwtConfig } = require("./auth");
const { validateSecurityConfig } = require("./security");
const { getQueueConfig } = require("./queue");

const VALID_NODE_ENVIRONMENTS = new Set(["development", "test", "production"]);
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_READINESS_TIMEOUT_MS = 2000;

const readApplicationPort = (value) => {
    if (value === undefined || value === "") return 5000;
    if (!/^\d+$/.test(value)) {
        throw new Error("PORT must be an integer from 1 to 65535");
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be an integer from 1 to 65535");
    }
    return port;
};

const readShutdownTimeout = (value) => {
    if (value === undefined || value === "") return DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const timeout = Number(value);
    if (!/^\d+$/.test(value)
        || !Number.isSafeInteger(timeout)
        || timeout < 1
        || timeout > 300000) {
        throw new Error("SHUTDOWN_TIMEOUT_MS must be an integer from 1 to 300000");
    }
    return timeout;
};

const readReadinessTimeout = (value) => {
    if (value === undefined || value === "") return DEFAULT_READINESS_TIMEOUT_MS;
    const timeout = Number(value);
    if (!/^\d+$/.test(value)
        || !Number.isSafeInteger(timeout)
        || timeout < 1
        || timeout > 30000) {
        throw new Error("READINESS_TIMEOUT_MS must be an integer from 1 to 30000");
    }
    return timeout;
};

const readNodeEnvironment = (value) => {
    if (!value) throw new Error("NODE_ENV environment variable is required");
    if (!VALID_NODE_ENVIRONMENTS.has(value)) {
        throw new Error("NODE_ENV must be development, test, or production");
    }
    return value;
};

const validateEnvironment = (env = process.env) => {
    const nodeEnv = readNodeEnvironment(env.NODE_ENV);

    // Validation returns normalized configuration so startup and runtime use
    // the same checked values. Error messages name variables but never values.
    const database = getDatabaseConfig(env);
    validateJwtConfig(env);
    const security = validateSecurityConfig(env);

    return {
        nodeEnv,
        port: readApplicationPort(env.PORT),
        shutdownTimeoutMs: readShutdownTimeout(env.SHUTDOWN_TIMEOUT_MS),
        readinessTimeoutMs: readReadinessTimeout(env.READINESS_TIMEOUT_MS),
        database,
        security
    };
};

const validateWorkerEnvironment = (env = process.env) => ({
    nodeEnv: readNodeEnvironment(env.NODE_ENV),
    database: getDatabaseConfig(env),
    queue: getQueueConfig(env, { requireRedis: true }),
    shutdownTimeoutMs: readShutdownTimeout(env.SHUTDOWN_TIMEOUT_MS)
});

module.exports = {
    validateEnvironment,
    validateWorkerEnvironment,
    readApplicationPort,
    readShutdownTimeout,
    readReadinessTimeout
};
