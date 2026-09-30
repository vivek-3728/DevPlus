const AppError = require("../errors/Apperror");
const projectRepository = require("../repositories/projectRepository");

const validateProjectAnalyticsJobData = (data) => {
    if (data === null
        || typeof data !== "object"
        || Array.isArray(data)
        || Object.getPrototypeOf(data) !== Object.prototype
        || !Number.isSafeInteger(data.projectId)
        || data.projectId <= 0
        || Object.keys(data).some(key => key !== "projectId")) {
        throw new AppError("Invalid project analytics job payload", 400);
    }
    return data.projectId;
};

const generateProjectAnalyticsSnapshot = async (data) => {
    const projectId = validateProjectAnalyticsJobData(data);
    const project = await projectRepository.getProjectById(projectId);
    if (!project) throw new AppError("Project no longer exists", 404);

    // This snapshot only reads project state; it never inserts analytics rows.
    // Re-running a BullMQ job therefore cannot create duplicate results, and
    // the same job stores one completed result in Redis when it eventually wins.
    return {
        projectId: project.id,
        environment: project.environment,
        nameLength: project.name.length,
        hasOwner: project.owner_id !== null
    };
};

module.exports = {
    validateProjectAnalyticsJobData,
    generateProjectAnalyticsSnapshot
};
