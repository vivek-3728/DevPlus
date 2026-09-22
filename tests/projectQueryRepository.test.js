const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/config/db");
const projectRepository = require("../src/repositories/projectRepository");

const originalQuery = pool.query;
afterEach(() => { pool.query = originalQuery; });

test("combined user query applies identical ownership and filters to count and page", async () => {
    const calls = [];
    pool.query = async (sql, values) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
        return calls.length === 1
            ? { rows: [{ total: "12" }] }
            : { rows: [{ id: 7, name: "Dev API", owner_id: 31 }] };
    };

    const result = await projectRepository.queryProjects({
        ownerId: 31,
        environment: "production",
        search: "dev",
        sort: "name",
        order: "asc",
        limit: 10,
        offset: 10
    });

    assert.deepEqual(result, {
        total: 12,
        projects: [{ id: 7, name: "Dev API", owner_id: 31 }]
    });
    assert.match(calls[0].sql, /WHERE p\.owner_id = \$1 AND p\.environment = \$2 AND p\.name ILIKE \$3/i);
    assert.match(calls[1].sql, /WHERE p\.owner_id = \$1 AND p\.environment = \$2 AND p\.name ILIKE \$3/i);
    assert.match(calls[1].sql, /ORDER BY p\.name ASC, p\.id ASC LIMIT \$4 OFFSET \$5$/i);
    assert.deepEqual(calls[0].values, [31, "production", "%dev%"]);
    assert.deepEqual(calls[1].values, [31, "production", "%dev%", 10, 10]);
});

test("search wildcard characters are escaped for a literal substring match", async () => {
    const calls = [];
    pool.query = async (sql, values) => {
        calls.push({ sql, values });
        return { rows: calls.length === 1 ? [{ total: "0" }] : [] };
    };

    await projectRepository.queryProjects({
        ownerId: undefined,
        environment: undefined,
        search: "50%_\\done",
        sort: "id",
        order: "desc",
        limit: 5,
        offset: 0
    });

    assert.match(calls[0].sql, /ILIKE \$1 ESCAPE '\\'/i);
    assert.deepEqual(calls[0].values, ["%50\\%\\_\\\\done%"]);
    assert.match(calls[1].sql, /ORDER BY p\.id DESC\s+LIMIT \$2 OFFSET \$3/i);
});

test("sorting uses hard-coded SQL fragments rather than caller text", async () => {
    const statements = [];
    pool.query = async (sql) => {
        statements.push(sql);
        return { rows: statements.length === 1 ? [{ total: "0" }] : [] };
    };

    await projectRepository.queryProjects({
        sort: "created_at",
        order: "desc",
        limit: 10,
        offset: 0
    });

    assert.match(statements[1], /ORDER BY p\.created_at DESC, p\.id ASC/i);
});
