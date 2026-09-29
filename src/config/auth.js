// JWT configuration comes from environment variables so secrets are not stored
// in source code or committed to version control.

// Validate the required secret before the HTTP server starts. Failing early
// makes a configuration problem obvious instead of allowing every login to fail
// later with an unclear internal-server error.
const validateJwtConfig = (env = process.env) => {
    const secret = env.JWT_SECRET;

    if (!secret) {
        throw new Error("JWT_SECRET environment variable is required");
    }

    if (secret === "replace_with_a_long_random_secret") {
        throw new Error("JWT_SECRET must be replaced with a private random value");
    }

    if (env.JWT_EXPIRES_IN !== undefined
        && !/^[1-9]\d*(?:ms|s|m|h|d|w|y)$/i.test(env.JWT_EXPIRES_IN)) {
        throw new Error("JWT_EXPIRES_IN must be a positive duration such as 1h");
    }

    return secret;
};

// Services and middleware use the same validated secret, preventing signing and
// verification from accidentally reading different configuration values.
const getJwtSecret = () => validateJwtConfig(process.env);

// JWT_EXPIRES_IN is configurable, but tokens default to one hour when the value
// is omitted. jsonwebtoken accepts durations such as "15m", "1h", or "7d".
const getJwtExpiresIn = () => process.env.JWT_EXPIRES_IN || "1h";

module.exports = {
    validateJwtConfig,
    getJwtSecret,
    getJwtExpiresIn
};
