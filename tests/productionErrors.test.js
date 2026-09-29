const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const AppError = require("../src/errors/Apperror");
const { createErrorHandler } = require("../src/middleware/errorHandler");
const { createLogger } = require("../src/utils/structuredLogger");

const startErrorApp = async (logger) => {
    const app = express();
    app.get("/unexpected", () => {
        const error = new Error("password=secret database=private Redis URL=hidden");
        error.code = "DATABASE_FAILURE";
        throw error;
    });
    app.get("/expected", (req, res, next) => {
        next(new AppError("Forbidden", 403));
    });
    app.use(createErrorHandler({ logger, env: { NODE_ENV: "production" } }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve))
    };
};

test("production hides unexpected error details from responses and logs", async (t) => {
    const logged = [];
    const logger = createLogger({ sink: { write: value => logged.push(value) } });
    const running = await startErrorApp(logger);
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/unexpected`);

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal Server Error" });
    const renderedLog = logged.join("\n");
    assert.equal(renderedLog.includes("secret"), false);
    assert.equal(renderedLog.includes("private"), false);
    assert.equal(renderedLog.includes("hidden"), false);
    assert.equal(renderedLog.includes("DATABASE_FAILURE"), true);
});

test("production preserves expected AppError status codes and messages", async (t) => {
    const logger = createLogger({ sink: { write: () => {} } });
    const running = await startErrorApp(logger);
    t.after(running.close);

    const response = await fetch(`${running.baseUrl}/expected`);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });
});
