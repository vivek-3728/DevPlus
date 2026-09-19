const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/config/db");
const projectRepository = require("../src/repositories/projectRepository");

const originalQuery = pool.query;

afterEach(() => {
    pool.query = originalQuery;
});

test("getProjectsWithOwners returns owned and legacy projects with only safe owner fields", async () => {
    let capturedSql;
    const databaseRows = [
        {
            project_id: 1,
            project_name: "Legacy",
            environment: "development",
            owner_id: null,
            owner_name: null,
            owner_email: null
        },
        {
            project_id: 2,
            project_name: "API",
            environment: "production",
            owner_id: 7,
            owner_name: "Ada",
            owner_email: "ada@example.com"
        }
    ];
    pool.query = async (sql) => {
        capturedSql = sql.replace(/\s+/g, " ").trim();
        return { rows: databaseRows };
    };

    const projects = await projectRepository.getProjectsWithOwners();

    assert.deepEqual(projects, databaseRows);
    assert.match(
        capturedSql,
        /FROM projects AS p LEFT JOIN users AS u ON u\.id = p\.owner_id/i
    );
    assert.match(capturedSql, /p\.id AS project_id/i);
    assert.match(capturedSql, /p\.name AS project_name/i);
    assert.match(capturedSql, /p\.environment/i);
    assert.match(capturedSql, /u\.id AS owner_id/i);
    assert.match(capturedSql, /u\.name AS owner_name/i);
    assert.match(capturedSql, /u\.email AS owner_email/i);
    assert.match(capturedSql, /ORDER BY p\.id$/i);
    assert.equal(capturedSql.includes("*"), false);
    assert.equal(/password_hash/i.test(capturedSql), false);
    assert.equal(projects.some((project) => Object.hasOwn(project, "password_hash")), false);
});
