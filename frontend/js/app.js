// Estado Global
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let currentClass = null; // Guardará el objeto de la clase actual
let recordingInterval;
let recordingTime = 0;

// Elementos DOM
const viewList = document.getElementById('view-list');
const viewRecord = document.getElementById('view-record');
const viewDetail = document.getElementById('view-detail');

// Navegación
document.getElementById('nav-home').addEventListener('click', () => switchView('list'));
document.getElementById('nav-record').addEventListener('click', () => switchView('record'));
document.getElementById('btn-back-record').addEventListener('click', () => switchView('list'));
document.getElementById('btn-back-detail').addEventListener('click', () => {
    document.getElementById('class-audio').pause();
    switchView('list');
});

// Botones de Grabación
const btnStartRecord = document.getElementById('btn-start-record');
const btnStopRecord = document.getElementById('btn-stop-record');
const recordStatus = document.getElementById('record-status');
const recordTimer = document.getElementById('record-timer');
const recordLoading = document.getElementById('record-loading');

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    loadClasses();
});

// --- Lógica de Vistas ---
function switchView(viewName) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    
    if (viewName === 'list') {
        viewList.classList.add('active');
        loadClasses();
    } else if (viewName === 'record') {
        viewRecord.classList.add('active');
    } else if (viewName === 'detail') {
        viewDetail.classList.add('active');
    }
}

// --- Lógica de Base de Datos (API) ---
async function loadClasses() {
    try {
        const response = await fetch('/api/classes');
        const classes = await response.json();
        
        const listEl = document.getElementById('classes-list');
        listEl.innerHTML = '';
        
        if (classes.length === 0) {
            listEl.innerHTML = '<p style="color: var(--text-muted); text-align:center;">No tienes apuntes guardados aún.</p>';
            return;
        }

        classes.forEach(c => {
            const dateStr = new Date(c.fecha).toLocaleDateString('es-ES', { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
            
            const div = document.createElement('div');
            div.className = 'class-item';
            div.innerHTML = `
                <div class="class-info">
                    <h4>${c.titulo}</h4>
                    <span class="class-meta">${dateStr}</span>
                </div>
                <div class="class-icon">📝</div>
            `;
            div.addEventListener('click', () => openClassDetail(c.id));
            listEl.appendChild(div);
        });
    } catch (error) {
        console.error('Error al cargar clases:', error);
    }
}

async function openClassDetail(id) {
    try {
        const response = await fetch(`/api/classes/${id}`);
        const clase = await response.json();
        
        currentClass = clase;
        document.getElementById('detail-title').textContent = clase.titulo;
        
        // Cargar contenidos
        document.getElementById('content-summary').innerHTML = marked.parse(clase.resumen || '');
        document.getElementById('content-transcription').innerHTML = `<p>${(clase.transcripcion || '').replace(/\n/g, '<br>')}</p>`;
        
        // Preparar mapa mental (pero no renderizar aún para ahorrar recursos)
        const mapDiv = document.getElementById('content-mindmap');
        let mapText = clase.mapa_mental || 'graph TD\\nA[No se generó mapa]';
        // Sanitizar el código de Mermaid quitando comillas que suelen romper la sintaxis
        mapText = mapText.replace(/["']/g, '');
        mapDiv.textContent = mapText;
        mapDiv.removeAttribute('data-processed');
        
        // Cargar Audio
        const audioEl = document.getElementById('class-audio');
        // Si el audioUrl ya es una URL completa (Cloudinary), la usamos directamente.
        // Si es una ruta relativa (audios viejos), le ponemos el slash.
        if (clase.audioUrl.startsWith('http')) {
            audioEl.src = clase.audioUrl;
        } else {
            audioEl.src = '/' + clase.audioUrl;
        }
        
        // Limpiar chat
        document.getElementById('detail-chat-history').innerHTML = '<div class="chat-msg bot">¡Hola! Soy Gemini. ¿Qué quieres saber sobre esta clase?</div>';
        
        switchView('detail');
        // Activar tab de resumen por defecto
        document.querySelector('.tab-btn[data-target="tab-summary"]').click();
        
    } catch (error) {
        console.error('Error al cargar la clase:', error);
        alert('Error al abrir la clase');
    }
}

// --- Lógica de Grabación ---
async function setupAudio() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            audioChunks = [];
            await uploadAudio(audioBlob);
        };
        return true;
    } catch (error) {
        console.error('Error al acceder al micrófono:', error);
        alert('Necesitas permisos de micrófono para grabar.');
        return false;
    }
}

btnStartRecord.addEventListener('click', async () => {
    if (!mediaRecorder) {
        const ok = await setupAudio();
        if (!ok) return;
    }
    
    if (mediaRecorder.state === 'inactive') {
        mediaRecorder.start();
        isRecording = true;
        btnStartRecord.classList.add('hidden');
        btnStopRecord.classList.remove('hidden');
        recordStatus.textContent = 'Grabando...';
        recordStatus.style.color = '#ef4444';
        
        recordingTime = 0;
        recordTimer.textContent = '00:00';
        recordingInterval = setInterval(() => {
            recordingTime++;
            const m = String(Math.floor(recordingTime / 60)).padStart(2, '0');
            const s = String(recordingTime % 60).padStart(2, '0');
            recordTimer.textContent = `${m}:${s}`;
        }, 1000);
    }
});

btnStopRecord.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        isRecording = false;
        clearInterval(recordingInterval);
        
        btnStartRecord.classList.add('hidden');
        btnStopRecord.classList.add('hidden');
        recordStatus.textContent = 'Procesando...';
        recordStatus.style.color = 'var(--text-muted)';
        recordLoading.classList.remove('hidden');
    }
});

