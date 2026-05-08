// Estado Global
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let currentClass = null; 
let recordingInterval;
let recordingTime = 0;
let userToken = localStorage.getItem('token');
let currentSessionId = null;
let chunkIndex = 0;
let isChunkedRecording = false;


// Elementos DOM
const viewAuth = document.getElementById('view-auth');
const viewList = document.getElementById('view-list');
const viewRecord = document.getElementById('view-record');
const viewDetail = document.getElementById('view-detail');
const mainNav = document.getElementById('main-nav');

// Navegación
document.getElementById('nav-home').addEventListener('click', () => switchView('list'));
document.getElementById('nav-record').addEventListener('click', () => switchView('record'));
document.getElementById('btn-back-record').addEventListener('click', () => switchView('list'));
document.getElementById('btn-back-detail').addEventListener('click', () => {
    document.getElementById('class-audio').pause();
    switchView('list');
});
document.getElementById('btn-back-tips').addEventListener('click', () => switchView('list'));
document.getElementById('nav-tips').addEventListener('click', () => switchView('tips'));

// Auth Links
document.getElementById('go-register').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('register-form').classList.remove('hidden');
});
document.getElementById('go-login').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('register-form').classList.add('hidden');
    document.getElementById('login-form').classList.remove('hidden');
});

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    fetchVersion();
    if (userToken) {
        showApp();
    } else {
        showAuth();
    }
});

async function fetchVersion() {
    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        document.querySelectorAll('.app-version').forEach(el => {
            el.textContent = data.version;
            console.log('Versión actualizada en UI:', data.version);
        });
    } catch (err) {
        console.error('Error fetching version:', err);
    }
}

// --- Lógica de Autenticación ---
async function handleAuth(type) {
    const user = document.getElementById(type === 'login' ? 'login-user' : 'reg-user').value.trim();
    const pass = document.getElementById(type === 'login' ? 'login-pass' : 'reg-pass').value.trim();

    if (!user || !pass) return showModal('Completa todos los campos');

    try {
        const response = await fetch(`/api/${type}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });

        // Debug: Verificar si la respuesta es JSON o HTML
        const contentType = response.headers.get("content-type");
        if (!response.ok) {
            const errorBody = await response.text();
            console.error('Error del servidor (Cuerpo):', errorBody);
            
            // Intentar extraer mensaje de error si es JSON, sino usar el texto
            try {
                const errorData = JSON.parse(errorBody);
                throw new Error(errorData.error || 'Error en la petición');
            } catch (e) {
                throw new Error(`Error ${response.status}: Servidor no devolvió JSON.`);
            }
        }

        const data = await response.json();
        
        if (type === 'login') {
            localStorage.setItem('token', data.token);
            userToken = data.token;
            showApp();
        } else {
            showModal('¡Cuenta creada! Ya puedes iniciar sesión');
            document.getElementById('go-login').click();
        }
    } catch (err) {
        showModal(err.message);
    }
}

document.getElementById('btn-login').addEventListener('click', () => handleAuth('login'));
document.getElementById('btn-register').addEventListener('click', () => handleAuth('register'));
document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('token');
    userToken = null;
    showAuth();
});

function showAuth() {
    switchView('auth');
    mainNav.classList.add('hidden');
}

function showApp() {
    mainNav.classList.remove('hidden');
    switchView('list');
}

// --- Lógica de Vistas ---
function switchView(viewName) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');
    
    // Actualizar nav active
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    if (viewName === 'list') {
        loadClasses();
        document.getElementById('nav-home').classList.add('active');
    }
    if (viewName === 'tips') {
        document.getElementById('nav-tips').classList.add('active');
    }
}

// --- API Helper ---
async function apiFetch(url, options = {}) {
    options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${userToken}`
    };
    const response = await fetch(url, options);
    if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('token');
        showAuth();
        throw new Error('Sesión expirada');
    }
    return response.json();
}

