// Controllers translate HTTP requests into service calls and results into responses.
const projectService = require("../services/projectService");

// Express 5 forwards rejected async handler Promises to the central error handler.
const getProjects = async (req, res) => {
    const result = await projectService.getProjects(req.query, req.user);
    res.json(result);
};

const getProjectById = async (req, res, next) => {
    try {
        // req.params.id is the string captured by the /:id route.
        const project = await projectService.getProjectById(req.params.id, req.user);
        res.json(project);
    } catch (error) {
        next(error);
    }
};

const createProject = async (req, res, next) => {
    try {
        // An absent body becomes an empty object, so the service returns a useful
        // validation error rather than a destructuring exception and HTTP 500.
        const { name, environment } = req.body ?? {};
        const project = await projectService.createProject(name, environment, req.user);
        res.status(201).json(project);
    } catch (error) {
        next(error);
    }
};

const updateProject = async (req, res, next) => {
    try {
        const { name, environment } = req.body ?? {};
        const project = await projectService.updateProject(req.params.id, name, environment, req.user);
        // PUT replaces both editable fields and returns the saved database row.
        res.json(project);
    } catch (error) {
        next(error);
    }
};

const deleteProject = async (req, res, next) => {
    try {
        await projectService.deleteProject(req.params.id, req.user);
        // 204 means success with no response body; end() completes the response.
        res.status(204).end();
    } catch (error) {
        next(error);
    }
};

module.exports = { getProjects, getProjectById, createProject, updateProject, deleteProject };
