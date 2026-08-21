const pool = require("../config/db"); // Shared DB pool used by all repository queries

// GET ALL PROJECTS
const getAllProjects = async () => {
    const result = await pool.query(
        "SELECT * FROM projects ORDER BY id"
    );

    return result.rows;
};

// GET ONE PROJECT
const getProjectById = async (id) => {
    const result = await pool.query(
        "SELECT * FROM projects WHERE id = $1",
        [id]
    );

    return result.rows[0];
};

// CREATE PROJECT
const createProject = async (project) => {
    const result = await pool.query(
        `INSERT INTO projects (name, environment)
         VALUES ($1, $2)
         RETURNING *`,
        [project.name, project.environment]
    );

    return result.rows[0];
};

module.exports = {
    getAllProjects,
    getProjectById,
    createProject
};