const { AsyncLocalStorage } = require("node:async_hooks");

// AsyncLocalStorage keeps a small context attached to one asynchronous request
// flow. Code deep in a service can read the request ID without adding a new
// parameter to every controller, service, and repository function.
const requestContextStorage = new AsyncLocalStorage();

const runWithRequestContext = (context, callback) => {
    return requestContextStorage.run(context, callback);
};

const getRequestContext = () => requestContextStorage.getStore() || {};

module.exports = { runWithRequestContext, getRequestContext };

