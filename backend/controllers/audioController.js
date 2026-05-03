const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { client } = require('../database');
const cloudinary = require('cloudinary').v2;
// Intento de importación robusta para diferentes versiones de la librería
const officeModule = require('office-text-extractor');
const officeTextExtractor = officeModule.officeTextExtractor || officeModule.default || officeModule;

const ai = new GoogleGenAI(process.env.GEMINI_API_KEY || '');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const getCloudinaryResourceType = (mimetype) => {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('audio/') || mimetype.startsWith('video/')) return 'video';
    // PPTX, DOCX, etc. se suben como 'raw'
    return 'raw';
};

const uploadToCloudinary = (filePath, mimetype) => {
    const resourceType = getCloudinaryResourceType(mimetype);
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { 
                resource_type: resourceType, 
                folder: 'ia-notes'
            },
            (error, result) => {
                if (error) {
                    console.error('--- CLOUDINARY API ERROR ---');
                    console.error(JSON.stringify(error, null, 2));
                    reject(new Error(`Cloudinary Error: ${error.message || 'Unknown error'}`));
                } else {
                    resolve(result);
                }
            }
        );
        fs.createReadStream(filePath).pipe(stream);
    });
};

const downloadFile = (url, dest) => {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error('Failed to download file from Cloudinary, status: ' + response.statusCode));
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
};

exports.getCloudinarySignature = (req, res) => {
    try {
        const timestamp = Math.round((new Date).getTime() / 1000);
        const signature = cloudinary.utils.api_sign_request({
            timestamp: timestamp,
            folder: 'ia-notes'
        }, process.env.CLOUDINARY_API_SECRET);

        res.json({
            signature,
            timestamp,
            cloudName: process.env.CLOUDINARY_CLOUD_NAME,
            apiKey: process.env.CLOUDINARY_API_KEY
        });
    } catch (err) {
        console.error("Error generating signature:", err);
        res.status(500).json({ error: "Error al generar firma de subida" });
    }
};

exports.processUrl = async (req, res) => {
    try {
        const { fileUrl, mimetype, originalname } = req.body;
        if (!fileUrl) {
            return res.status(400).json({ error: 'No se proporcionó URL del archivo.' });
        }

        const audioId = Date.now().toString();
        console.log('Recibida URL de Cloudinary:', fileUrl);

        // Crear registro inicial en la DB y responder rápido al cliente
        await client.execute({
            sql: "INSERT INTO classes (id, fecha, titulo, status, audioUrl, user_id) VALUES (?, ?, ?, ?, ?, ?)",
            args: [
                audioId,
                new Date().toISOString(),
                'Procesando contenido...',
                'procesando',
                fileUrl,
                req.user.userId
            ]
        });

        res.json({
            id: audioId,
            status: 'procesando',
            message: 'Archivo en la nube recibido y en proceso de análisis.'
        });

        // Proceso pesado en background
        (async () => {
            const uploadsDir = path.join(__dirname, '../../uploads/');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            
            const tempFilePath = path.join(uploadsDir, `download_${audioId}`);
            
            try {
                console.log(`[${audioId}] Descargando archivo desde Cloudinary al servidor para analizar...`);
                await downloadFile(fileUrl, tempFilePath);
                
                // Reutilizamos la lógica inyectando el path en un objeto simulado req.file
                req.file = {
                    path: tempFilePath,
                    mimetype: mimetype || 'application/octet-stream',
                    originalname: originalname || 'archivo_nube'
                };
                
                console.log(`[${audioId}] Archivo descargado, iniciando IA...`);
                // Lógica de Gemini (extraída de processAudio original)
                await processWithGemini(audioId, tempFilePath, req.file, fileUrl);
                
            } catch (bgError) {
                console.error(`[${audioId}] ERROR EN BACKGROUND (Gemini/Turso):`, bgError);
                await client.execute({
                    sql: "UPDATE classes SET status = 'error', error_message = ? WHERE id = ?",
                    args: [bgError.message || 'Error desconocido en procesamiento', audioId]
                });
            } finally {
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                    console.log(`[${audioId}] Archivo temporal eliminado.`);
                }
            }
        })();

    } catch (error) {
        console.error('ERROR EN PROCESSURL:', error);
        res.status(500).json({ error: 'Error al iniciar el procesamiento de URL.' });
    }
};