async function uploadAudio(audioBlob) {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'clase.webm');

    try {
        const response = await fetch('/api/upload-audio', {
            method: 'POST',
            body: formData
        });

        const nuevaClase = await response.json();
        
        if (nuevaClase.error) throw new Error(nuevaClase.error);

        // Terminado
        recordLoading.classList.add('hidden');
        btnStartRecord.classList.remove('hidden');
        recordStatus.textContent = 'Listo para grabar';
        recordTimer.textContent = '00:00';
        
        // Abrir la clase recién grabada
        openClassDetail(nuevaClase.id);
        
    } catch (error) {
        console.error('Error:', error);
        alert('Ocurrió un error al subir el audio.');
        recordLoading.classList.add('hidden');
        btnStartRecord.classList.remove('hidden');
        recordStatus.textContent = 'Error al grabar. Intenta de nuevo.';
    }
}

// --- Lógica de Pestañas ---
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        
        btn.classList.add('active');
        document.getElementById(btn.getAttribute('data-target')).classList.add('active');
    });
});

// Renderizar Mapa
document.getElementById('btn-render-map').addEventListener('click', async () => {
    const mapDiv = document.getElementById('content-mindmap');
    try {
        await window.mermaid.run({
            nodes: [mapDiv]
        });
        document.getElementById('btn-render-map').classList.add('hidden');
    } catch (e) {
        console.error("Mermaid error:", e);
        alert("El mapa generado por la IA no tiene un formato válido para renderizarse.");
    }
});


// --- Lógica de Chat IA ---
const detailBtnSend = document.getElementById('detail-btn-send');
const detailChatInput = document.getElementById('detail-chat-input');
const detailChatHistory = document.getElementById('detail-chat-history');

detailBtnSend.addEventListener('click', sendDetailMessage);
detailChatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendDetailMessage();
});

async function sendDetailMessage() {
    const text = detailChatInput.value.trim();
    if (!text || !currentClass) return;

    appendMsg(text, 'user');
    detailChatInput.value = '';

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: text,
                context: currentClass.resumen // Enviamos el resumen como contexto
            })
        });

        const data = await response.json();
        if (data.answer) {
            appendMsg(marked.parseInline(data.answer), 'bot', true);
        } else {
            appendMsg('Error al responder.', 'bot');
        }
    } catch (error) {
        appendMsg('Error de conexión.', 'bot');
    }
}

function appendMsg(text, sender, isHtml = false) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-msg ${sender}`;
    if (isHtml) msgDiv.innerHTML = text;
    else msgDiv.textContent = text;
    detailChatHistory.appendChild(msgDiv);
    detailChatHistory.scrollTop = detailChatHistory.scrollHeight;
}

// --- Exportar a Word ---
document.getElementById('btn-export-word').addEventListener('click', () => {
    if (!currentClass) return;
    
    // Obtener el HTML del resumen
    const summaryHTML = document.getElementById('content-summary').innerHTML;
    
    // Crear un documento HTML compatible con MS Word
    const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' "+
            "xmlns:w='urn:schemas-microsoft-com:office:word' "+
            "xmlns='http://www.w3.org/TR/REC-html40'>"+
            "<head><meta charset='utf-8'><title>Export HTML to Word</title></head><body>";
    const footer = "</body></html>";
    const sourceHTML = header + `<h1>${currentClass.titulo}</h1>` + summaryHTML + footer;
    
    // Crear el Blob
    const blob = new Blob(['\\ufeff', sourceHTML], {
        type: 'application/msword'
    });
    
    // Crear link de descarga
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Apuntes - ${currentClass.titulo}.doc`;
    
    document.body.appendChild(link);
    link.click();
    
    // Limpiar
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
});
 
