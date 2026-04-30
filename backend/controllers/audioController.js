const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { client } = require('../database');
const cloudinary = require('cloudinary').v2;

const ai = new GoogleGenAI(process.env.GEMINI_API_KEY || '');

// Configurar Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

exports.processAudio = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se subió ningún archivo de audio.' });
        }

        const tempFilePath = req.file.path;
        console.log('Audio recibido, procesando con Gemini...', tempFilePath);

        // 1. Subir a Cloudinary para almacenamiento permanente
        let cloudinaryResult;
        try {
            cloudinaryResult = await cloudinary.uploader.upload(tempFilePath, {
                resource_type: 'video', // para archivos de audio
                folder: 'ia-notes'
            });
        } catch (cloudErr) {
            console.error('Error subiendo a Cloudinary:', cloudErr);
            return res.status(500).json({ error: 'Error al guardar el audio en la nube.' });
        }

        const audioUrl = cloudinaryResult.secure_url;
        const audioId = Date.now().toString();

        // 2. Subir el archivo de audio a Gemini para procesamiento (usando el archivo temporal local)
        let uploadResult = await ai.files.upload({
            file: tempFilePath,
            config: {
                mimeType: req.file.mimetype,
            }
        });

        // Esperar a que Gemini procese el archivo (necesario para audios largos)
        let file = await ai.files.get(uploadResult.name);
        let retryCount = 0;
        while (file.state === 'PROCESSING' && retryCount < 20) {
            console.log('Gemini sigue procesando el archivo...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            file = await ai.files.get(uploadResult.name);
            retryCount++;
        }

        if (file.state !== 'ACTIVE') {
            throw new Error('El archivo de audio no pudo ser procesado por Gemini (Estado: ' + file.state + ')');
        }

        // 3. Pedir a Gemini estructura JSON
        const prompt = `Eres un asistente de estudio experto.
A continuación te paso el audio de una clase. 
Necesito que devuelvas la información ESTRICTAMENTE en formato JSON con la siguiente estructura exacta:
{
  "titulo": "Un título corto y descriptivo de la clase",
  "resumen": "Los apuntes principales en formato Markdown (usa títulos, viñetas, negritas para resaltar conceptos clave).",
  "transcripcion": "La transcripción completa de todo lo que se dijo en el audio, separado por párrafos.",
  "mapa_mental": "Código en sintaxis Mermaid.js (ej. graph TD\\n A[Texto]-->B(Texto)...). REGLAS CRÍTICAS PARA MERMAID: NO uses comillas (\"), ni apóstrofes ('), ni saltos de línea dentro de los textos de los nodos (corchetes/paréntesis). Mantén los textos de los nodos muy simples y cortos. NO envuelvas el código en bloques markdown."
}
IMPORTANTE: El resultado debe ser un JSON válido. NUNCA uses saltos de línea literales (Enter) dentro de los textos. Si necesitas un salto de línea, utiliza SIEMPRE el texto "\\n" (barra invertida y n). Asegúrate de escapar las comillas internas. No devuelvas NADA más que el objeto JSON válido.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            config: {
                responseMimeType: "application/json",
            },
            contents: [
                {
                    fileData: {
                        fileUri: uploadResult.uri,
                        mimeType: uploadResult.mimeType
                    }
                },
                prompt
            ]
        });

        let aiData;
        try {
            let cleanedText = response.text.trim();
            if (cleanedText.startsWith('```json')) cleanedText = cleanedText.substring(7);
            if (cleanedText.startsWith('```')) cleanedText = cleanedText.substring(3);
            if (cleanedText.endsWith('```')) cleanedText = cleanedText.substring(0, cleanedText.length - 3);
            cleanedText = cleanedText.trim();
            aiData = JSON.parse(cleanedText);
        } catch (e) {
            console.error("Error parseando la respuesta de Gemini:", response.text);
            // Si falla el parseo, intentamos limpiar caracteres de control
            try {
                let textFix = response.text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
                aiData = JSON.parse(textFix);
            } catch (e2) {
                return res.status(500).json({ error: 'La IA no devolvió un formato válido.' });
            }
        }

        // 4. Guardar en Turso (SQLite Cloud)
        try {
            await client.execute({
                sql: "INSERT INTO classes (id, fecha, titulo, resumen, transcripcion, mapa_mental, audioUrl, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                args: [
                    audioId,
                    new Date().toISOString(),
                    aiData.titulo,
                    aiData.resumen,
                    aiData.transcripcion,
                    aiData.mapa_mental,
                    audioUrl,
                    req.user.userId 
                ]
            });
        } catch (dbErr) {
            console.error('Error guardando en Turso:', dbErr);
            // Intentamos loguear más info
            console.error('ID de usuario:', req.user.userId);
            return res.status(500).json({ error: 'Error al guardar en la base de datos SQL.' });
        }

        // 5. Limpiar archivo temporal
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }

        res.json({
            id: audioId,
            fecha: new Date().toISOString(),
            audioUrl: audioUrl,
            ...aiData
        });

    } catch (error) {
        console.error('Error procesando el audio:', error);
        res.status(500).json({ error: 'Ocurrió un error al procesar el audio con IA.' });
    }
};

exports.getClasses = async (req, res) => {
    try {
        const rs = await client.execute({
            sql: "SELECT id, titulo, fecha FROM classes WHERE user_id = ? ORDER BY fecha DESC",
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
            model: 'gemini-2.5-flash',
            contents: prompt
        });

        res.json({ answer: response.text });

    } catch (error) {
        console.error('Error en el chat:', error);
        res.status(500).json({ error: 'Ocurrió un error al responder la pregunta.' });
    }
};

