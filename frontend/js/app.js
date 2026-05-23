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
const viewError = document.getElementById('view-error');
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
document.getElementById('btn-error-back').addEventListener('click', () => switchView('list'));

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
        });
    } catch (err) {
        console.error('Error fetching version:', err);
    }
}

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

        if (!response.ok) {
            const errorBody = await response.text();
            try {
                const errorData = JSON.parse(errorBody);
                throw new Error(errorData.error || 'Error en la petición');
            } catch {
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

function showErrorView(message) {
    document.getElementById('error-message-text').textContent = message || 'Ha ocurrido un error inesperado.';
    mainNav.classList.add('hidden');
    switchView('error');
}

function switchView(viewName) {
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

    if (viewName === 'error') {
        return;
    }

    if (viewName !== 'auth' && userToken) {
        mainNav.classList.remove('hidden');
    }

    if (viewName === 'list') {
        loadClasses();
        document.getElementById('nav-home').classList.add('active');
    }
    if (viewName === 'tips') {
        document.getElementById('nav-tips').classList.add('active');
    }
}

async function apiFetch(url, options = {}) {
    options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${userToken}`
    };
    let response;
    try {
        response = await fetch(url, options);
    } catch {
        showErrorView('No se pudo conectar con el servidor. Verifica tu conexión e intenta de nuevo.');
        throw new Error('Error de red');
    }

    if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('token');
        showAuth();
        throw new Error('Sesión expirada');
    }

    if (!response.ok && response.status >= 500) {
        const errText = await response.text().catch(() => '');
        showErrorView(errText || `Error del servidor (${response.status})`);
        throw new Error('Error del servidor');
    }

    return response.json();
}

async function loadClasses() {
    try {
        const classes = await apiFetch('/api/classes');
        const listEl = document.getElementById('classes-list');
        listEl.innerHTML = '';

        if (classes.length === 0) {
            listEl.innerHTML = '<p class="empty-state">No tienes apuntes guardados aún.</p>';
            return;
        }

        classes.forEach(c => {
            const dateStr = new Date(c.fecha).toLocaleDateString('es-ES', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
        if (error.message !== 'Error de red' && error.message !== 'Error del servidor') {
            console.error('Error al cargar clases:', error);
        }
    }
}

function resetDetailTabs() {
    document.getElementById('content-summary').innerHTML = '';
    document.getElementById('content-deep-learning').innerHTML = '';
    document.getElementById('content-transcription').innerHTML = '';
    document.getElementById('btn-export-word').classList.add('hidden');
    document.getElementById('btn-render-map').classList.add('hidden');
    document.getElementById('detail-chat-input').disabled = true;
}

async function openClassDetail(id) {
    try {
        const clase = await apiFetch(`/api/classes/${id}`);
        currentClass = clase;
        resetDetailTabs();

        if (clase.status === 'error') {
            showErrorView(clase.error_message || 'Error desconocido al procesar este apunte.');
            return;
        }

        if (clase.status === 'procesando') {
            document.getElementById('detail-title').textContent = 'Procesando contenido...';
            document.getElementById('content-summary').innerHTML = `
                <div class="loading-container">
                    <div class="spinner"></div>
                    <p>Gemini está analizando el material. Esto puede tardar unos minutos.</p>
                    <p class="loading-hint">No hace falta que te quedes en esta pantalla; puedes volver más tarde.</p>
                </div>`;
            document.getElementById('detail-chat-input').disabled = true;

            setTimeout(() => {
                if (currentClass && currentClass.id === id && viewDetail.classList.contains('active')) {
                    openClassDetail(id);
                }
            }, 10000);

            switchView('detail');
            return;
        }

        document.getElementById('detail-title').textContent = clase.titulo;
        document.getElementById('content-summary').innerHTML = marked.parse(clase.resumen || '');
        document.getElementById('content-deep-learning').innerHTML = clase.aprendizaje_profundo
            ? marked.parse(clase.aprendizaje_profundo)
            : '<p class="empty-state">El aprendizaje profundo aún no está disponible para este apunte.</p>';
        document.getElementById('content-transcription').innerHTML = `<p>${(clase.transcripcion || '').replace(/\n/g, '<br>')}</p>`;
        document.getElementById('btn-export-word').classList.remove('hidden');
        document.getElementById('detail-chat-input').disabled = false;

        const mapDiv = document.getElementById('content-mindmap');
        let mapText = clase.mapa_mental || 'graph TD\nA[No se generó mapa]';
        mapText = mapText.replace(/["']/g, '');
        mapDiv.textContent = mapText;
        mapDiv.removeAttribute('data-processed');

        const audioEl = document.getElementById('class-audio');
        audioEl.src = clase.audioUrl || '';

        document.getElementById('detail-chat-history').innerHTML = '<div class="chat-msg bot">¡Hola! Soy Gemini. ¿Qué quieres saber sobre esta clase?</div>';
        document.getElementById('btn-render-map').classList.remove('hidden');

        switchView('detail');
        document.querySelector('.tab-btn[data-target="tab-summary"]').click();

    } catch (error) {
        if (error.message !== 'Error de red' && error.message !== 'Error del servidor' && error.message !== 'Sesión expirada') {
            showErrorView('No se pudo cargar el apunte. Intenta de nuevo.');
        }
    }
}

document.getElementById('btn-delete-class').addEventListener('click', async () => {
    if (!currentClass) return;
    if (!confirm('¿Estás seguro de que quieres eliminar este apunte?')) return;

    try {
        await apiFetch(`/api/classes/${currentClass.id}`, { method: 'DELETE' });
        showModal('Apunte eliminado');
        switchView('list');
    } catch {
        showModal('Error al eliminar');
    }
});

const btnStartRecord = document.getElementById('btn-start-record');
const btnStopRecord = document.getElementById('btn-stop-record');
const recordStatus = document.getElementById('record-status');
const recordTimer = document.getElementById('record-timer');
const recordLoading = document.getElementById('record-loading');

async function setupAudio() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const options = { audioBitsPerSecond: 32000 };

        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            options.mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            options.mimeType = 'audio/mp4';
        }

        mediaRecorder = new MediaRecorder(stream, options);

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };
        mediaRecorder.onstop = async () => {
            const mimeType = mediaRecorder.mimeType || 'audio/webm';
            const audioBlob = new Blob(audioChunks, { type: mimeType });
            await uploadFile(audioBlob, 'clase_grabada.webm');
            audioChunks = [];
        };
        return true;
    } catch {
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
        mediaRecorder.start(30000);
        isRecording = true;
        btnStartRecord.classList.add('hidden');
        btnStopRecord.classList.remove('hidden');
        recordStatus.textContent = 'Grabando...';
        recordStatus.style.color = '#f87171';
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
        recordStatus.textContent = 'Subiendo archivo al servidor...';

        const formData = new FormData();
        formData.append('audio', file, fileName || file.name);

        const xhr = new XMLHttpRequest();
        const result = await new Promise((resolve, reject) => {
            xhr.open('POST', '/api/upload-audio');
            xhr.setRequestHeader('Authorization', `Bearer ${userToken}`);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    recordStatus.textContent = `Subiendo archivo (${percent}%)...`;
                }
            };

            xhr.onload = () => {
                if (xhr.status === 401 || xhr.status === 403) {
                    localStorage.removeItem('token');
                    showAuth();
                    reject(new Error('Sesión expirada'));
                    return;
                }
                if (xhr.status >= 500) {
                    showErrorView('El servidor no pudo procesar el archivo. Intenta más tarde.');
                    reject(new Error('Error del servidor'));
                    return;
                }
                if (xhr.status !== 200) {
                    try {
                        const err = JSON.parse(xhr.responseText);
                        reject(new Error(err.error || 'Error al subir'));
                    } catch {
                        reject(new Error('Error al subir el archivo'));
                    }
                    return;
                }
                resolve(JSON.parse(xhr.responseText));
            };

            xhr.onerror = () => {
                showErrorView('No se pudo conectar con el servidor. Verifica tu conexión.');
                reject(new Error('Error de red'));
            };

            xhr.send(formData);
        });

        recordStatus.textContent = 'Iniciando análisis de IA...';
        finalizeUploadUI(result.id);
    } catch (error) {
        if (error.message !== 'Error de red' && error.message !== 'Error del servidor' && error.message !== 'Sesión expirada') {
            showModal('Error al procesar: ' + error.message);
        }
        resetUploadUI();
    }
}

function finalizeUploadUI(id) {
    recordLoading.classList.add('hidden');
    btnStartRecord.classList.remove('hidden');
    document.getElementById('btn-trigger-file').classList.remove('hidden');
    recordStatus.textContent = 'Listo para grabar';
    recordStatus.style.color = 'var(--text-muted)';
    openClassDetail(id);
}

function resetUploadUI() {
    recordLoading.classList.add('hidden');
    btnStartRecord.classList.remove('hidden');
    document.getElementById('btn-trigger-file').classList.remove('hidden');
    recordStatus.textContent = 'Listo para grabar';
    recordStatus.style.color = 'var(--text-muted)';
}

const fileInput = document.getElementById('file-input');
const btnTriggerFile = document.getElementById('btn-trigger-file');

btnTriggerFile.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 150 * 1024 * 1024) {
        return showModal('El archivo es demasiado grande (máx 150MB)');
    }

    const isVideo = file.type.startsWith('video/');
    if (isVideo) {
        return showModal('Los archivos de video no están soportados. Sube un audio (MP3, M4A) o un documento.');
    }

    btnStartRecord.classList.add('hidden');
    btnTriggerFile.classList.add('hidden');
    recordStatus.textContent = 'Preparando subida...';

    await uploadFile(file, file.name);
    fileInput.value = '';
});

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
    } catch {
        showModal('Error al renderizar el mapa mental.');
    }
});

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
        const context = [currentClass.resumen, currentClass.aprendizaje_profundo].filter(Boolean).join('\n\n');
        const data = await apiFetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: text, context })
        });
        if (data.answer) appendMsg(marked.parseInline(data.answer), 'bot', true);
        else appendMsg('Error al responder.', 'bot');
    } catch {
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

function showModal(text) {
    document.getElementById('modal-text').textContent = text;
    document.getElementById('app-modal').classList.remove('hidden');
}
document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('app-modal').classList.add('hidden');
});

document.getElementById('btn-export-word').addEventListener('click', () => {
    if (!currentClass) return;
    const summaryHTML = document.getElementById('content-summary').innerHTML;
    const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'></head><body>";
    const footer = '</body></html>';
    const sourceHTML = header + `<h1>${currentClass.titulo}</h1>` + summaryHTML + footer;
    const blob = new Blob(['\ufeff', sourceHTML], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Apuntes - ${currentClass.titulo}.doc`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
});