// Función auxiliar para separar la lógica de Gemini de processAudio y processUrl
async function processWithGemini(audioId, tempFilePath, fileObj, audioUrl) {
    const isOfficeFile = fileObj.mimetype.includes('officedocument') || 
                        fileObj.mimetype.includes('ms-powerpoint') || 
                        fileObj.mimetype.includes('msword') ||
                        fileObj.mimetype.includes('application/vnd.ms-powerpoint') ||
                        fileObj.originalname.endsWith('.docx') ||
                        fileObj.originalname.endsWith('.pptx') ||
                        fileObj.originalname.endsWith('.ppt') ||
                        fileObj.originalname.endsWith('.doc');

    let aiResponse;
    const callGeminiWithRetry = async (payload, retries = 3) => {
        for (let i = 0; i < retries; i++) {
            try {
                return await ai.models.generateContent(payload);
            } catch (err) {
                if (err.message.includes('503') || err.message.includes('high demand')) {
                    console.log(`[${audioId}] Gemini ocupado (503), reintentando en ${2000 * (i + 1)}ms...`);
                    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
                    continue;
                }
                throw err;
            }
        }
    };

    if (isOfficeFile) {
        console.log(`[${audioId}] Detectado archivo de Office, extrayendo texto...`);
        const extractedText = await officeTextExtractor(tempFilePath);
        
        const prompt = `Eres un asistente de estudio experto. Analiza el siguiente texto extraído de un documento (${fileObj.originalname}) y genera un resumen educativo.
        
        Responde ESTRICTAMENTE en formato JSON:
        {
          "titulo": "Título descriptivo",
          "resumen": "Contenido detallado en Markdown",
          "transcripcion": "Texto extraído completo",
          "mapa_mental": "Esquema Mermaid.js"
        }

        CONTENIDO DEL DOCUMENTO:
        ${extractedText}`;

        aiResponse = await callGeminiWithRetry({
            model: 'gemini-flash-latest',
            config: { responseMimeType: "application/json" },
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });
    } else {
        const uploadResult = await ai.files.upload({
            file: tempFilePath,
            config: { mimeType: fileObj.mimetype }
        });

        let file = await ai.files.get({ name: uploadResult.name });
        let retryCount = 0;
        while (file.state === 'PROCESSING' && retryCount < 40) {
            await new Promise(r => setTimeout(r, 2000));
            file = await ai.files.get({ name: uploadResult.name });
            retryCount++;
        }

        if (file.state !== 'ACTIVE') throw new Error('Gemini falló: ' + file.state);

        const prompt = `Eres un asistente de estudio experto y analista de contenido multimedial.
        Analiza el archivo proporcionado. Extrae el conocimiento y estructúralo para un estudiante.
        Responde ESTRICTAMENTE en formato JSON:
        {
          "titulo": "Un título descriptivo y corto",
          "resumen": "Contenido educativo detallado en formato Markdown",
          "transcripcion": "Texto extraído o transcripción completa",
          "mapa_mental": "Esquema Mermaid.js (ej: graph TD\\nA-->B)"
        }`;

        aiResponse = await callGeminiWithRetry({
            model: 'gemini-flash-latest',
            config: { responseMimeType: "application/json" },
            contents: [{
                role: 'user',
                parts: [
                    { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
                    { text: prompt }
                ]
            }]
        });
    }

    let cleanedText = aiResponse.text.trim();
    if (cleanedText.startsWith('\`\`\`')) {
        cleanedText = cleanedText.replace(/^\`\`\`(?:json)?\n?/, '').replace(/\n?\`\`\`$/, '');
    }
    
    let aiData;
    try {
        aiData = JSON.parse(cleanedText);
    } catch (parseError) {
        console.error("Error parseando JSON de Gemini:", parseError);
        const secondAttemptText = cleanedText.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
        aiData = JSON.parse(secondAttemptText);
    }

    await client.execute({
        sql: "UPDATE classes SET titulo = ?, resumen = ?, transcripcion = ?, mapa_mental = ?, status = 'completado' WHERE id = ?",
        args: [aiData.titulo, aiData.resumen, aiData.transcripcion, aiData.mapa_mental, audioId]
    });
    console.log(`[${audioId}] Procesamiento completado con éxito.`);
}



exports.processAudio = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se subió ningún archivo de audio.' });
        }

        const tempFilePath = req.file.path;
        let audioId; // Definir fuera para que esté disponible en el catch si es necesario
        console.log('Audio recibido:', {
            path: tempFilePath,
            size: req.file.size,
            mimetype: req.file.mimetype
        });

        // 1. Subir a Cloudinary para almacenamiento permanente usando Streams (Cero RAM)
        console.log('Iniciando subida a Cloudinary vía Stream...');
        let cloudinaryResult;
        
        try {
            cloudinaryResult = await uploadToCloudinary(tempFilePath, req.file.mimetype);
        } catch (cloudErr) {
            console.error('Error crítico subiendo a Cloudinary:', cloudErr);
            return res.status(500).json({ 
                error: 'Error al guardar el archivo en la nube.',
                details: cloudErr.message 
            });
        }

        const audioUrl = cloudinaryResult.secure_url;
        console.log('Subida a Cloudinary exitosa:', audioUrl);

        audioId = Date.now().toString();

        // 2. Crear registro inicial en "procesando" y responder al cliente
        console.log('Creando registro inicial en la DB...');
        await client.execute({
            sql: "INSERT INTO classes (id, fecha, titulo, status, audioUrl, user_id) VALUES (?, ?, ?, ?, ?, ?)",
            args: [
                audioId,
                new Date().toISOString(),
                'Procesando contenido...',
                'procesando',
                audioUrl,
                req.user.userId
            ]
        });

        // Respondemos inmediatamente al frontend para evitar el timeout de Render
        res.json({
            id: audioId,
            status: 'procesando',
            message: 'Archivo recibido y en proceso de análisis.'
        });

        // 3. Iniciar procesamiento pesado en "segundo plano"
        (async () => {
            try {
                console.log(`[${audioId}] Iniciando proceso Gemini en background...`);
                
                const mimetype = req.file.mimetype.toLowerCase();
                const originalName = req.file.originalname.toLowerCase();
                
                const isOfficeFile = mimetype.includes('officedocument') || 
                                    mimetype.includes('ms-powerpoint') || 
                                    mimetype.includes('msword') ||
                                    mimetype.includes('application/vnd.ms-powerpoint') ||
                                    originalName.endsWith('.docx') ||
                                    originalName.endsWith('.pptx') ||
                                    originalName.endsWith('.ppt') ||
                                    originalName.endsWith('.doc');


                let aiResponse;
                const callGeminiWithRetry = async (payload, retries = 3) => {
                    for (let i = 0; i < retries; i++) {
                        try {
                            return await ai.models.generateContent(payload);
                        } catch (err) {
                            if (err.message.includes('503') || err.message.includes('high demand')) {
                                console.log(`[${audioId}] Gemini ocupado (503), reintentando en ${2000 * (i + 1)}ms...`);
                                await new Promise(r => setTimeout(r, 2000 * (i + 1)));
                                continue;
                            }
                            throw err;
                        }
                    }
                };

                if (isOfficeFile) {
                    console.log(`[${audioId}] Detectado archivo de Office, extrayendo texto...`);
                    const extractedText = await officeTextExtractor(tempFilePath);
                    
                    const prompt = `Eres un asistente de estudio experto. Analiza el siguiente texto extraído de un documento (${req.file.originalname}) y genera un resumen educativo.
                    
                    Responde ESTRICTAMENTE en formato JSON:
                    {
                      "titulo": "Título descriptivo",
                      "resumen": "Contenido detallado en Markdown",
                      "transcripcion": "Texto extraído completo",
                      "mapa_mental": "Esquema Mermaid.js"
                    }

                    CONTENIDO DEL DOCUMENTO:
                    ${extractedText}`;

                    aiResponse = await callGeminiWithRetry({
                        model: 'gemini-flash-latest',
                        config: { responseMimeType: "application/json" },
                        contents: [{ role: 'user', parts: [{ text: prompt }] }]
                    });
                } else {
                    // Proceso normal para PDF, Audio, Video e Imágenes (vía Gemini File API)
                    const uploadResult = await ai.files.upload({
                        file: tempFilePath,
                        config: { mimeType: req.file.mimetype }
                    });

                    let file = await ai.files.get({ name: uploadResult.name });
                    let retryCount = 0;
                    while (file.state === 'PROCESSING' && retryCount < 40) {
                        await new Promise(r => setTimeout(r, 2000));
                        file = await ai.files.get({ name: uploadResult.name });
                        retryCount++;
                    }

                    if (file.state !== 'ACTIVE') throw new Error('Gemini falló: ' + file.state);

                    const prompt = `Eres un asistente de estudio experto y analista de contenido multimedial.
                    Analiza el archivo proporcionado. Extrae el conocimiento y estructúralo para un estudiante.
                    Responde ESTRICTAMENTE en formato JSON:
                    {
                      "titulo": "Un título descriptivo y corto",
                      "resumen": "Contenido educativo detallado en formato Markdown",
                      "transcripcion": "Texto extraído o transcripción completa",
                      "mapa_mental": "Esquema Mermaid.js (ej: graph TD\\nA-->B)"
                    }`;

                    aiResponse = await callGeminiWithRetry({
                        model: 'gemini-flash-latest',
                        config: { responseMimeType: "application/json" },
                        contents: [{
                            role: 'user',
                            parts: [
                                { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
                                { text: prompt }
                            ]
                        }]
                    });
                }

                let cleanedText = aiResponse.text.trim();
                if (cleanedText.startsWith('```')) {
                    cleanedText = cleanedText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
                }
                
                let aiData;
                try {
                    aiData = JSON.parse(cleanedText);
                } catch (parseError) {
                    console.error("Error parseando JSON de Gemini:", parseError);
                    const secondAttemptText = cleanedText.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
                    aiData = JSON.parse(secondAttemptText);
                }

                // 4. Actualizar registro final
                await client.execute({
                    sql: "UPDATE classes SET titulo = ?, resumen = ?, transcripcion = ?, mapa_mental = ?, status = 'completado' WHERE id = ?",
                    args: [aiData.titulo, aiData.resumen, aiData.transcripcion, aiData.mapa_mental, audioId]
                });
                console.log(`[${audioId}] Procesamiento completado con éxito.`);

            } catch (bgError) {
                console.error(`[${audioId}] ERROR EN BACKGROUND (Gemini/Turso):`, bgError);
                
                // Loguear error exacto de Turso si existe
                if (bgError.cause) {
                    console.error('Causa del error:', bgError.cause);
                }

                await client.execute({
                    sql: "UPDATE classes SET status = 'error', error_message = ? WHERE id = ?",
                    args: [bgError.message || 'Error desconocido en procesamiento', audioId]
                });

            } finally {
                // Limpiar archivo temporal al final del proceso de fondo
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                    console.log(`[${audioId}] Archivo temporal eliminado.`);
                }
            }
        })();

        return; // Fin de la función principal (la respuesta ya se envió)

    } catch (error) {
        console.error('ERROR EN PROCESSAUDIO (INICIAL):', error);
        res.status(500).json({ error: 'Error al iniciar el procesamiento.' });
    }
};

