// Custom Error class that extends the built-in Error class
class Apperror extends Error {
  // Constructor that accepts error message and HTTP status code
  constructor(message, statusCode) {
    // Call parent Error class constructor with the error message
    super(message);
    // Store the HTTP status code for the error
    this.statusCode = statusCode;
    // Mark this as an operational (handled) error
    this.isOperational = true;
    // Capture the stack trace for debugging purposes
    Error.captureStackTrace(this, this.constructor);
  }
}

// Export the custom Apperror class for use in other modules
module.exports = Apperror;