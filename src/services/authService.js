// bcrypt is a password-hashing library. It turns a plain-text password into a
// secure one-way hash before any password data is sent to the repository.
const bcrypt = require("bcrypt");

// jsonwebtoken creates signed login tokens. A signed token lets the server
// verify that its payload has not been changed by the client.
const jwt = require("jsonwebtoken");

// The user repository is the data-access layer. It contains the PostgreSQL
// queries for finding and creating users, while this service contains the
// registration rules and authentication-related business logic.
const userRepository = require("../repositories/userRepository");

// AppError represents an expected application error. The centralized Express
// error handler can use its status code and message to build an HTTP response.
// This project's constructor order is: new AppError(message, statusCode).
const AppError = require("../errors/Apperror");

// These helpers provide one validated source for JWT secrets and expiration.
const { getJwtSecret, getJwtExpiresIn } = require("../config/auth");

// Unknown-email logins still run bcrypt once using this valid dummy hash. That
// keeps their work closer to the wrong-password path, making it harder to learn
// which email addresses exist by measuring response time.
const DUMMY_PASSWORD_HASH = "$2b$10$hrtdMStdfMfDlsFQCeqnxuCvYrH.RkfcFSb8G5NUL9cYVnHQfCdJi";

// Authentication responses should contain only public account information.
// Building a new object from an allow-list prevents password_hash and other
// database-only fields from being exposed by login or /me.
const toSafeUser = (user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
});

/**
 * Register a new user after validating their input and securing their password.
 *
 * The service layer coordinates the registration steps. It validates business
 * rules, checks for duplicate users, hashes the password, and then asks the
 * repository to save the safe database values.
 *
 * @param {string} name - The name supplied by the person registering.
 * @param {string} email - The email that will uniquely identify the user.
 * @param {string} password - The plain-text password supplied at registration.
 * @returns {Promise<object>} The newly created user without password_hash.
 */
const registerUser = async (name, email, password) => {
    // All three values are required to create a usable account. Throwing an
    // operational error lets the future controller return a clear 400 response.
    if (!name || !email || !password) {
        throw new AppError("Name, email and password are required", 400);
    }

    // Database operations are asynchronous, so await pauses this function until
    // PostgreSQL has finished the lookup without blocking Node.js from handling
    // other work. Registration must check first because two accounts should not
    // share the same email address; login will use that email to identify a user.
    const existingUser = await userRepository.findByEmail(email);

    if (existingUser) {
        // HTTP 409 means the request conflicts with data that already exists.
        throw new AppError("User with this email already exists", 409);
    }

    // NEVER store the original password. bcrypt.hash() creates a one-way hash:
    // the application can later verify a login password, but it cannot recover
    // the original password from the stored hash.
    //
    // Salt rounds control how much computational work bcrypt performs. A value
    // of 10 makes hashing intentionally slower than ordinary string processing,
    // which makes large-scale password guessing more expensive. bcrypt includes
    // a generated salt and the work factor inside the resulting hash.
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Send only the generated hash to the repository. The plain-text password
    // never reaches the data-access layer and is never written to PostgreSQL.
    // await is used because INSERT must finish before the new user can be returned.
    const newUser = await userRepository.createUser(
        name,
        email,
        passwordHash
    );

    // The repository's RETURNING clause excludes password_hash, so this object
    // contains only the safe user fields needed by later application layers.
    return newUser;
};

/**
 * Verify login credentials and issue a signed JWT for future requests.
 *
 * @param {string} email - The email submitted on the login form.
 * @param {string} password - The plain-text password submitted for verification.
 * @returns {Promise<{user: object, token: string}>} Safe user data and a JWT.
 */
const loginUser = async (email, password) => {
    if (!email || !password) {
        throw new AppError("Email and password are required", 400);
    }

    // Find the user first because bcrypt needs the stored password hash for its
    // comparison. Database access is asynchronous, so the result is awaited.
    const user = await userRepository.findByEmail(email);

    // bcrypt.compare() hashes the submitted password using the salt and work
    // factor embedded in the stored bcrypt hash, then safely compares the result.
    // The dummy hash makes unknown emails perform similar work to known emails.
    const passwordHash = user ? user.password_hash : DUMMY_PASSWORD_HASH;
    const passwordIsCorrect = await bcrypt.compare(password, passwordHash);

    // Use the same message for an unknown email and a wrong password. This avoids
    // revealing which email addresses have accounts to an unauthenticated caller.
    if (!user || !passwordIsCorrect) {
        throw new AppError("Invalid email or password", 401);
    }

    // The JWT contains only the identity and role needed by later middleware.
    // jwt.sign() adds standard issued-at and expiration claims, then signs the
    // token with the private server secret so clients cannot alter its payload.
    const token = jwt.sign(
        { userId: user.id, role: user.role },
        getJwtSecret(),
        { expiresIn: getJwtExpiresIn() }
    );

    return {
        user: toSafeUser(user),
        token
    };
};

/**
 * Load the current safe profile for an already authenticated request.
 *
 * @param {number} userId - The ID attached to req.user by JWT middleware.
 * @returns {Promise<object>} Safe current-user details.
 */
const getCurrentUser = async (userId) => {
    const user = await userRepository.findById(userId);

    // A valid token may outlive an account that was deleted, so handle that case
    // as a missing resource instead of returning an empty successful response.
    if (!user) {
        throw new AppError("User not found", 404);
    }

    return toSafeUser(user);
};

// Export the registration function so a future auth controller can call it.
module.exports = {
    registerUser,
    loginUser,
    getCurrentUser
};
