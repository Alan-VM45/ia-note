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

// Iniciar base de datos y luego el servidor
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Error inicializando la base de datos:', err);
});