exports.getClasses = async (req, res) => {
    try {
        const rs = await client.execute({
            sql: "SELECT id, titulo, fecha, status FROM classes WHERE user_id = ? ORDER BY fecha DESC",
            args: [req.user.userId]
        });
        res.json(rs.rows);
    } catch (error) {
        console.error('Error al obtener clases:', error);
        res.status(500).json({ error: 'Error al obtener clases de la base de datos SQL' });
    }
};

exports.getClassById = async (req, res) => {
    try {
        const rs = await client.execute({
            sql: "SELECT * FROM classes WHERE id = ? AND user_id = ?",
            args: [req.params.id, req.user.userId]
        });
        
        if (rs.rows.length === 0) {
            return res.status(404).json({ error: 'Clase no encontrada' });
        }
        res.json(rs.rows[0]);
    } catch (error) {
        console.error('Error al obtener la clase:', error);
        res.status(500).json({ error: 'Error al obtener la clase de SQL' });
    }
};

exports.deleteClass = async (req, res) => {
    try {
        const { id } = req.params;
        await client.execute({
            sql: "DELETE FROM classes WHERE id = ? AND user_id = ?",
            args: [id, req.user.userId]
        });
        res.json({ message: 'Clase eliminada con éxito' });
    } catch (error) {
        console.error('Error al eliminar:', error);
        res.status(500).json({ error: 'Error al eliminar la clase' });
    }
};

