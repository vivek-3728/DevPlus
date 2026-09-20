// The repository owns SQL. Services receive rows rather than pg query metadata.
const pool = require("../config/db");

const getAllProjects = async () => {
    const result = await pool.query("SELECT * FROM projects ORDER BY id");
    return result.rows;
};

const getProjectsByOwnerId = async (ownerId) => {
    // The owner ID is a bound value, so it cannot change the SQL statement.
    const result = await pool.query(
        "SELECT * FROM projects WHERE owner_id = $1 ORDER BY id",
        [ownerId]
    );
    return result.rows;
};

const SORT_COLUMNS = {
    id: "p.id",
    name: "p.name",
    environment: "p.environment",
    created_at: "p.created_at"
};

const escapeLikePattern = (value) => value.replace(/[\\%_]/g, "\\$&");

/**
 * Count and fetch one page of projects using the same filters.
 *
 * LIMIT caps how many rows PostgreSQL returns. OFFSET tells PostgreSQL how
 * many matching rows to skip, so page 2 with limit 10 uses offset 10.
 */
const queryProjects = async ({ ownerId, environment, search, sort, order, limit, offset }) => {
    const predicates = [];
    const filterValues = [];

    const addPredicate = (sqlFragment, value) => {
        filterValues.push(value);
        predicates.push(`${sqlFragment} $${filterValues.length}`);
    };

    if (ownerId !== undefined) addPredicate("p.owner_id =", ownerId);
    if (environment !== undefined) addPredicate("p.environment =", environment);
    if (search !== undefined) {
        // ILIKE performs case-insensitive matching in PostgreSQL. Escaping its
        // wildcard characters makes the user's text a literal substring.
        addPredicate("p.name ILIKE", `%${escapeLikePattern(search)}%`);
        predicates[predicates.length - 1] += " ESCAPE '\\'";
    }

    const whereClause = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const countResult = await pool.query(
        `SELECT COUNT(*) AS total FROM projects AS p ${whereClause}`,
        filterValues
    );

    // SQL placeholders work for values, not identifiers or ASC/DESC keywords.
    // These maps contain the only allowed SQL fragments, so raw input is never
    // inserted into the statement and cannot turn sorting into SQL injection.
    const sortColumn = SORT_COLUMNS[sort] ?? SORT_COLUMNS.id;
    const sortOrder = order === "desc" ? "DESC" : "ASC";
    const tieBreaker = sortColumn === "p.id" ? "" : ", p.id ASC";
    const pageValues = [...filterValues, limit, offset];
    const limitPlaceholder = `$${filterValues.length + 1}`;
    const offsetPlaceholder = `$${filterValues.length + 2}`;

    const pageResult = await pool.query(
        `SELECT p.id, p.name, p.environment, p.owner_id, p.created_at
         FROM projects AS p
         ${whereClause}
         ORDER BY ${sortColumn} ${sortOrder}${tieBreaker}
         LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
        pageValues
    );

    return {
        projects: pageResult.rows,
        // node-postgres returns COUNT as text because PostgreSQL COUNT is a
        // bigint. Convert it once here so API metadata contains a JSON number.
        total: Number(countResult.rows[0].total)
    };
};

const getProjectById = async (id) => {
    // Values are bound separately from SQL text to prevent SQL injection.
    const result = await pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    // An empty result resolves to undefined; the service turns that into a 404.
    return result.rows[0];
};

const createProject = async (project) => {
    // Transactions must use one checked-out connection. Separate pool.query()
    // calls might use different connections and therefore different transactions.
    const client = await pool.connect();
    let transactionStarted = false;

    try {
        // BEGIN starts one all-or-nothing unit of work.
        await client.query("BEGIN");
        transactionStarted = true;

        // Omit id so PostgreSQL generates it. RETURNING * supplies the ID needed
        // by the related audit row without requiring another SELECT.
        const projectResult = await client.query(
            `INSERT INTO projects (name, environment, owner_id)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [project.name, project.environment, project.ownerId]
        );
        const createdProject = projectResult.rows[0];

        await client.query(
            `INSERT INTO project_audit_log
                (project_id, action, actor_user_id, project_name, environment)
             VALUES ($1, 'created', $2, $3, $4)`,
            [createdProject.id, project.ownerId, project.name, project.environment]
        );

        // COMMIT makes both inserts permanent together.
        await client.query("COMMIT");
        return createdProject;
    } catch (error) {
        if (transactionStarted) {
            try {
                // ROLLBACK removes the project insert if the audit insert or
                // commit fails, keeping the two related writes consistent.
                await client.query("ROLLBACK");
            } catch {
                // Keep the original failure as the useful application error.
                // The finally block still releases this connection.
            }
        }
        throw error;
    } finally {
        // Always return the connection to the pool, on success or failure.
        client.release();
    }
};

const updateProject = async (id, project) => {
    // The WHERE clause limits the change to the requested project.
    // No separate existence check is needed, avoiding a read/update race.
    const result = await pool.query(
        `UPDATE projects SET name = $1, environment = $2
         WHERE id = $3 RETURNING *`,
        [project.name, project.environment, id]
    );
    return result.rows[0];
};

const deleteProject = async (id) => {
    // RETURNING id distinguishes a deletion from a request for a missing row.
    const result = await pool.query(
        "DELETE FROM projects WHERE id = $1 RETURNING id",
        [id]
    );
    return result.rows[0];
};

/**
 * Return projects together with safe information about each owner.
 *
 * LEFT JOIN keeps every project from the left side, even when owner_id is
 * NULL. That matters for legacy projects created before ownership existed;
 * PostgreSQL returns NULL for their owner fields instead of hiding the row.
 */
const getProjectsWithOwners = async () => {
    const result = await pool.query(
        `SELECT
             p.id AS project_id,
             p.name AS project_name,
             p.environment,
             u.id AS owner_id,
             u.name AS owner_name,
             u.email AS owner_email
         FROM projects AS p
         LEFT JOIN users AS u ON u.id = p.owner_id
         ORDER BY p.id`
    );

    // Listing explicit columns creates a safety boundary. In particular,
    // users.password_hash is never selected and cannot leak from this query.
    return result.rows;
};

module.exports = {
    getAllProjects,
    getProjectsByOwnerId,
    queryProjects,
    getProjectById,
    createProject,
    updateProject,
    deleteProject,
    getProjectsWithOwners
};
