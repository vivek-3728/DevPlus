const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/config/db");
const projectRepository = require("../src/repositories/projectRepository");

const originalQuery = pool.query;
const originalConnect = pool.connect;
afterEach(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
});

test("getProjectsByOwnerId scopes rows with a parameterized owner ID", async () => {
    let captured;
    pool.query = async (sql, values) => {
        captured = { sql: sql.replace(/\s+/g, " ").trim(), values };
        return { rows: [{ id: 7, owner_id: 31 }] };
    };

    const rows = await projectRepository.getProjectsByOwnerId(31);

    assert.deepEqual(rows, [{ id: 7, owner_id: 31 }]);
    assert.match(captured.sql, /^SELECT \* FROM projects WHERE owner_id = \$1 ORDER BY id$/i);
    assert.deepEqual(captured.values, [31]);
});

test("createProject commits the project and audit record on one client", async () => {
    const calls = [];
    let releases = 0;
    const client = {
        query: async (sql, values) => {
            const normalizedSql = sql.replace(/\s+/g, " ").trim();
            calls.push({ sql: normalizedSql, values });
            if (/^INSERT INTO projects/i.test(normalizedSql)) {
                return {
                    rows: [{
                        id: 8,
                        name: "Owned",
                        environment: "development",
                        owner_id: 31
                    }]
                };
            }
            return { rows: [] };
        },
        release: () => { releases += 1; }
    };
    pool.connect = async () => client;
    pool.query = async () => { throw new Error("createProject bypassed the checked-out client"); };

    const project = await projectRepository.createProject({
        name: "Owned",
        environment: "development",
        ownerId: 31
    });

    assert.equal(project.id, 8);
    assert.deepEqual(calls.map((call) => call.sql.split(" ")[0]), [
        "BEGIN", "INSERT", "INSERT", "COMMIT"
    ]);
    assert.match(
        calls[1].sql,
        /INSERT INTO projects \(name, environment, owner_id\) VALUES \(\$1, \$2, \$3\)/i
    );
    assert.deepEqual(calls[1].values, ["Owned", "development", 31]);
    assert.match(calls[2].sql, /INSERT INTO project_audit_log/i);
    assert.deepEqual(calls[2].values, [8, 31, "Owned", "development"]);
    assert.equal(releases, 1);
});

test("createProject rolls back and releases the client when the audit insert fails", async () => {
    const auditError = new Error("audit insert failed");
    const calls = [];
    let releases = 0;
    pool.connect = async () => ({
        query: async (sql) => {
            const normalizedSql = sql.replace(/\s+/g, " ").trim();
            calls.push(normalizedSql);
            if (/^INSERT INTO projects/i.test(normalizedSql)) {
                return { rows: [{ id: 8 }] };
            }
            if (/^INSERT INTO project_audit_log/i.test(normalizedSql)) throw auditError;
            return { rows: [] };
        },
        release: () => { releases += 1; }
    });
    pool.query = async () => { throw new Error("createProject bypassed the checked-out client"); };

    await assert.rejects(
        projectRepository.createProject({
            name: "Owned", environment: "development", ownerId: 31
        }),
        (error) => error === auditError
    );

    assert.equal(calls.includes("ROLLBACK"), true);
    assert.equal(calls.includes("COMMIT"), false);
    assert.equal(releases, 1);
});

test("createProject attempts rollback and releases the client when commit fails", async () => {
    const commitError = new Error("commit failed");
    const calls = [];
    let releases = 0;
    pool.connect = async () => ({
        query: async (sql) => {
            const normalizedSql = sql.replace(/\s+/g, " ").trim();
            calls.push(normalizedSql);
            if (/^INSERT INTO projects/i.test(normalizedSql)) {
                return { rows: [{ id: 8 }] };
            }
            if (normalizedSql === "COMMIT") throw commitError;
            return { rows: [] };
        },
        release: () => { releases += 1; }
    });
    pool.query = async () => { throw new Error("createProject bypassed the checked-out client"); };

    await assert.rejects(
        projectRepository.createProject({
            name: "Owned", environment: "development", ownerId: 31
        }),
        (error) => error === commitError
    );

    assert.equal(calls.includes("ROLLBACK"), true);
    assert.equal(releases, 1);
});

test("createProject preserves the write error and releases when rollback also fails", async () => {
    const auditError = new Error("audit insert failed");
    const rollbackError = new Error("rollback failed");
    const releaseArguments = [];
    pool.connect = async () => ({
        query: async (sql) => {
            const normalizedSql = sql.replace(/\s+/g, " ").trim();
            if (/^INSERT INTO projects/i.test(normalizedSql)) {
                return { rows: [{ id: 8 }] };
            }
            if (/^INSERT INTO project_audit_log/i.test(normalizedSql)) throw auditError;
            if (normalizedSql === "ROLLBACK") throw rollbackError;
            return { rows: [] };
        },
        release: (error) => { releaseArguments.push(error); }
    });
    pool.query = async () => { throw new Error("createProject bypassed the checked-out client"); };

    await assert.rejects(
        projectRepository.createProject({
            name: "Owned", environment: "development", ownerId: 31
        }),
        (error) => error === auditError
    );
    // Passing the rollback error to release(error) tells pg-pool to destroy
    // this unsafe connection instead of giving it to another request.
    assert.deepEqual(releaseArguments, [rollbackError]);
});

test("update and delete never transfer ownership", async () => {
    const statements = [];
    pool.query = async (sql) => {
        statements.push(sql);
        return { rows: [{ id: 7 }] };
    };

    await projectRepository.updateProject(7, { name: "Updated", environment: "production" });
    await projectRepository.deleteProject(7);

    assert.equal(statements.every((sql) => !/SET[\s\S]*owner_id/i.test(sql)), true);
});
