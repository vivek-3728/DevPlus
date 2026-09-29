const redactSensitiveText = (value) => String(value)
    // Keep the host for troubleshooting but remove user information embedded
    // in any normal URL, including HTTP, Redis, and PostgreSQL URLs.
    .replace(
        /(\b[a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi,
        "$1[REDACTED]@"
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
        /((?:"|')?(?:password|passwd|pwd|jwt_secret|redis_url|database_url|access_token|refresh_token|token|secret)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
        '$1"[REDACTED]"'
    );

const SAFE_ERROR_NAMES = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "AggregateError"
]);

const readSafeCode = (error) => typeof error?.code === "string"
    && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : undefined;

const getErrorLogDetails = (error, env = process.env) => {
    if (env.NODE_ENV === "production") {
        const code = readSafeCode(error);
        return {
            name: SAFE_ERROR_NAMES.has(error?.name) ? error.name : "Error",
            ...(code ? { code } : {})
        };
    }

    // Stacks are useful locally, but redact common secret formats before any
    // text reaches the logger.
    return redactSensitiveText(error?.stack || error?.message || error);
};

const getErrorLogMessage = (error, env = process.env) => {
    if (env.NODE_ENV === "production") {
        return readSafeCode(error) || "details hidden";
    }
    return redactSensitiveText(error?.message || error);
};

module.exports = {
    redactSensitiveText,
    getErrorLogDetails,
    getErrorLogMessage
};
