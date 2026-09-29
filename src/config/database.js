const REQUIRED_DATABASE_VARIABLES = [
    "DB_USER",
    "DB_HOST",
    "DB_NAME",
    "DB_PASSWORD",
    "DB_PORT"
];

const requireNonEmpty = (env, name) => {
    if (typeof env[name] !== "string" || !env[name].trim()) {
        throw new Error(`${name} environment variable is required`);
    }
    return env[name];
};

const readPort = (env) => {
    const value = requireNonEmpty(env, "DB_PORT");
    if (!/^\d+$/.test(value)) {
        throw new Error("DB_PORT must be an integer from 1 to 65535");
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error("DB_PORT must be an integer from 1 to 65535");
    }
    return port;
};

const getDatabaseConfig = (env = process.env) => {
    for (const name of REQUIRED_DATABASE_VARIABLES) requireNonEmpty(env, name);

    return {
        user: env.DB_USER.trim(),
        host: env.DB_HOST.trim(),
        database: env.DB_NAME.trim(),
        // The password is passed directly to pg and is never logged.
        password: env.DB_PASSWORD,
        port: readPort(env)
    };
};

module.exports = { getDatabaseConfig, REQUIRED_DATABASE_VARIABLES };
