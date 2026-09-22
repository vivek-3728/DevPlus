const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runSingleFlight } = require("../src/services/cacheSingleFlight");

test("concurrent work with the same safe cache key runs only once", async () => {
    let releasesWork;
    const gate = new Promise(resolve => { releasesWork = resolve; });
    let executions = 0;
    const work = async () => {
        executions += 1;
        await gate;
        return { id: 7 };
    };

    const first = runSingleFlight("project:user:31:7", work);
    const second = runSingleFlight("project:user:31:7", work);
    releasesWork();

    assert.deepEqual(await Promise.all([first, second]), [{ id: 7 }, { id: 7 }]);
    assert.equal(executions, 1);
});

test("different authorization scopes never share in-flight work", async () => {
    let executions = 0;
    const work = async () => { executions += 1; return executions; };

    const results = await Promise.all([
        runSingleFlight("project:user:31:7", work),
        runSingleFlight("project:user:44:7", work),
        runSingleFlight("project:admin:7", work)
    ]);

    assert.deepEqual(results, [1, 2, 3]);
});

test("failed work is removed so the next request can retry", async () => {
    let executions = 0;

    await assert.rejects(
        runSingleFlight("retryable", async () => {
            executions += 1;
            throw new Error("database unavailable");
        }),
        /database unavailable/
    );

    assert.equal(await runSingleFlight("retryable", async () => {
        executions += 1;
        return "recovered";
    }), "recovered");
    assert.equal(executions, 2);
});
