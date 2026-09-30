// jsonwebtoken verifies that a token was signed by this server and has not
// expired or been changed after it was issued.
// AppError creates expected errors that the centralized error handler can turn
// into clean JSON responses with the correct HTTP status code.
const AppError = require("../errors/Apperror");
const { verifyJwtIdentity } = require("../utils/jwtIdentity");

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
        // Attach only the identity fields returned by the shared verifier.
        // Socket.IO uses this exact verifier during its handshake as well.
        req.user = verifyJwtIdentity(token);

        // Continue to the next middleware or the protected route controller.
        next();
    } catch (error) {
        // Invalid signatures, malformed tokens, and expired tokens all receive
        // the same 401 response so authentication details are not disclosed.
        next(new AppError("Invalid or expired token", 401));
    }
};

module.exports = authenticate;
