const { getErrorLogMessage } = require("../utils/errorDiagnostics");
const { logger: defaultLogger } = require("../utils/structuredLogger");

const projectRoom = projectId => `project:${projectId}`;
const userRoom = userId => `user:${userId}`;
const ADMIN_ROOM = "role:admin";

const safeProject = project => ({
    id: project.id,
    name: project.name,
    environment: project.environment,
    owner_id: project.owner_id,
    ...(project.created_at === undefined ? {} : { created_at: project.created_at })
});

const targetAuthorizedRooms = (io, projectId, ownerId) => {
    // Socket.IO treats chained rooms as a union and sends at most one copy to a
    // socket that belongs to several rooms. There is intentionally no global
    // broadcast: only the project, its owner, and administrators are targeted.
    let target = io.to(projectRoom(projectId)).to(ADMIN_ROOM);
    if (Number.isSafeInteger(ownerId) && ownerId > 0) {
        target = target.to(userRoom(ownerId));
    }
    return target;
};

const createProjectEventPublisher = (io) => ({
    created(project, context = {}) {
        targetAuthorizedRooms(io, project.id, project.owner_id).emit("project:created", {
            project: safeProject(project),
            ...(context.requestId ? { requestId: context.requestId } : {})
        });
    },
    updated(project, context = {}) {
        targetAuthorizedRooms(io, project.id, project.owner_id).emit("project:updated", {
            project: safeProject(project),
            ...(context.requestId ? { requestId: context.requestId } : {})
        });
    },
    deleted(project, context = {}) {
        targetAuthorizedRooms(io, project.id, project.owner_id).emit("project:deleted", {
            projectId: project.id,
            ...(context.requestId ? { requestId: context.requestId } : {})
        });
        // The resource no longer exists, so explicit subscriptions to its room
        // are no longer meaningful. Owner/admin scope rooms remain unchanged.
        io.in(projectRoom(project.id)).socketsLeave(projectRoom(project.id));
    }
});

// A real-time delivery problem must not turn an already committed database
// mutation into an HTTP 500. PostgreSQL remains the source of truth, so this
// helper logs the optional delivery failure and preserves the REST response.
const publishProjectMutation = (req, method, project, logger = defaultLogger) => {
    try {
        req.app.get("projectEventPublisher")?.[method]?.(project, {
            requestId: req.requestId
        });
    } catch (error) {
        logger.warn("socket.project_event_delivery_failed", {
            socketEvent: `project:${method}`,
            projectId: project?.id,
            message: getErrorLogMessage(error)
        });
    }
};

module.exports = {
    ADMIN_ROOM,
    projectRoom,
    userRoom,
    safeProject,
    createProjectEventPublisher,
    publishProjectMutation
};
