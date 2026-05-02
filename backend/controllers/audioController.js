const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { client } = require('../database');
const cloudinary = require('cloudinary').v2;

const ai = new GoogleGenAI(process.env.GEMINI_API_KEY || '');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const getCloudinaryResourceType = (mimetype) => {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('audio/') || mimetype.startsWith('video/')) return 'video';
    return 'raw';
};

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

        // 1. Subir a Cloudinary para almacenamiento permanente
        console.log('Iniciando subida a Cloudinary...');
        let cloudinaryResult;
        const resourceType = getCloudinaryResourceType(req.file.mimetype);
        
        try {
            cloudinaryResult = await cloudinary.uploader.upload(tempFilePath, {
                resource_type: resourceType,
                folder: 'ia-notes'
            });
        } catch (cloudErr) {
            console.error('Error subiendo a Cloudinary:', cloudErr);
            return res.status(500).json({ error: 'Error al guardar el archivo en la nube.' });
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

        // 3. Iniciar procesamiento pesado en "segundo plano" (sin await para el res)
        // Usamos una función autoejecutada para que los errores no afecten al hilo principal
        (async () => {
            try {
                console.log(`[${audioId}] Iniciando proceso Gemini en background...`);
                
                // Subir a Gemini
                const uploadResult = await ai.files.upload({
                    file: tempFilePath,
                    config: { mimeType: req.file.mimetype }
                });

                // Esperar procesamiento
                let file = await ai.files.get({ name: uploadResult.name });
                let retryCount = 0;
                while (file.state === 'PROCESSING' && retryCount < 40) {
                    await new Promise(r => setTimeout(r, 2000));
                    file = await ai.files.get({ name: uploadResult.name });
                    retryCount++;
                }

                if (file.state !== 'ACTIVE') throw new Error('Gemini falló: ' + file.state);

                // Generar Contenido adaptado al tipo de archivo
                const prompt = `Eres un asistente de estudio experto y analista de contenido multimedial.
                Analiza el archivo proporcionado (puede ser audio de clase, video, documento PDF/Word, imagen de apuntes o código fuente).
                
                Tu tarea es extraer el conocimiento más importante y estructurarlo para un estudiante.
                Si es un audio/video: Transcribe y resume los puntos clave.
                Si es un documento: Resume el contenido y destaca conceptos importantes.
                Si es una imagen: Realiza OCR si hay texto y describe lo que se ve (ej. pizarrones, diagramas).
                Si es código: Explica qué hace el código, su lógica y puntos clave.

                Responde ESTRICTAMENTE en formato JSON con la siguiente estructura:
                {
                  "titulo": "Un título descriptivo y corto",
                  "resumen": "Contenido educativo detallado en formato Markdown (usa negritas, listas y encabezados)",
                  "transcripcion": "Texto extraído o transcripción completa del contenido",
                  "mapa_mental": "Un esquema de conceptos usando sintaxis simple de Mermaid.js (ej: graph TD\\nA-->B)"
                }`;

                const response = await ai.models.generateContent({
                    model: 'gemini-1.5-flash', // Usamos la versión más reciente y capaz
                    config: { responseMimeType: "application/json" },
                    contents: [{
                        role: 'user',
                        parts: [
                            { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
                            { text: prompt }
                        ]
                    }]
                });

                let cleanedText = response.text.trim();
                // Eliminar posibles bloques de código markdown que Gemini a veces añade a pesar de pedirle JSON
                if (cleanedText.startsWith('```')) {
                    cleanedText = cleanedText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
                }
                
                let aiData;
                try {
                    aiData = JSON.parse(cleanedText);
                } catch (parseError) {
                    console.error("Error en primer intento de parseo:", parseError);
                    // Segundo intento: limpiar caracteres de control invisibles
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
                console.error(`[${audioId}] ERROR EN BACKGROUND:`, bgError);
                await client.execute({
                    sql: "UPDATE classes SET status = 'error', error_message = ? WHERE id = ?",
                    args: [bgError.message, audioId]
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

