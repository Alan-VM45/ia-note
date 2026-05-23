const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { client } = require('../database');
const cloudinary = require('cloudinary').v2;
const officeModule = require('office-text-extractor');
const officeTextExtractor = officeModule.officeTextExtractor || officeModule.default || officeModule;

const ai = new GoogleGenAI(process.env.GEMINI_API_KEY || '');

const ORIGINAL_SUMMARY_PROMPT = `
Eres un asistente educativo experto. Analiza el material proporcionado y genera:
- Un título descriptivo
- Un resumen conciso y estructurado (puntos clave, conceptos principales)
- La transcripción o extracción de texto completa
- Un mapa mental en sintaxis Mermaid.js

IMPORTANTE: Responde EXCLUSIVAMENTE en formato JSON con esta estructura:
{
  "titulo": "Título descriptivo del material",
  "resumen": "Resumen estructurado en Markdown (conciso, con puntos clave)",
  "transcripcion": "Transcripción o extracción de texto completa",
  "mapa_mental": "Esquema Mermaid.js (ej: graph TD\\nA-->B)"
}
`;

const STUDY_SYSTEM_PROMPT = `
ACTÚA COMO: Un Ingeniero en Conocimiento y Tutor de Aprendizaje de Alto Rendimiento.

TU MISIÓN: Realizar un análisis exhaustivo del material proporcionado. No quiero un resumen generalista. Quiero un Sistema de Estudio Integral que cubra el 100% de los temas mencionados en el material, sin omitir subtemas o detalles técnicos.

INSTRUCCIONES DE PROCESAMIENTO (Protocolo Antipereza):
1. Fidelidad Absoluta: Usa ÚNICAMENTE la información del material proporcionado. Si el material dice algo específico que contradice tu base de datos, prioriza el material.
2. Mapeo de Unidades: Divide el resumen siguiendo estrictamente el orden de las unidades o capítulos del archivo. Si la Unidad 1 tiene 5 subtemas, los 5 deben estar desarrollados en profundidad.
3. Técnica de Estudio Integrada (Active Recall): No solo resumas. Para cada concepto clave, genera:
   - Explicación Técnica: Profunda y con rigor académico.
   - Simplificación Feynman: Una analogía sencilla para entender la lógica detrás del dato.
   - Pregunta de Autoevaluación: Una pregunta que me obligue a recordar el concepto sin mirar el apunte.

ESTRUCTURA OBLIGATORIA POR TEMA:
[Nombre del Tema / Unidad]
- Metavisión del Concepto: ¿Por qué existe este tema y cómo se conecta con el anterior?
- Desarrollo Técnico Exhaustivo: (Aquí vuelcas toda la info del material: fórmulas, reglas, excepciones, pasos). Usa tablas para comparar si hay más de dos elementos.
- Análisis de "Giro de Rueda" (Casos de Borde): ¿En qué situaciones falla este concepto o qué error común cometen los estudiantes aquí según el material?
- Laboratorio Práctico: Si hay matemáticas o lógica, inventa un ejercicio basado exactamente en los ejemplos del material y resuélvelo paso a paso.

RESTRICCIÓN CRÍTICA: Si el material es muy largo, no intentes resumirlo todo en una sola respuesta si eso implica perder calidad. Si detectas que vas por la mitad del material y te estás quedando sin espacio, detente y dime: "Continuará en la siguiente parte", para que yo te pida seguir. No sacrifiques profundidad por brevedad.

Responde en Markdown bien estructurado (sin JSON). Usa encabezados, listas y tablas donde corresponda.
`;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const getCloudinaryResourceType = (mimetype) => {
    const mt = mimetype.toLowerCase();
    if (mt.startsWith('image/') || mt.includes('pdf')) return 'image';
    if (mt.startsWith('audio/')) return 'video';
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

const parseJsonResponse = (text) => {
    let cleanedText = text.trim();
    if (cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(cleanedText);
};

const callGeminiWithRetry = async (audioId, payload, retries = 3) => {
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

async function generateDeepLearning(audioId, transcription) {
    if (!transcription || transcription.trim().length < 50) {
        console.log(`[${audioId}] Transcripción muy corta, omitiendo aprendizaje profundo.`);
        return '';
    }

    console.log(`[${audioId}] Generando aprendizaje profundo...`);
    const CHUNK_SIZE = 15000;
    const chunks = [];
    for (let i = 0; i < transcription.length; i += CHUNK_SIZE) {
        chunks.push(transcription.substring(i, i + CHUNK_SIZE));
    }

    let deepContent = '';
    for (let i = 0; i < chunks.length; i++) {
        const chunkPrompt = `${STUDY_SYSTEM_PROMPT}

${i > 0 ? `Este es el FRAGMENTO ${i + 1} de ${chunks.length}. Continúa el análisis sin repetir introducciones generales.` : ''}

MATERIAL A ANALIZAR:
${chunks[i]}`;

        const aiResponse = await callGeminiWithRetry(audioId, {
            model: 'gemini-flash-latest',
            contents: [{ role: 'user', parts: [{ text: chunkPrompt }] }]
        });

        deepContent += (i > 0 ? '\n\n---\n\n' : '') + aiResponse.text.trim();

        if (chunks.length > 1) {
            await client.execute({
                sql: "UPDATE classes SET aprendizaje_profundo = ?, status = 'procesando' WHERE id = ?",
                args: [deepContent + `\n\n*(Generando aprendizaje profundo: parte ${i + 1} de ${chunks.length}...)*`, audioId]
            });
        }
    }

    return deepContent;
}

async function processWithGemini(audioId, tempFilePath, fileObj) {
    const mimetype = fileObj.mimetype.toLowerCase();
    const originalName = fileObj.originalname.toLowerCase();

    const isDocument = mimetype.includes('officedocument') ||
        mimetype.includes('ms-powerpoint') ||
        mimetype.includes('msword') ||
        mimetype.includes('application/pdf') ||
        mimetype.includes('text/plain') ||
        originalName.endsWith('.docx') ||
        originalName.endsWith('.pptx') ||
        originalName.endsWith('.ppt') ||
        originalName.endsWith('.doc') ||
        originalName.endsWith('.pdf') ||
        originalName.endsWith('.txt');

    let aiData = {
        titulo: originalName,
        resumen: '',
        transcripcion: '',
        mapa_mental: ''
    };

    try {
        if (isDocument) {
            console.log(`[${audioId}] Detectado documento, extrayendo texto...`);
            const extractedText = await officeTextExtractor(tempFilePath);

            const CHUNK_SIZE = 15000;
            const textChunks = [];
            for (let i = 0; i < extractedText.length; i += CHUNK_SIZE) {
                textChunks.push(extractedText.substring(i, i + CHUNK_SIZE));
            }

            console.log(`[${audioId}] Procesando ${textChunks.length} segmentos del documento...`);

            for (let i = 0; i < textChunks.length; i++) {
                const chunkPrompt = `Este es el FRAGMENTO ${i + 1} de ${textChunks.length} del material "${originalName}".
${ORIGINAL_SUMMARY_PROMPT}
${i > 0 ? 'IMPORTANTE: Fragmento de continuación. No repitas el título general, enfócate en este fragmento.' : ''}

CONTENIDO DEL FRAGMENTO:
${textChunks[i]}`;

                const aiResponse = await callGeminiWithRetry(audioId, {
                    model: 'gemini-flash-latest',
                    config: { responseMimeType: 'application/json' },
                    contents: [{ role: 'user', parts: [{ text: chunkPrompt }] }]
                });

                const partData = parseJsonResponse(aiResponse.text);

                if (i === 0) {
                    aiData.titulo = partData.titulo;
                    aiData.mapa_mental = partData.mapa_mental;
                }
                aiData.resumen += (i > 0 ? '\n\n---\n\n' : '') + partData.resumen;
                aiData.transcripcion += (i > 0 ? '\n\n' : '') + (partData.transcripcion || textChunks[i]);

                await client.execute({
                    sql: 'UPDATE classes SET resumen = ?, status = ? WHERE id = ?',
                    args: [aiData.resumen + `\n\n*(Procesando parte ${i + 1} de ${textChunks.length}...)*`, 'procesando', audioId]
                });
            }
        } else {
            console.log(`[${audioId}] Procesando audio con File API...`);
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

            const aiResponse = await callGeminiWithRetry(audioId, {
                model: 'gemini-flash-latest',
                config: { responseMimeType: 'application/json' },
                contents: [{
                    role: 'user',
                    parts: [
                        { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
                        { text: ORIGINAL_SUMMARY_PROMPT }
                    ]
                }]
            });

            const data = parseJsonResponse(aiResponse.text);
            aiData.titulo = data.titulo;
            aiData.resumen = data.resumen;
            aiData.transcripcion = data.transcripcion;
            aiData.mapa_mental = data.mapa_mental;
        }

        const aprendizajeProfundo = await generateDeepLearning(audioId, aiData.transcripcion);

        await client.execute({
            sql: 'UPDATE classes SET titulo = ?, resumen = ?, aprendizaje_profundo = ?, transcripcion = ?, mapa_mental = ?, status = ? WHERE id = ?',
            args: [aiData.titulo, aiData.resumen, aprendizajeProfundo, aiData.transcripcion, aiData.mapa_mental, 'completado', audioId]
        });
        console.log(`[${audioId}] Procesamiento completado con éxito.`);

    } catch (error) {
        console.error(`[${audioId}] Error en processWithGemini:`, error);
        throw error;
    }
}

exports.processAudio = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se subió ningún archivo.' });
        }

        const tempFilePath = req.file.path;
        console.log('Archivo recibido:', {
            path: tempFilePath,
            size: req.file.size,
            mimetype: req.file.mimetype
        });

        let cloudinaryResult;
        try {
            cloudinaryResult = await uploadToCloudinary(tempFilePath, req.file.mimetype);
        } catch (cloudErr) {
            console.error('Error crítico subiendo a Cloudinary:', cloudErr);
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            return res.status(500).json({
                error: 'Error al guardar el archivo en la nube.',
                details: cloudErr.message
            });
        }

        const audioUrl = cloudinaryResult.secure_url;
        console.log('Subida a Cloudinary exitosa:', audioUrl);

        const audioId = Date.now().toString();

        await client.execute({
            sql: 'INSERT INTO classes (id, fecha, titulo, status, audioUrl, user_id) VALUES (?, ?, ?, ?, ?, ?)',
            args: [
                audioId,
                new Date().toISOString(),
                'Procesando contenido...',
                'procesando',
                audioUrl,
                req.user.userId
            ]
        });

        res.json({
            id: audioId,
            status: 'procesando',
            message: 'Archivo recibido y en proceso de análisis.'
        });

        (async () => {
            try {
                console.log(`[${audioId}] Iniciando proceso Gemini en background...`);
                await processWithGemini(audioId, tempFilePath, req.file);
            } catch (bgError) {
                console.error(`[${audioId}] ERROR EN BACKGROUND:`, bgError);
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
        console.error('ERROR EN PROCESSAUDIO (INICIAL):', error);
        res.status(500).json({ error: 'Error al iniciar el procesamiento.' });
    }
};

exports.getClasses = async (req, res) => {
    try {
        const rs = await client.execute({
            sql: 'SELECT id, titulo, fecha, status FROM classes WHERE user_id = ? ORDER BY fecha DESC',
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
            sql: 'SELECT * FROM classes WHERE id = ? AND user_id = ?',
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
            sql: 'DELETE FROM classes WHERE id = ? AND user_id = ?',
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

        const writeStream = fs.createWriteStream(tempPath, { flags: 'a' });
        const readStream = fs.createReadStream(req.file.path);

        await new Promise((resolve, reject) => {
            readStream.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

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
            return res.status(404).json({ error: 'No se encontraron fragmentos para esta sesión.' });
        }

        const stats = fs.statSync(tempPath);
        req.file = {
            path: tempPath,
            size: stats.size,
            mimetype: mimetype || 'audio/webm',
            originalname: fileName || 'grabacion_larga.webm'
        };

        return exports.processAudio(req, res);
    } catch (error) {
        console.error('ERROR EN PROCESSCHUNKS:', error);
        res.status(500).json({ error: 'Error al finalizar la subida fragmentada.' });
    }
};
