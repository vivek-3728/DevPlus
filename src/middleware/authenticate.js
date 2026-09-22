// jsonwebtoken verifies that a token was signed by this server and has not
// expired or been changed after it was issued.
const jwt = require("jsonwebtoken");

// AppError creates expected errors that the centralized error handler can turn
// into clean JSON responses with the correct HTTP status code.
const AppError = require("../errors/Apperror");

// Read the JWT secret through the shared validation helper used during signing.
const { getJwtSecret } = require("../config/auth");

// Authentication middleware runs before protected controllers. Keeping this
// check in middleware avoids repeating token-verification code in every route.
const authenticate = (req, res, next) => {
    // Clients send JWTs in the Authorization header using this format:
    // Authorization: Bearer <token>
    // "Bearer" means the holder of the token is presenting it for access.
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
        return next(new AppError("Authentication token is required", 401));
    }

    // Remove the "Bearer " prefix to obtain the JWT itself.
    const token = authorizationHeader.slice("Bearer ".length).trim();

    if (!token) {
        return next(new AppError("Authentication token is required", 401));
    }

    try {
        // jwt.verify() checks the signature using JWT_SECRET and also rejects an
        // expired token. It returns the trusted decoded payload when successful.
        const payload = jwt.verify(token, getJwtSecret());

        // A valid signature alone is not enough: protected ownership queries
        // also need a real positive user ID. Without this check, an incomplete
        // token could accidentally omit the SQL owner filter.
        if (!Number.isSafeInteger(payload.userId) || payload.userId <= 0) {
            throw new Error("JWT is missing a valid user ID");
        }

        // Attach only the identity fields needed by later handlers. Controllers
        // can now use req.user without trusting IDs sent in query/body data.
        req.user = {
            userId: payload.userId,
            role: payload.role
        };

        // Continue to the next middleware or the protected route controller.
        next();
    } catch (error) {
        // Invalid signatures, malformed tokens, and expired tokens all receive
        // the same 401 response so authentication details are not disclosed.
        next(new AppError("Invalid or expired token", 401));
    }
};

module.exports = authenticate;
