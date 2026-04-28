const express = require('express');
const router = express.Router();
const multer = require('multer');
const audioController = require('../controllers/audioController');
const path = require('path');

// Configuración de multer para guardar archivos temporalmente
const upload = multer({ dest: path.join(__dirname, '../../uploads/') });

// Rutas de clases
router.get('/classes', audioController.getClasses);
router.get('/classes/:id', audioController.getClassById);

// Ruta para subir el audio y procesarlo
router.post('/upload-audio', upload.single('audio'), audioController.processAudio);

// Ruta para el chat interactivo
router.post('/chat', audioController.chatWithNotes);

module.exports = router;
