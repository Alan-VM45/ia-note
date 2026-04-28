const { createClient } = require('@libsql/client');
const dotenv = require('dotenv');

dotenv.config();

const client = createClient({
  url: process.env.TURSO_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      fecha TEXT,
      titulo TEXT,
      resumen TEXT,
      transcripcion TEXT,
      mapa_mental TEXT,
      audioUrl TEXT
    )
  `);
}

module.exports = { client, initDB };
