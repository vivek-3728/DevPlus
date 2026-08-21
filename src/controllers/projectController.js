// Import the project service that contains business logic
const projectService = require("../services/projectService");

// ======================================================
// GET ALL PROJECTS HANDLER
// ======================================================

// Handler for GET /api/projects - retrieves all projects from the data store
const getProjects = async (req, res) => {
    // Call the service layer to fetch all projects
    const projects = await projectService.getAllProjects();

    // Send the projects array back to the client as JSON
    res.json(projects);
};

// ======================================================
// GET ONE PROJECT HANDLER
// ======================================================

// Handler for GET /api/projects/:id - retrieves one project by ID
const getProjectById = async (req, res, next) => {
    try {
        // Read the project ID from the URL parameters
        const { id } = req.params;

        // Call the service layer to fetch the requested project
        const project =  await projectService.getProjectById(id);

        // Send the matching project back to the client as JSON
        res.json(project);
    } catch (error) {
        // Pass handled errors to the centralized error middleware
        next(error);
    }
};

// ======================================================
// CREATE PROJECT HANDLER
// ======================================================

// Handler for POST /api/projects - creates a new project
const createProject = async (req, res, next) => {
    // Wrap the logic in try-catch to handle errors
    try {
        // Extract name and environment from the request body (JSON payload)
        const { name, environment } = req.body;

        // Call the service layer to validate and create the project
        const project = await projectService.createProject(name, environment);

        // Send the created project back with HTTP 201 (Created) status
        res.status(201).json(project);

    } catch (error) {
        // Pass any errors to the error handling middleware using next()
        next(error);
    }
};

// Export the controller functions for use in routes
module.exports = {
    getProjects,
    getProjectById,
    createProject
};