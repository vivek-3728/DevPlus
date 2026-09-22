// Import the shared PostgreSQL connection pool from the database configuration.
// The pool lets this repository send SQL queries without opening a new database
// connection for every request.
const pool = require("../config/db");

/**
 * Find one user by their email address.
 *
 * @param {string} email - The email address to search for in the users table.
 * @returns {Promise<object|undefined>} The first matching user row, or undefined
 * when no user has that email address.
 */
const findByEmail = async (email) => {
    // Database queries take time, so this function is async. await pauses this
    // function until PostgreSQL finishes the query, without blocking Node.js
    // from handling other work in the meantime.
    //
    // $1 is a parameter placeholder. The email is supplied separately in the
    // [email] array, so PostgreSQL treats it as data instead of executable SQL.
    // This helps prevent SQL injection attacks.
    const result = await pool.query(
        "SELECT * FROM users WHERE email = $1",
        [email]
    );

    // pg stores all matching database rows in result.rows. Email addresses are
    // expected to be unique, so return the first row. If none matched, rows[0]
    // is undefined.
    return result.rows[0];
};

/**
 * Find one user by their database ID.
 *
 * @param {number} userId - The authenticated user's ID from the verified JWT.
 * @returns {Promise<object|undefined>} Safe user details, or undefined when the
 * user no longer exists.
 */
const findById = async (userId) => {
    // await is needed because PostgreSQL completes the query asynchronously.
    // Selecting explicit columns prevents password_hash from leaving the data
    // layer when the /me endpoint requests the current user's profile.
    //
    // $1 is a parameter placeholder. Passing userId separately prevents it from
    // being interpreted as SQL and protects the query from SQL injection.
    const result = await pool.query(
        `SELECT id, name, email, role
         FROM users
         WHERE id = $1`,
        [userId]
    );

    // A unique ID can match at most one user, so return the first row. If the
    // account was deleted after its token was issued, rows[0] is undefined.
    return result.rows[0];
};

/**
 * Create a new user in the users table.
 *
 * @param {string} name - The user's display name.
 * @param {string} email - The user's email address.
 * @param {string} passwordHash - The securely hashed password to store. This is
 * a hash produced before calling the repository, not the plain-text password.
 * @returns {Promise<object>} The newly created user's safe public fields.
 */
const createUser = async (name, email, passwordHash) => {
    // This query inserts only name, email, and password_hash. The role column is
    // intentionally omitted so PostgreSQL can use its default value of "user".
    // PostgreSQL also supplies values such as id and created_at from the table's
    // configured defaults.
    //
    // $1, $2, and $3 refer to the values in the array below, in the same order.
    // Passing values separately keeps user input out of the SQL command itself,
    // which helps prevent SQL injection attacks.
    //
    // RETURNING lists only safe fields needed by the application. It does not
    // return password_hash, so the stored password hash is not accidentally sent
    // to another layer or included in an API response.
    const result = await pool.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, name, email, role, created_at`,
        [name, email, passwordHash]
    );

    // INSERT ... RETURNING produces one row for the new user. Return that row to
    // the service layer after PostgreSQL has completed the asynchronous query.
    return result.rows[0];
};

// Export both repository functions so future authentication services can use
// them during registration and login.
module.exports = {
    findByEmail,
    findById,
    createUser
};
