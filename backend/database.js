const { createClient } = require('@libsql/client');
const dotenv = require('dotenv');

dotenv.config();

const client = createClient({
  url: process.env.TURSO_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  // Tabla de Usuarios
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  // Tabla de Clases (añadimos user_id)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      fecha TEXT,
      titulo TEXT,
      resumen TEXT,
      transcripcion TEXT,
      mapa_mental TEXT,
      audioUrl TEXT,
      user_id TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
}

module.exports = { client, initDB };
