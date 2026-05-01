const express = require('express');
const router = express.Router();
const multer = require('multer');
const audioController = require('../controllers/audioController');
const authController = require('../controllers/authController');
const path = require('path');

// Configuración de multer para guardar archivos temporalmente
const upload = multer({ 
    dest: path.join(__dirname, '../../uploads/'),
    limits: { fileSize: 100 * 1024 * 1024 } // Límite de 100MB
});

// Rutas de Auth
router.post('/register', authController.register);
router.post('/login', authController.login);

// Todas las rutas de abajo requieren token
router.use(authController.authenticateToken);

// Rutas de clases
router.get('/classes', audioController.getClasses);
router.get('/classes/:id', audioController.getClassById);
router.delete('/classes/:id', audioController.deleteClass);

// Ruta para subir el audio y procesarlo
router.post('/upload-audio', upload.single('audio'), audioController.processAudio);

// Ruta para el chat interactivo
router.post('/chat', audioController.chatWithNotes);

module.exports = router;
