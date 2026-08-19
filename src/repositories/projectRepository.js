// ======================================================
// TEMPORARY DATA STORE - Using in-memory array as mock database
// ======================================================
// NOTE: This is temporary and will be replaced with PostgreSQL later
// Currently using a JavaScript array to learn the architecture

// Initialize an array to store all projects (mock database)
const projects = [
    // Sample project 1 with id, name, and environment
    {
        id: 1,
        name: "FinTrack",
        environment: "production"
    },
    // Sample project 2 with id, name, and environment
    {
        id: 2,
        name: "CampusOS",
        environment: "development"
    }
];

// ======================================================
// GET ALL PROJECTS FUNCTION
// ======================================================

// Retrieve all projects from the mock database
const getAllProjects = () => {
    // Return the entire projects array
    return projects;
};

// ======================================================
// GET ONE PROJECT FUNCTION
// ======================================================

// Retrieve one project from the mock database by ID
const getProjectById = (id) => {
    // Find and return the project with the matching ID
    return projects.find((project) => project.id === id);
};

// ======================================================
// CREATE PROJECT FUNCTION
// ======================================================

// Add a new project to the mock database
const createProject = (project) => {
    // Add the new project to the end of the projects array
    projects.push(project);

    // Return the newly created project
    return project;
};

// Export the repository functions for use in other modules
module.exports = {
    getAllProjects,
    getProjectById,
    createProject
};