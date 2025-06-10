// db.js — Configuración para usar DATABASE_URL en producción
const { Pool } = require('pg');

// Leer la cadena de conexión de la variable de entorno
const connectionString = process.env.DATABASE_URL;

// Configurar Pool para Postgres
const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false  // necesario para clusters gestionados que requieren SSL
  }
});

module.exports = pool;
