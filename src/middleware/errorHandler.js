// The import below is currently unused: the handler checks err.isOperational,
// rather than using instanceof Apperror to check the error's class.
// Import the Apperror class for checking if error is operational
const Apperror = require("../errors/Apperror");

// Define error handler middleware with 4 parameters (Express identifies this as error handler by parameter count)
const errorHandler = (err, req, res, next) => {
    // Keep all four parameters: Express uses this signature to recognize error middleware.
    // next(error), thrown errors, and rejected async handlers can arrive here.
    // Log the error to the console for debugging and monitoring purposes
    console.error(err);

    // Return a proper client error when JSON request parsing fails
    if (err.type === "entity.parse.failed") {
        // return stops execution so the handler cannot send a second response below.
        return res.status(400).json({
            error: "Invalid JSON payload"
        });
    }

    // Check if this is one of our custom operational errors with proper status codes
    if (err.isOperational) {
        // If it's an operational error, send the response with the stored status code and message
        return res.status(err.statusCode).json({
            error: err.message
        });
    }

    // Internal details stay in console.error above instead of being sent to the client.
    // For any unexpected errors that are not operational, send a generic 500 error response
    res.status(500).json({
        error: "Internal Server Error"
    });
};

// Export the errorHandler middleware function so it can be used in other modules
module.exports = errorHandler;   