// --- Lógica de Base de Datos ---
async function loadClasses() {
    try {
        const classes = await apiFetch('/api/classes');
        const listEl = document.getElementById('classes-list');
        listEl.innerHTML = '';
        
        if (classes.length === 0) {
            listEl.innerHTML = '<p style="color: var(--text-muted); text-align:center; margin-top:2rem;">No tienes apuntes guardados aún.</p>';
            return;
        }

        classes.forEach(c => {
            const dateStr = new Date(c.fecha).toLocaleDateString('es-ES', { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
            const div = document.createElement('div');
            div.className = `class-item ${c.status || 'completado'}`;
            
            let statusBadge = '';
            if (c.status === 'procesando') statusBadge = '<span class="status-badge processing">⏳ Procesando...</span>';
            if (c.status === 'error') statusBadge = '<span class="status-badge error">❌ Error</span>';

            div.innerHTML = `
                <div class="class-info">
                    <h4>${c.titulo}</h4>
                    <div class="class-meta">
                        <span>${dateStr}</span>
                        ${statusBadge}
                    </div>
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
        const clase = await apiFetch(`/api/classes/${id}`);
        currentClass = clase;

        if (clase.status === 'procesando') {
            document.getElementById('detail-title').textContent = "Procesando audio...";
            document.getElementById('content-summary').innerHTML = `
                <div class="loading-container">
                    <div class="spinner"></div>
                    <p>Gemini está analizando la clase. Esto puede tardar unos minutos para audios largos.</p>
                    <p style="font-size: 0.8rem; color: var(--text-muted);">No hace falta que te quedes en esta pantalla, te avisaremos cuando termine.</p>
                </div>`;
            document.getElementById('content-transcription').innerHTML = "";
            document.getElementById('btn-export-word').classList.add('hidden');
            document.getElementById('btn-render-map').classList.add('hidden');
            document.getElementById('detail-chat-input').disabled = true;
            
            // Reintentar cargar después de 10 segundos si estamos viendo esta nota
            setTimeout(() => {
                if (currentClass && currentClass.id === id && viewDetail.classList.contains('active')) {
                    openClassDetail(id);
                }
            }, 10000);

            switchView('detail');
            return;
        }

        if (clase.status === 'error') {
            document.getElementById('detail-title').textContent = "Error de Procesamiento";
            document.getElementById('content-summary').innerHTML = `<p style="color: #ef4444;">Error: ${clase.error_message || 'Desconocido'}</p>`;
            switchView('detail');
            return;
        }

        document.getElementById('detail-title').textContent = clase.titulo;
        document.getElementById('content-summary').innerHTML = marked.parse(clase.resumen || '');
        document.getElementById('content-transcription').innerHTML = `<p>${(clase.transcripcion || '').replace(/\n/g, '<br>')}</p>`;
        document.getElementById('btn-export-word').classList.remove('hidden');
        document.getElementById('detail-chat-input').disabled = false;
        
        const mapDiv = document.getElementById('content-mindmap');
        let mapText = clase.mapa_mental || 'graph TD\\nA[No se generó mapa]';
        mapText = mapText.replace(/["']/g, '');
        mapDiv.textContent = mapText;
        mapDiv.removeAttribute('data-processed');
        
        const audioEl = document.getElementById('class-audio');
        audioEl.src = clase.audioUrl; 
        
        document.getElementById('detail-chat-history').innerHTML = '<div class="chat-msg bot">¡Hola! Soy Gemini. ¿Qué quieres saber sobre esta clase?</div>';
        document.getElementById('btn-render-map').classList.remove('hidden');
        
        switchView('detail');
        document.querySelector('.tab-btn[data-target="tab-summary"]').click();
        
    } catch (error) {
        console.error('Error al cargar la clase:', error);
    }
}

// Borrar Clase
document.getElementById('btn-delete-class').addEventListener('click', async () => {
    if (!currentClass) return;
    if (!confirm('¿Estás seguro de que quieres eliminar este apunte?')) return;

    try {
        await apiFetch(`/api/classes/${currentClass.id}`, { method: 'DELETE' });
        showModal('Apunte eliminado');
        switchView('list');
    } catch (err) {
        showModal('Error al eliminar');
    }
});

// --- Lógica de Grabación ---
const btnStartRecord = document.getElementById('btn-start-record');
const btnStopRecord = document.getElementById('btn-stop-record');
const recordStatus = document.getElementById('record-status');
const recordTimer = document.getElementById('record-timer');
const recordLoading = document.getElementById('record-loading');

async function setupAudio() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Optimización: Usar un bitrate bajo (32kbps es excelente para voz) 
        // Esto reduce el peso del archivo casi 10 veces sin perder calidad para la IA.
        const options = {
            audioBitsPerSecond: 32000
        };

        // Intentar formatos más eficientes según el navegador (especialmente para móviles)
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            options.mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            options.mimeType = 'audio/mp4';
        }

        mediaRecorder = new MediaRecorder(stream, options);
        
        mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        mediaRecorder.onstop = async () => {
            const mimeType = mediaRecorder.mimeType || 'audio/webm';
            const audioBlob = new Blob(audioChunks, { type: mimeType });
            await uploadFile(audioBlob, 'clase_grabada.webm');
            
            // Reset
            audioChunks = [];
            currentSessionId = null;
        };
        return true;

    } catch (error) {
        showModal('Necesitas permisos de micrófono para grabar.');
        return false;
    }
}

btnStartRecord.addEventListener('click', async () => {
    if (!mediaRecorder) {
        const ok = await setupAudio();
        if (!ok) return;
    }
    if (mediaRecorder.state === 'inactive') {
        audioChunks = [];
        currentSessionId = null;
        
        // Cada 30 segundos se dispara ondataavailable
        mediaRecorder.start(30000); 
        
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
        btnStopRecord.classList.add('hidden');
        recordStatus.textContent = 'Procesando...';
        recordStatus.style.color = 'var(--text-muted)';
        recordLoading.classList.remove('hidden');
    }
});

async function uploadFile(file, fileName) {
    try {
        recordLoading.classList.remove('hidden');
        recordStatus.textContent = 'Obteniendo permiso de subida...';
        
        // 1. Obtener firma del backend
        const sigRes = await fetch('/api/cloudinary-signature', {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });
        if (!sigRes.ok) throw new Error('Error al obtener permisos de subida');
        const sigData = await sigRes.json();
        
        // 2. Subir directamente a Cloudinary saltándonos el servidor Render
        recordStatus.textContent = 'Subiendo archivo (0%)...';
        
        const cloudinaryFormData = new FormData();
        cloudinaryFormData.append('file', file, fileName || file.name);
        cloudinaryFormData.append('api_key', sigData.apiKey);
        cloudinaryFormData.append('timestamp', sigData.timestamp);
        cloudinaryFormData.append('signature', sigData.signature);
        cloudinaryFormData.append('folder', 'ia-notes');
        cloudinaryFormData.append('access_mode', 'public'); // Requerido por la nueva firma

        // Determinar el tipo de recurso para Cloudinary (video es para audio/video)
        let resourceType = 'raw';
        const fileType = (file.type || '').toLowerCase();
        if (fileType.startsWith('image/') || fileType.includes('pdf')) resourceType = 'image';
        else if (fileType.startsWith('audio/') || fileType.startsWith('video/')) resourceType = 'video';

        const uploadUrl = `https://api.cloudinary.com/v1_1/${sigData.cloudName}/${resourceType}/upload`;

        const cloudinaryData = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', uploadUrl, true);
            
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    recordStatus.textContent = `Subiendo archivo (${percent}%)...`;
                }
            };

            xhr.onload = () => {
                if (xhr.status === 200) {
                    resolve(JSON.parse(xhr.responseText));
                } else {
                    reject(new Error('Error en Cloudinary: ' + xhr.responseText));
                }
            };
            
            xhr.onerror = () => reject(new Error('Fallo de red al intentar subir el archivo a Cloudinary'));
            xhr.send(cloudinaryFormData);
        });

        // 3. Avisar al backend que ya está subido y empezar el proceso pesado de IA en background
        recordStatus.textContent = 'Iniciando análisis de IA...';
        
        const serverRes = await fetch('/api/process-url', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${userToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fileUrl: cloudinaryData.secure_url,
                publicId: cloudinaryData.public_id,
                resourceType: resourceType,
                mimetype: fileType || 'application/octet-stream',
                originalname: fileName || file.name || 'archivo'
            })
        });

        const nuevaClase = await serverRes.json();
        if (nuevaClase.error) throw new Error(nuevaClase.error);

        finalizeUploadUI(nuevaClase.id);
    } catch (error) {
        showModal('Error al procesar: ' + error.message);
        resetUploadUI();
    }
}

