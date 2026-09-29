// Keep dotenv's startup banner out of stdout so application logs remain valid
// one-JSON-object-per-line output for production log collectors.
require("dotenv").config({ quiet: true });

const { Pool } = require("pg");
const { getDatabaseConfig } = require("./database");

const pool = new Pool(getDatabaseConfig(process.env));

module.exports = pool;
