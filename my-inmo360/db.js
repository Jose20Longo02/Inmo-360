// db.js
const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'inmo360_db',
  password: 'Jose20Longo02',
  port: 5432
});

module.exports = pool;