function finalizeUploadUI(id) {
    recordLoading.classList.add('hidden');
    btnStartRecord.classList.remove('hidden');
    document.getElementById('btn-trigger-file').classList.remove('hidden');
    recordStatus.textContent = 'Listo para grabar';
    openClassDetail(id);
}

function resetUploadUI() {
    recordLoading.classList.add('hidden');
    btnStartRecord.classList.remove('hidden');
    document.getElementById('btn-trigger-file').classList.remove('hidden');
}


// Eventos para Subida de Archivos
const fileInput = document.getElementById('file-input');
const btnTriggerFile = document.getElementById('btn-trigger-file');

btnTriggerFile.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 150 * 1024 * 1024) {
        return showModal('El archivo es demasiado grande (máx 150MB)');
    }

    btnStartRecord.classList.add('hidden');
    btnTriggerFile.classList.add('hidden');
    recordStatus.textContent = 'Preparando subida...';
    
    await uploadFile(file);
    fileInput.value = ''; // Limpiar
});

// --- Pestañas y Mapa ---
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.getAttribute('data-target')).classList.add('active');
    });
});

document.getElementById('btn-render-map').addEventListener('click', async () => {
    const mapDiv = document.getElementById('content-mindmap');
    try {
        await window.mermaid.run({ nodes: [mapDiv] });
        document.getElementById('btn-render-map').classList.add('hidden');
    } catch (e) {
        showModal("Error al renderizar el mapa mental.");
    }
});

