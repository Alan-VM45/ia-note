const express = require('express');
const router = express.Router();
const multer = require('multer');
const audioController = require('../controllers/audioController');
const authController = require('../controllers/authController');
const path = require('path');

// Configuración de multer para guardar archivos temporalmente
const upload = multer({ 
    dest: path.join(__dirname, '../../uploads/'),
    limits: { fileSize: 300 * 1024 * 1024 } // Límite aumentado a 300MB para videos largos
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

// Rutas de Cloudinary Direct Upload
router.get('/cloudinary-signature', audioController.getCloudinarySignature);
router.post('/process-url', audioController.processUrl);

// Ruta para subir el audio y procesarlo
router.post('/upload-audio', upload.single('audio'), audioController.processAudio);

// Rutas para subida fragmentada (Audios > 5 min)
router.post('/upload-chunk', upload.single('audio'), audioController.uploadChunk);
router.post('/process-chunks', audioController.processChunks);

// Ruta para el chat interactivo
router.post('/chat', audioController.chatWithNotes);


module.exports = router;
