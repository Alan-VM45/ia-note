const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { initDB } = require('./database');

// Cargar variables de entorno
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Rutas
const audioRoutes = require('./routes/audioRoutes');
app.use('/api', audioRoutes);

// Endpoint para obtener la versión de package.json
const pkg = require('../package.json');
app.get('/api/version', (req, res) => {
    res.json({ version: pkg.version });
});

// Iniciar base de datos y luego el servidor
initDB().then(() => {
    const server = app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
    server.timeout = 900000; // 15 minutos para subidas muy pesadas
}).catch(err => {
    console.error('Error inicializando la base de datos:', err);
});