// --- Chat IA ---
const detailBtnSend = document.getElementById('detail-btn-send');
const detailChatInput = document.getElementById('detail-chat-input');
const detailChatHistory = document.getElementById('detail-chat-history');

detailBtnSend.addEventListener('click', sendDetailMessage);
detailChatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendDetailMessage(); });

async function sendDetailMessage() {
    const text = detailChatInput.value.trim();
    if (!text || !currentClass) return;

    appendMsg(text, 'user');
    detailChatInput.value = '';

    try {
        const data = await apiFetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: text, context: currentClass.resumen })
        });
        if (data.answer) appendMsg(marked.parseInline(data.answer), 'bot', true);
        else appendMsg('Error al responder.', 'bot');
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

// Modal Custom
function showModal(text) {
    document.getElementById('modal-text').textContent = text;
    document.getElementById('app-modal').classList.remove('hidden');
}
document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('app-modal').classList.add('hidden');
});

// Exportar Word
document.getElementById('btn-export-word').addEventListener('click', () => {
    if (!currentClass) return;
    const summaryHTML = document.getElementById('content-summary').innerHTML;
    const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'></head><body>";
    const footer = "</body></html>";
    const sourceHTML = header + `<h1>${currentClass.titulo}</h1>` + summaryHTML + footer;
    const blob = new Blob(['\\ufeff', sourceHTML], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Apuntes - ${currentClass.titulo}.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
});
 
