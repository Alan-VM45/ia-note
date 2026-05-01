// Estado Global
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let currentClass = null; 
let recordingInterval;
let recordingTime = 0;
let userToken = localStorage.getItem('token');

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
        const data = await response.json();

        if (data.error) throw new Error(data.error);

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
    
    if (viewName === 'list') loadClasses();
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
        const clase = await apiFetch(`/api/classes/${id}`);
        currentClass = clase;
        document.getElementById('detail-title').textContent = clase.titulo;
        document.getElementById('content-summary').innerHTML = marked.parse(clase.resumen || '');
        document.getElementById('content-transcription').innerHTML = `<p>${(clase.transcripcion || '').replace(/\n/g, '<br>')}</p>`;
        
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
            headers: { 'Authorization': `Bearer ${userToken}` },
            body: formData
        });
        const nuevaClase = await response.json();
        if (nuevaClase.error) throw new Error(nuevaClase.error);

        recordLoading.classList.add('hidden');
        btnStartRecord.classList.remove('hidden');
        recordStatus.textContent = 'Listo para grabar';
        openClassDetail(nuevaClase.id);
    } catch (error) {
        showModal('Error al procesar el audio: ' + error.message);
        recordLoading.classList.add('hidden');
        btnStartRecord.classList.remove('hidden');
    }
}

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
 
