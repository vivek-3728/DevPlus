// Import the project repository for data access layer
const projectRepository = require("../repositories/projectRepository");
// Import the Apperror class for handled API errors
const Apperror = require("../errors/Apperror");

// ======================================================
// GET ALL PROJECTS SERVICE FUNCTION
// ======================================================

// Retrieve all projects from the repository
const getAllProjects = () => {
    // Call the repository layer to fetch all projects from the data store
    return projectRepository.getAllProjects();
};

// ======================================================
// GET ONE PROJECT SERVICE FUNCTION
// ======================================================

// Retrieve one project from the repository by its ID
const getProjectById = (id) => {
    // Convert the URL parameter from text into a number for ID comparison
    const projectId = Number(id);

    // Call the repository to find the requested project
    const project = projectRepository.getProjectById(projectId);

    // Throw a handled error when the project does not exist
    if (!project) {
        throw new Apperror("Project not found", 404);
    }

    // Return the project to the controller
    return project;
};

// ======================================================
// CREATE PROJECT SERVICE FUNCTION
// ======================================================

// Create a new project with business logic validation
const createProject = (name, environment) => {

    // --------------------------------------------------
    // BUSINESS VALIDATION SECTION
    // --------------------------------------------------

    // Validate that project name is provided (not empty or null)
    if (!name) {
        // Throw a handled error if name is missing
        throw new Apperror("Name and environment are required", 400);
    }

    // Validate that environment is provided (not empty or null)
    if (!environment) {
        // Throw a handled error if environment is missing
        throw new Apperror("Name and environment are required", 400);
    }

    // Validate that environment is one of the supported values
    if (
        environment !== "production" &&
        environment !== "development"
    ) {
        // Throw a handled error if environment is not production or development
        throw new Apperror(
            "Environment must be production or development",
            400
        );
    }

    // --------------------------------------------------
    // CREATE PROJECT SECTION
    // --------------------------------------------------

    // Fetch all existing projects to generate the next sequential ID
    const projects = projectRepository.getAllProjects();

    // Create a new project object with auto-generated ID, name, and environment
    const project = {
        // Set ID as one more than the current number of projects
        id: projects.length + 1,
        // Set the project name from the parameter
        name,
        // Set the environment from the parameter
        environment
    };

    // Call the repository to save the project to the data store and return it
    return projectRepository.createProject(project);
};

// Export the service functions for use in other modules
module.exports = {
    getAllProjects,
    getProjectById,
    createProject
};