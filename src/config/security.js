const DEFAULT_BODY_LIMIT = "100kb";
const DEFAULT_GENERAL_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_GENERAL_MAX = 100;
const DEFAULT_AUTH_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_MAX = 10;
const DEVELOPMENT_FRONTEND_ORIGIN = "http://localhost:5173";

const readPositiveInteger = (value, fallback) => {
    if (!/^\d+$/.test(value ?? "")) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const readBodyLimit = (value) => {
    const candidate = value?.trim().toLowerCase();
    // Express accepts values such as 100kb or 2mb. Restricting the format
    // catches configuration mistakes instead of passing arbitrary text to the
    // body parser at runtime.
    return /^[1-9]\d*(?:b|kb|mb)$/.test(candidate ?? "")
        ? candidate
        : DEFAULT_BODY_LIMIT;
};

const normalizeOrigin = (value) => {
    if (value === "*") {
        throw new Error("CORS_ALLOWED_ORIGINS must not contain a wildcard");
    }

    try {
        const url = new URL(value);
        const hasOnlyOrigin = url.pathname === "/"
            && !url.search
            && !url.hash
            && !url.username
            && !url.password;
        if (!["http:", "https:"].includes(url.protocol) || !hasOnlyOrigin) {
            throw new Error();
        }
        return url.origin;
    } catch {
        throw new Error(
            "CORS_ALLOWED_ORIGINS must contain only valid HTTP or HTTPS origins"
        );
    }
};

const readAllowedOrigins = (env) => {
    const configured = env.CORS_ALLOWED_ORIGINS
        ?.split(",")
        .map(value => value.trim())
        .filter(Boolean);

    if (configured?.length) {
        return [...new Set(configured.map(normalizeOrigin))];
    }

    // A local Vite/React frontend works without extra setup in development.
    // Production defaults closed so an omitted setting never becomes "allow *".
    return env.NODE_ENV === "production"
        ? []
        : [DEVELOPMENT_FRONTEND_ORIGIN];
};

const getSecurityConfig = (env = process.env) => ({
    allowedOrigins: readAllowedOrigins(env),
    bodyLimit: readBodyLimit(env.REQUEST_BODY_LIMIT),
    // Express must trust only the exact number of reverse-proxy hops in front
    // of it. Omitting/invalid values keep the safe direct-connection default.
    trustProxy: readPositiveInteger(env.TRUST_PROXY_HOPS, false),
    generalRateLimit: {
        windowMs: readPositiveInteger(
            env.GENERAL_RATE_LIMIT_WINDOW_MS,
            DEFAULT_GENERAL_WINDOW_MS
        ),
        max: readPositiveInteger(env.GENERAL_RATE_LIMIT_MAX, DEFAULT_GENERAL_MAX)
    },
    authRateLimit: {
        windowMs: readPositiveInteger(
            env.AUTH_RATE_LIMIT_WINDOW_MS,
            DEFAULT_AUTH_WINDOW_MS
        ),
        max: readPositiveInteger(env.AUTH_RATE_LIMIT_MAX, DEFAULT_AUTH_MAX)
    }
});

const assertOptionalPositiveInteger = (env, name) => {
    if (env[name] === undefined || env[name] === "") return;
    const parsed = Number(env[name]);
    if (!/^\d+$/.test(env[name])
        || !Number.isSafeInteger(parsed)
        || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
};

const validateSecurityConfig = (env = process.env) => {
    if (env.REQUEST_BODY_LIMIT !== undefined
        && !/^[1-9]\d*(?:b|kb|mb)$/i.test(env.REQUEST_BODY_LIMIT.trim())) {
        throw new Error("REQUEST_BODY_LIMIT must be a positive size such as 100kb");
    }

    for (const name of [
        "GENERAL_RATE_LIMIT_WINDOW_MS",
        "GENERAL_RATE_LIMIT_MAX",
        "AUTH_RATE_LIMIT_WINDOW_MS",
        "AUTH_RATE_LIMIT_MAX"
    ]) {
        assertOptionalPositiveInteger(env, name);
    }

    if (env.TRUST_PROXY_HOPS !== undefined
        && (!/^(?:0|[1-9]\d*)$/.test(env.TRUST_PROXY_HOPS)
            || !Number.isSafeInteger(Number(env.TRUST_PROXY_HOPS)))) {
        throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
    }

    // getSecurityConfig also validates and normalizes every CORS origin.
    return getSecurityConfig(env);
};

module.exports = { getSecurityConfig, validateSecurityConfig };