exports.chatWithNotes = async (req, res) => {
    try {
        const { question, context } = req.body;

        if (!question || !context) {
            return res.status(400).json({ error: 'Faltan datos (pregunta o contexto).' });
        }

        const prompt = `Eres un tutor experto. Basándote ÚNICAMENTE en los siguientes apuntes de clase, responde la pregunta del alumno.
Si la respuesta no está en los apuntes, di que no se mencionó en la clase.

APUNTES DE LA CLASE:
${context}

PREGUNTA DEL ALUMNO:
${question}`;

        const response = await ai.models.generateContent({
            model: 'gemini-flash-latest',
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }]
        });

        res.json({ answer: response.text });

    } catch (error) {
        console.error('Error en el chat:', error);
        res.status(500).json({ error: 'Ocurrió un error al responder la pregunta.' });
    }
};


exports.uploadChunk = async (req, res) => {
    try {
        const { sessionId, chunkIndex } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No se recibió el fragmento.' });

        const uploadsDir = path.join(__dirname, '../../uploads/');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

        const tempPath = path.join(uploadsDir, `temp_${sessionId}.webm`);
        
        // Append usando streams para cumplir con "Cero RAM"
        const writeStream = fs.createWriteStream(tempPath, { flags: 'a' });
        const readStream = fs.createReadStream(req.file.path);
        
        await new Promise((resolve, reject) => {
            readStream.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        // Eliminar el archivo temporal del chunk que creó multer
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.json({ success: true, message: `Fragmento ${chunkIndex} guardado.` });
    } catch (error) {
        console.error('ERROR EN UPLOADCHUNK:', error);
        res.status(500).json({ 
            error: 'Error al procesar el fragmento de audio.',
            details: error.message 
        });
    }
};

exports.processChunks = async (req, res) => {
    try {
        const { sessionId, fileName, mimetype } = req.body;
        const uploadsDir = path.join(__dirname, '../../uploads/');
        const tempPath = path.join(uploadsDir, `temp_${sessionId}.webm`);
        
        if (!fs.existsSync(tempPath)) {
            console.error(`Sesión no encontrada: ${sessionId}`);
            return res.status(404).json({ error: 'No se encontraron fragmentos para esta sesión.' });
        }

        const stats = fs.statSync(tempPath);
        console.log(`Procesando audio reunido: ${tempPath} (${stats.size} bytes)`);

        // Simulamos el objeto req.file para reutilizar la lógica de processAudio
        req.file = {
            path: tempPath,
            size: stats.size,
            mimetype: mimetype || 'audio/webm',
            originalname: fileName || 'grabacion_larga.webm'
        };

        // Delegamos a processAudio
        return exports.processAudio(req, res);
    } catch (error) {
        console.error('ERROR EN PROCESSCHUNKS:', error);
        res.status(500).json({ error: 'Error al finalizar la subida fragmentada.' });
    }
};
