const { getRequestContext } = require("./requestContext");
const { redactSensitiveText } = require("./errorDiagnostics");

const REDACTED = "[REDACTED]";
const SENSITIVE_FIELD_NAMES = new Set([
    "authorization", "cookie", "setcookie", "password", "passwordhash",
    "passwd", "pwd", "token", "accesstoken", "refreshtoken", "jwt",
    "jwtsecret", "secret", "databaseurl", "redisurl", "connectionstring",
    "apikey", "privatekey", "sessionid"
]);

const normalizeFieldName = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
const isSensitiveFieldName = (name) => {
    const normalized = normalizeFieldName(name);
    return SENSITIVE_FIELD_NAMES.has(normalized)
        || /(?:password|passwd|secret|token|credential|apikey|privatekey|connectionstring)$/.test(normalized);
};

const sanitizeValue = (value, fieldName, seen = new WeakSet()) => {
    if (isSensitiveFieldName(fieldName)) return REDACTED;
    if (typeof value === "string") return redactSensitiveText(value);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactSensitiveText(value.message),
            stack: redactSensitiveText(value.stack || "")
        };
    }
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => sanitizeValue(item, "", seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        sanitizeValue(item, key, seen)
    ]));
};

const createLogger = ({ sink = process.stdout, clock = () => new Date() } = {}) => {
    const write = (level, event, fields = {}) => {
        const record = sanitizeValue({
            ...fields,
            // Context and core metadata are written last so a caller cannot
            // accidentally replace the trusted request ID, level, or event.
            ...getRequestContext(),
            timestamp: clock().toISOString(),
            level,
            event
        });
        sink.write(`${JSON.stringify(record)}\n`);
    };

    return {
        info: (event, fields) => write("info", event, fields),
        warn: (event, fields) => write("warn", event, fields),
        error: (event, fields) => write("error", event, fields)
    };
};

const logger = createLogger();

module.exports = { createLogger, logger, sanitizeValue };
