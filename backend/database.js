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

  // Tabla de Clases
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

  // Migración manual: Añadimos user_id, status y error_message si no existen
  try {
    await client.execute("ALTER TABLE classes ADD COLUMN user_id TEXT");
  } catch (e) {}

  try {
    await client.execute("ALTER TABLE classes ADD COLUMN status TEXT DEFAULT 'completado'");
    console.log("Columna status añadida con éxito");
  } catch (e) {}

  try {
    await client.execute("ALTER TABLE classes ADD COLUMN error_message TEXT");
    console.log("Columna error_message añadida con éxito");
  } catch (e) {}
}

module.exports = { client, initDB };
