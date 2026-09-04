// Конфигурация
const getServerURL = () => {
    const configuredUrl = window.PULSCORD_API_URL || localStorage.getItem('pulscord_api_url');
    if (configuredUrl) return configuredUrl.replace(/\/$/, '');
    if (window.Capacitor?.isNativePlatform?.()) return 'https://pulscord.onrender.com';
    return /^https?:$/.test(window.location.protocol) ? window.location.origin : 'http://localhost:3000';
};

const API_URL = getServerURL();

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
    const token = localStorage.getItem('pulscord_session_token');
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return nativeFetch(input, { ...init, headers });
};

const socket = io(API_URL);

// Состояние приложения
let appState = {
    currentUser: null,
    currentChannel: null,
    currentDMUser: null,
    channels: {},
    contacts: [],
    requests: [],
    onlineUsers: new Map(),
    messageCount: 0,
    voiceRoom: null,
    voiceStream: null,
    peerConnections: new Map(),
    pendingVoiceCandidates: new Map(),
    voiceParticipants: new Map(),
    voiceCallStartedAt: null,
    voiceCallTimer: null,
    voiceMuted: false,
    videoEnabled: false,
    cameraTrack: null,
    screenTrack: null,
    screenAudioTrack: null,
    screenSharing: false,
    remoteStreams: new Map(),
    incomingCall: null,
    mediaRecorder: null,
    mediaChunks: [],
    mediaRecordingType: null,
    mediaRecordingStartedAt: null,
    mediaRecordingTimer: null,
    pendingImage: null,
    pendingFile: null,
    replyTo: null
};

// ===== Инициализация =====
document.addEventListener('DOMContentLoaded', () => {
    setupAuthEvents();
    setupAppEvents();
    loadChannels();
    updateMessageInputState();
    setupSocket();
    updateTime();
    setInterval(updateTime, 1000);
    restoreSession();
});

// ===== АУТЕНТИФИКАЦИЯ =====
function setupAuthEvents() {
    // Переключение вкладок
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.getElementById(tab + '-tab').classList.add('active');
            btn.classList.add('active');
        });
    });

    // Вход
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        try {
            const response = await fetch(`${API_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (response.ok) {
                appState.currentUser = data.user;
                if (data.token) localStorage.setItem('pulscord_session_token', data.token);
                localStorage.setItem('currentUser', JSON.stringify(data.user));
                showApp();
            } else {
                showError('login-error', data.error);
            }
        } catch (error) {
            showError('login-error', 'Ошибка подключения к серверу');
            console.error(error);
        }
    });

    // Регистрация
    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('register-username').value;
        const password = document.getElementById('register-password').value;
        const password2 = document.getElementById('register-password2').value;

        if (password !== password2) {
            showError('register-error', 'Пароли не совпадают');
            return;
        }

        if (username.length < 3) {
            showError('register-error', 'Имя должно быть не менее 3 символов');
            return;
        }

        try {
            const response = await fetch(`${API_URL}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password, avatar: username[0].toUpperCase() })
            });

            const data = await response.json();

            if (response.ok) {
                appState.currentUser = data.user;
                if (data.token) localStorage.setItem('pulscord_session_token', data.token);
                localStorage.setItem('currentUser', JSON.stringify(data.user));
                showApp();
            } else {
                showError('register-error', data.error);
            }
        } catch (error) {
            showError('register-error', 'Ошибка подключения к серверу');
            console.error(error);
        }
    });
}

function showError(elementId, message) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.style.display = 'block';
    setTimeout(() => {
        element.style.display = 'none';
    }, 5000);
}

async function restoreSession() {
    try {
        const response = await fetch(`${API_URL}/api/auth/me`);
        if (!response.ok) return;
        const data = await response.json();
        appState.currentUser = data.user;
        localStorage.setItem('currentUser', JSON.stringify(data.user));
        showApp();
    } catch (error) {
        console.warn('Сессия не восстановлена:', error.message);
    }
}

function showApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
    updateCurrentUserUI();
    document.getElementById('money-count').textContent = `${appState.currentUser.money || 0} ★`;
    document.getElementById('admin-panel-btn').classList.toggle('hidden', appState.currentUser.username !== 'Deverlope');
    document.getElementById('content-panel-btn').classList.toggle('hidden', appState.currentUser.username !== 'Deverlope');
    
    socket.emit('user-join', appState.currentUser);
    loadContacts();
    loadRequests();
    loadStories();
    loadChannels().then(() => {
        if (!appState.currentDMUser && appState.currentChannel) loadMessages(appState.currentChannel);
    });
}

// ===== WebSocket =====
function setupSocket() {
    socket.on('connect', () => {
        console.log('✓ Подключено к серверу');
        showToast('Подключено к серверу ✓');
    });

    socket.on('message', (data) => {
        if (data.message?.author && data.message.author !== appState.currentUser?.username && (data.channel !== appState.currentChannel || appState.currentDMUser)) {
            showDesktopNotification(`#${data.channel}`, data.message.text || 'Новое сообщение', null);
        }
        if (data.channel === appState.currentChannel && !appState.currentDMUser) {
            loadMessages(appState.currentChannel);
        }
    });

    socket.on('message-edited', data => {
        if (data.channel === appState.currentChannel && !appState.currentDMUser) loadMessages(appState.currentChannel);
    });

    socket.on('message-deleted', data => {
        if (data.channel === appState.currentChannel && !appState.currentDMUser) loadMessages(appState.currentChannel);
    });

    socket.on('message-reaction', data => {
        if (data.channel === appState.currentChannel && !appState.currentDMUser) loadMessages(appState.currentChannel);
    });

    socket.on('direct-message', (data) => {
        if (!appState.currentUser) return;
        const otherUser = data.users.find(username => username !== appState.currentUser.username);
        if (data.message?.author !== appState.currentUser.username && (!appState.currentDMUser || appState.currentDMUser !== otherUser)) {
            showDesktopNotification(data.message?.author || otherUser, data.message?.text || 'Новое сообщение', otherUser);
        }
        if (!appState.currentDMUser) return;
        if (data.users.includes(appState.currentUser.username) && data.users.includes(appState.currentDMUser)) {
            loadDirectMessages(appState.currentDMUser);
        }
    });

    socket.on('voice-existing-users', users => {
        users.forEach(user => {
            appState.voiceParticipants.set(user.socketId, user.username);
            createVoiceOffer(user.socketId).catch(error => console.error('Ошибка подключения к участнику:', error));
        });
        updateVoiceCallUI();
    });
    socket.on('voice-join-ack', ({ room }) => {
        if (appState.voiceRoom === room) {
            document.getElementById('voice-call-status').textContent = 'Подключено';
            updateVoiceCallUI();
        }
    });
    socket.on('voice-user-joined', ({ socketId, username, room, video }) => {
        if (!appState.voiceRoom && !appState.incomingCall) {
            showIncomingCall({ socketId, username, room, video: Boolean(video) });
            return;
        }
        appState.voiceParticipants.set(socketId, username);
        updateVoiceCallUI();
    });
    socket.on('voice-incoming-call', call => showIncomingCall(call));
    socket.on('voice-call-unavailable', ({ username }) => {
        showToast(`${username || 'Собеседник'} сейчас не в сети`);
        if (appState.voiceRoom) leaveVoiceCall();
    });
    socket.on('voice-call-rejected', ({ username }) => showToast(`${username || 'Пользователь'} отклонил звонок`));
    socket.on('voice-user-left', ({ socketId }) => {
        appState.voiceParticipants.delete(socketId);
        closeVoicePeer(socketId);
        updateVoiceCallUI();
    });
    socket.on('voice-offer', async ({ from, offer }) => {
        try {
            const peer = await getVoicePeer(from);
            if (peer.signalingState !== 'stable') await peer.setLocalDescription({ type: 'rollback' });
            await peer.setRemoteDescription(offer);
            await flushVoiceIceCandidates(from, peer);
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            socket.emit('voice-answer', { target: from, answer });
        } catch (error) {
            console.error('Ошибка обработки предложения звонка:', error);
        }
    });
    socket.on('voice-answer', async ({ from, answer }) => {
        const peer = appState.peerConnections.get(from);
        if (peer) {
            await peer.setRemoteDescription(answer);
            await flushVoiceIceCandidates(from, peer);
        }
    });
    socket.on('voice-ice-candidate', async ({ from, candidate }) => {
        if (!candidate) return;
        const peer = appState.peerConnections.get(from);
        if (peer?.remoteDescription) {
            await peer.addIceCandidate(candidate);
        } else {
            const pending = appState.pendingVoiceCandidates.get(from) || [];
            pending.push(candidate);
            appState.pendingVoiceCandidates.set(from, pending);
        }
    });

    socket.on('friend-request', (data) => {
        if (appState.currentUser && data.to === appState.currentUser.username) {
            loadRequests();
            showToast(`Новая заявка от @${data.from}`);
        }
    });

    socket.on('contact-updated', (data) => {
        if (appState.currentUser && data.usernames.includes(appState.currentUser.username)) {
            loadContacts();
            loadRequests();
        }
    });

    socket.on('contact-removed', (data) => {
        if (!appState.currentUser || !data.usernames.includes(appState.currentUser.username)) return;
        loadContacts();
        loadRequests();
        const removedUser = data.usernames.find(username => username !== appState.currentUser.username);
        if (removedUser && appState.currentDMUser === removedUser) {
            appState.currentDMUser = null;
            loadChannels().then(() => {
                if (appState.currentChannel) loadMessages(appState.currentChannel);
            });
            updateMessageInputState();
            showToast('Контакт удалён из списка');
        }
    });

    socket.on('channel-created', () => loadChannels());

    socket.on('verification-updated', data => {
        if (!appState.currentUser) return;
        loadChannels();
        loadContacts();
        if (appState.currentDMUser) loadDirectMessages(appState.currentDMUser);
        else if (appState.currentChannel) loadMessages(appState.currentChannel);
        if (data.targetType === 'user' && data.targetId === appState.currentUser.username) {
            appState.currentUser.verified = Boolean(data.verified);
        }
    });

    socket.on('user-online', (data) => {
        appState.onlineUsers.set(data.username, data);
        updateOnlineUsers();
        if (appState.currentUser) loadContacts();
    });

    socket.on('user-offline', (data) => {
        appState.onlineUsers.delete(data.username);
        updateOnlineUsers();
        if (appState.currentUser) loadContacts();
    });

    socket.on('online-users', users => {
        appState.onlineUsers.clear();
        users.forEach(user => appState.onlineUsers.set(user.username, user));
        updateOnlineUsers();
        if (appState.currentUser) loadContacts();
    });
    socket.on('story-created', () => loadStories());

    socket.on('disconnect', () => {
        console.log('✗ Отключено от сервера');
        showToast('Отключено от сервера ✗');
    });
}

// ===== ЗАГРУЗКА ДАННЫХ =====
async function loadChannels() {
    try {
        const response = await fetch(`${API_URL}/api/channels`, { credentials: 'include' });
        if (!response.ok) throw new Error(`Сервер вернул ошибку ${response.status}`);
        const channels = await response.json();
        appState.channels = channels;

        const availableChannel = Object.entries(channels).find(([, channel]) => !channel.isGroup)?.[0];
        if (!appState.currentChannel || !channels[appState.currentChannel]) appState.currentChannel = availableChannel || null;

        const serverChannelsList = document.getElementById('server-channels-list');
        const groupsList = document.getElementById('groups-list');
        serverChannelsList.innerHTML = '';
        groupsList.innerHTML = '';

        for (const [id, channel] of Object.entries(channels)) {
            if (channel.isGroup) {
                const groupItem = document.createElement('div');
                groupItem.className = `channel-item ${id === appState.currentChannel ? 'active' : ''}`;
                groupItem.dataset.channel = id;
                groupItem.innerHTML = `<i class="fas fa-users"></i><span>${escapeHtml(channel.name)}${renderVerifiedBadge(channel)}</span>`;
                groupItem.addEventListener('click', () => switchChannel(id));
                groupsList.appendChild(groupItem);
                continue;
            }

            const channelItem = document.createElement('div');
            channelItem.className = `server-icon channel-server-icon channel-item ${id === appState.currentChannel ? 'active' : ''}`;
            channelItem.dataset.channel = id;
            channelItem.title = channel.name;
            channelItem.innerHTML = channel.avatar
                ? `<img src="${escapeHtml(channel.avatar)}" alt=""><span class="channel-label">${escapeHtml(channel.name)}${renderVerifiedBadge(channel)}</span>`
                : `<i class="fas fa-hashtag"></i><span class="channel-label">${escapeHtml(channel.name)}${renderVerifiedBadge(channel)}</span>`;
            channelItem.addEventListener('click', () => switchChannel(id));
            serverChannelsList.appendChild(channelItem);
        }
        updateContainerActions(appState.currentChannel);
    } catch (error) {
        console.error('Ошибка загрузки каналов:', error);
    }
}

async function loadContacts() {
    if (!appState.currentUser) return;

    try {
        const response = await fetch(`${API_URL}/api/contacts/${encodeURIComponent(appState.currentUser.username)}`, { credentials: 'include' });
        const contacts = await response.json();
        appState.contacts = contacts;

        const contactsList = document.getElementById('contacts-list');
        document.getElementById('contacts-count').textContent = contacts.length;

        if (contacts.length === 0) {
            contactsList.innerHTML = '<p style="padding: 8px; color: var(--text-muted); font-size: 12px;">Нет контактов. Добавьте первый!</p>';
            return;
        }

        contactsList.innerHTML = '';

        contacts.forEach(contact => {
            const div = document.createElement('div');
            div.className = 'contact-item';
            div.style.cssText = `
                padding: 8px 12px;
                display: flex;
                align-items: center;
                gap: 8px;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.2s;
            `;
            div.onmouseover = () => div.style.backgroundColor = 'rgba(255,255,255,0.1)';
            div.onmouseout = () => div.style.backgroundColor = 'transparent';

            div.innerHTML = `
                <div class="contact-avatar" style="width: 24px; height: 24px; flex: 0 0 24px; border-radius: 50%; background: linear-gradient(135deg, #5865f2, #4752c4); display: flex; align-items: center; justify-content: center; overflow: hidden; color: white; font-size: 12px; font-weight: bold;"></div>
                <span style="font-size: 13px; flex: 1; color: var(--text-primary);">${escapeHtml(contact.botName || contact.username)}${renderRoleBadge(contact)}${renderVerifiedBadge(contact)}${contact.premium ? ' <span class="premium-crown" title="Pulscord Premium">★</span>' : ''}</span>
                <span class="contact-status-dot" title="${appState.onlineUsers.has(contact.username) ? 'В сети' : 'Не в сети'}" style="width: 8px; height: 8px; background: ${appState.onlineUsers.has(contact.username) ? '#43b581' : '#72767d'}; border-radius: 50%; display: inline-block;"></span>
                <button class="remove-contact-btn" type="button" title="Удалить друга" aria-label="Удалить друга"><i class="fas fa-user-minus"></i></button>
            `;
            applyAvatarToElement(div.querySelector('.contact-avatar'), contact.avatar, contact.username[0]);

            div.addEventListener('click', () => openDirectMessage(contact.username));
            div.querySelector('.remove-contact-btn').addEventListener('click', event => {
                event.stopPropagation();
                removeContact(contact.username);
            });
            contactsList.appendChild(div);
        });
    } catch (error) {
        console.error('Ошибка загрузки контактов:', error);
    }
}

async function removeContact(username) {
    const confirmed = await openModal({ title: 'Удалить друга?', description: `@${username} исчезнет из списка контактов. Переписка сохранится.`, confirmText: 'Удалить', icon: 'fa-user-minus', danger: true });
    if (!confirmed) return;
    const response = await fetch(`${API_URL}/api/contacts/${encodeURIComponent(appState.currentUser.username)}/remove/${encodeURIComponent(username)}`, { method: 'DELETE', credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || 'Не удалось удалить друга');
    await loadContacts();
    if (appState.currentDMUser === username) {
        appState.currentDMUser = null;
        await loadChannels();
        if (appState.currentChannel) {
            loadMessages(appState.currentChannel);
            document.getElementById('channel-name').textContent = appState.channels[appState.currentChannel]?.name || appState.currentChannel;
            document.getElementById('channel-desc').textContent = appState.channels[appState.currentChannel]?.description || '';
        }
        updateMessageInputState();
    }
    showToast('Друг удалён ✓');
}

async function createBot() {
    openBotBuilder();
}

function addBotBlock(type = 'trigger') {
    const blocks = document.getElementById('bot-blocks');
    const block = document.createElement('div');
    block.className = 'bot-block';
    block.innerHTML = `<div class="bot-block-head"><strong><i class="fas fa-grip-vertical"></i> Блок</strong><button type="button" class="bot-block-remove" title="Удалить"><i class="fas fa-xmark"></i></button></div><select class="modal-input bot-block-type"><option value="trigger" ${type === 'trigger' ? 'selected' : ''}>Когда: команда или слово</option><option value="reply" ${type === 'reply' ? 'selected' : ''}>Ответить текстом</option><option value="condition" ${type === 'condition' ? 'selected' : ''}>Условие: содержит текст</option></select><input class="modal-input bot-block-value" placeholder="/help или привет"><small class="bot-block-hint">Триггер: команда начинается с /, слово запускает автоответ.</small>`;
    block.querySelector('.bot-block-remove').addEventListener('click', () => block.remove());
    block.querySelector('.bot-block-type').addEventListener('change', event => updateBotBlockFields(block, event.target.value));
    blocks.appendChild(block);
    updateBotBlockFields(block, type);
}

function updateBotBlockFields(block, type) {
    const input = block.querySelector('.bot-block-value');
    const hint = block.querySelector('.bot-block-hint');
    input.placeholder = type === 'trigger' ? '/help или привет' : type === 'reply' ? 'Текст ответа. Можно использовать {text}' : 'слово для проверки';
    hint.textContent = type === 'trigger' ? 'Первый блок запускает сценарий.' : type === 'reply' ? 'Ответ отправится участникам чата.' : 'Условие ограничит ответ, если текст не содержит значение.';
}

function openBotBuilder() {
    document.getElementById('bot-builder-name').value = '';
    document.getElementById('bot-blocks').innerHTML = '';
    addBotBlock('trigger');
    addBotBlock('reply');
    document.getElementById('bot-builder-modal').classList.remove('hidden');
}

async function saveBotBuilder() {
    const name = document.getElementById('bot-builder-name').value.trim();
    const blocks = [...document.querySelectorAll('#bot-blocks .bot-block')].map(block => ({ type: block.querySelector('.bot-block-type').value, value: block.querySelector('.bot-block-value').value.trim() })).filter(block => block.value);
    if (!name || !blocks.length) return showToast('Укажи имя и добавь блоки');
    try {
        const response = await fetch(`${API_URL}/api/bots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name, blocks }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || 'Не удалось создать бота');
        document.getElementById('bot-builder-modal').classList.add('hidden');
        await loadContacts();
        showToast(`Бот «${name}» создан ✓`);
    } catch (error) {
        showToast('Ошибка создания бота');
    }
}

/* Старый пошаговый API оставлен совместимым для уже созданных ботов. */
async function createLegacyBot() {
    const name = await openModal({ title: 'Создать бота', description: 'Имя бота, например Помощник', confirmText: 'Далее', icon: 'fa-robot', input: true });
    if (!name || !name.trim()) return;
    const command = await openModal({ title: 'Команда бота', description: 'Например: weather', confirmText: 'Далее', icon: 'fa-terminal', input: true });
    if (!command || !command.trim()) return;
    const responseText = await openModal({ title: 'Ответ бота', description: 'Можно использовать {text}.', confirmText: 'Создать', icon: 'fa-comment', input: true });
    if (!responseText || !responseText.trim()) return;
    try {
        const response = await fetch(`${API_URL}/api/bots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name, command, triggerType: 'command', response: responseText }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || 'Не удалось создать бота');
        await loadContacts();
        showToast(`Бот «${name}» создан ✓`);
    } catch (error) {
        showToast('Ошибка создания бота');
    }
}

async function loadRequests() {
    if (!appState.currentUser) return;

    try {
        const response = await fetch(`${API_URL}/api/requests/${encodeURIComponent(appState.currentUser.username)}`);
        if (!response.ok) return;
        appState.requests = await response.json();
        const count = document.getElementById('requests-count');
        const list = document.getElementById('requests-list');
        count.textContent = appState.requests.length;
        count.classList.toggle('hidden', appState.requests.length === 0);

        if (!appState.requests.length) {
            list.innerHTML = '<p class="sidebar-empty">Нет новых заявок</p>';
            return;
        }

        list.innerHTML = '';
        appState.requests.forEach(request => {
            const item = document.createElement('div');
            item.className = 'request-item';
            item.innerHTML = `
                <div class="avatar small">${escapeHtml(request.avatar)}</div>
                <div class="request-info"><strong>@${escapeHtml(request.from)}</strong><span>хочет начать чат</span></div>
                <div class="request-actions">
                    <button class="request-accept" title="Принять"><i class="fas fa-check"></i></button>
                    <button class="request-reject" title="Отклонить"><i class="fas fa-xmark"></i></button>
                </div>
            `;
            item.querySelector('.request-accept').addEventListener('click', () => respondToRequest(request.id, 'accept'));
            item.querySelector('.request-reject').addEventListener('click', () => respondToRequest(request.id, 'reject'));
            list.appendChild(item);
        });
    } catch (error) {
        console.error('Ошибка загрузки заявок:', error);
    }
}

async function respondToRequest(requestId, action) {
    try {
        const response = await fetch(`${API_URL}/api/requests/${encodeURIComponent(appState.currentUser.username)}/${requestId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Не удалось обработать заявку');
        await loadRequests();
        if (action === 'accept') {
            await loadContacts();
            showToast('Чат добавлен ✓');
        }
    } catch (error) {
        console.error('Ошибка обработки заявки:', error);
        showToast('Не удалось обработать заявку');
    }
}

async function loadMessages(channel) {
    try {
        const response = await fetch(`${API_URL}/api/channels/${encodeURIComponent(channel)}/messages`, { credentials: 'include' });
        const messages = await response.json();

        const messagesArea = document.getElementById('messages-area');
        messagesArea.innerHTML = '';

        if (messages.length === 0) {
            messagesArea.innerHTML = `
                <div style="padding: 40px 20px; text-align: center; color: var(--text-muted); display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
                    <i style="font-size: 48px; opacity: 0.3; margin-bottom: 16px;" class="fas fa-comments"></i>
                    <p style="font-size: 16px;">Нет сообщений</p>
                    <p style="font-size: 13px; margin-top: 8px;">Начните разговор. Напишите первое сообщение.</p>
                </div>
            `;
            return;
        }

        const messageGroup = document.createElement('div');
        messageGroup.className = 'message-group';

        messages.forEach(msg => {
            const messageEl = createMessageElement(msg, channel);
            messageGroup.appendChild(messageEl);
        });

        messagesArea.appendChild(messageGroup);
        scrollToBottom();
        appState.messageCount = messages.length;
        document.getElementById('msg-count').textContent = messages.length;
    } catch (error) {
        console.error('Ошибка загрузки сообщений:', error);
    }
}

function renderAvatarHtml(avatar, fallback = '?') {
    if (!avatar) return `<div class="avatar">${escapeHtml(fallback)}</div>`;
    const value = String(avatar).trim();
    if (value.startsWith('data:image') || value.startsWith('http://') || value.startsWith('https://')) {
        return `<div class="avatar has-image"><img class="avatar-image" src="${value}" alt="avatar" /></div>`;
    }
    return `<div class="avatar">${escapeHtml(value.slice(0, 2).toUpperCase())}</div>`;
}

function renderRoleBadge(user) {
    if (user?.bot || user?.username === 'School Assistant') {
        return '<span class="role-badge bot-badge" title="Школьный помощник">BOT</span>';
    }
    if (user?.developer || user?.username === 'Deverlope') {
        return '<span class="role-badge developer-badge" title="Разработчик">DEV</span>';
    }
    if (user?.admin) {
        return '<span class="role-badge admin-badge" title="Администратор">ADMIN</span>';
    }
    return '';
}

function renderVerifiedBadge(item) {
    return item?.verified ? '<span class="verified-badge" title="Подтверждено Pulscord" aria-label="Подтверждено">✓</span>' : '';
}

function applyAvatarToElement(element, avatar, fallback = '?') {
    const value = String(avatar || '').trim();
    element.innerHTML = '';
    element.classList.remove('has-image');
    element.style.backgroundImage = '';
    element.style.backgroundSize = '';
    element.style.backgroundPosition = '';
    element.style.padding = '';

    if (value.startsWith('data:image') || value.startsWith('http://') || value.startsWith('https://')) {
        const img = document.createElement('img');
        img.src = value;
        img.alt = 'avatar';
        img.className = 'avatar-image';
        element.appendChild(img);
        element.classList.add('has-image');
        return;
    }

    const text = document.createElement('span');
    text.textContent = (value ? value.slice(0, 2).toUpperCase() : fallback.slice(0, 2).toUpperCase()) || '?';
    element.appendChild(text);
}

function createMessageElement(msg, channel) {
    const isOwn = msg.author === appState.currentUser.username;
    const canDelete = appState.currentUser.username === 'Deverlope';
    const messageEl = document.createElement('div');
    messageEl.className = `message ${isOwn ? 'own-message' : ''} ${msg.pinned ? 'pinned-message' : ''}`;
    messageEl.id = `msg-${msg.id}`;

    const timestamp = new Date(msg.timestamp).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });

    const imageHtml = msg.image ? `<img class="message-image" src="${msg.image}" alt="Фото в сообщении">` : '';
    const fileHtml = msg.file?.data ? renderFileAttachment(msg.file) : '';
    const audioHtml = msg.audio ? `<div class="message-audio-card"><div class="message-audio-icon"><i class="fas fa-microphone"></i></div><div class="message-audio-body"><span>Голосовое сообщение</span><div class="custom-audio-player"><button class="audio-play-button" type="button" aria-label="Воспроизвести"><i class="fas fa-play"></i></button><input class="audio-progress" type="range" min="0" max="100" value="0" aria-label="Прогресс аудио"><span class="audio-time">0:00</span><audio class="message-audio" preload="metadata"></audio></div></div></div>` : '';
    const videoHtml = msg.video ? `<div class="message-video-note-card"><video class="message-video-note" playsinline preload="metadata"></video><button class="video-note-play" type="button" aria-label="Воспроизвести видеокружок"><i class="fas fa-play"></i></button><span class="video-note-label">Видеокружок</span></div>` : '';
    const stickerMatch = typeof msg.text === 'string' ? msg.text.match(/^\[\[sticker:(.+)\]\]$/) : null;
    const stickerHtml = stickerMatch ? `<div class="message-sticker" aria-label="Стикер">${escapeHtml(stickerMatch[1])}</div>` : '';
    const textHtml = msg.text && !stickerMatch ? `<div class="message-text">${renderMentionText(msg.text)}</div>` : '';
    const reactionHtml = `<div class="message-reactions">${Object.entries(msg.reactions || {}).map(([emoji, users]) => `<button class="reaction-btn ${users.includes(appState.currentUser.username) ? 'active' : ''}" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)} ${users.length}</button>`).join('')}<button class="reaction-add-btn" title="Добавить реакцию">+</button></div>`;
    const replyHtml = msg.replyTo ? `<div class="message-reply"><strong>Ответ на ${escapeHtml(msg.replyTo.author)}</strong><span>${escapeHtml(msg.replyTo.text || 'Медиа-сообщение')}</span></div>` : '';
    const monkeyNftHtml = msg.monkeyNft ? `<div class="monkey-nft-message"><img src="${escapeHtml(msg.monkeyNft.image)}" alt="${escapeHtml(msg.monkeyNft.name)}"><div><strong>${escapeHtml(msg.monkeyNft.name)}</strong><span>${escapeHtml(msg.monkeyNft.rarity)} · NFT Monkey</span><small>Подарено: ${Number(msg.monkeyNft.starAmount || 0).toLocaleString('ru-RU')} ★</small></div></div>` : '';
    const schoolMenuHtml = msg.schoolMenu ? `<div class="school-menu"><button type="button" data-school-command="/school calc ">🧮 Калькулятор</button><button type="button" data-school-command="/school formula">📚 Формулы</button><button type="button" data-school-command="/school time">🕒 Время</button><button type="button" data-school-command="/school help">❔ Помощь</button></div>` : '';

    messageEl.innerHTML = `
        ${renderAvatarHtml(msg.avatar, msg.author ? msg.author[0] : '?')}
        <div class="message-content">
            <div class="message-header">
                <span class="username">${escapeHtml(msg.author)}${renderRoleBadge(msg)}${renderVerifiedBadge(msg)}${msg.premium ? ' <span class="premium-crown" title="Pulscord Premium">★</span>' : ''}</span>
                <span class="timestamp">${timestamp} ${msg.edited ? '(отредактировано)' : ''}</span>
            </div>
            ${replyHtml}
            ${monkeyNftHtml}
            ${imageHtml}
            ${fileHtml}
            ${audioHtml}
            ${videoHtml}
            ${stickerHtml}
            ${textHtml}
            ${schoolMenuHtml}
            ${reactionHtml}
            ${channel ? `
                <div class="message-actions">
                    <button class="msg-btn reply-btn" title="Ответить" aria-label="Ответить" data-id="${msg.id}"><i class="fas fa-reply"></i></button>
                    <button class="msg-btn forward-btn" title="Переслать" aria-label="Переслать" data-id="${msg.id}"><i class="fas fa-share"></i></button>
                    ${canDelete ? `<button class="msg-btn pin-btn" title="${msg.pinned ? 'Открепить' : 'Закрепить'}" aria-label="${msg.pinned ? 'Открепить' : 'Закрепить'}" data-id="${msg.id}"><i class="fas fa-thumbtack"></i></button>` : ''}
                    ${isOwn ? `<button class="msg-btn edit-btn" title="Редактировать" aria-label="Редактировать сообщение" data-id="${msg.id}" data-channel="${channel}"><i class="fas fa-pen"></i></button>` : ''}
                    ${canDelete ? `<button class="msg-btn delete-btn" title="Удалить" aria-label="Удалить сообщение" data-id="${msg.id}" data-channel="${channel}"><i class="fas fa-trash"></i></button>` : ''}
                </div>
            ` : ''}
        </div>
    `;

    if (channel) {
        messageEl.querySelector('.reply-btn').addEventListener('click', () => prepareReply(msg));
        messageEl.querySelector('.forward-btn').addEventListener('click', () => forwardMessage(msg));
        messageEl.querySelector('.pin-btn')?.addEventListener('click', () => togglePin(msg.id, channel));
    }
    if (channel && canDelete) {
        messageEl.querySelector('.edit-btn')?.addEventListener('click', () => editMessage(msg.id, channel, msg.text));
        messageEl.querySelector('.delete-btn').addEventListener('click', () => deleteMessage(msg.id, channel, msg.author));
    }
    messageEl.querySelectorAll('.reaction-btn').forEach(button => button.addEventListener('click', () => toggleReaction(msg.id, channel, button.dataset.emoji)));
    messageEl.querySelector('.reaction-add-btn').addEventListener('click', () => addReaction(msg.id, channel));
    messageEl.querySelectorAll('[data-school-command]').forEach(button => button.addEventListener('click', () => {
        const input = document.getElementById('message-input');
        input.value = button.dataset.schoolCommand;
        input.focus();
    }));

    if (msg.audio) {
        const audio = messageEl.querySelector('.message-audio');
        const playButton = messageEl.querySelector('.audio-play-button');
        const progress = messageEl.querySelector('.audio-progress');
        const time = messageEl.querySelector('.audio-time');
        audio.src = msg.audio;
        const formatAudioTime = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
        const updateAudioProgress = () => {
            progress.value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
            time.textContent = formatAudioTime(audio.currentTime || 0);
        };
        playButton.addEventListener('click', () => {
            if (audio.paused) audio.play();
            else audio.pause();
        });
        audio.addEventListener('play', () => { playButton.innerHTML = '<i class="fas fa-pause"></i>'; playButton.setAttribute('aria-label', 'Пауза'); });
        audio.addEventListener('pause', () => { playButton.innerHTML = '<i class="fas fa-play"></i>'; playButton.setAttribute('aria-label', 'Воспроизвести'); });
        audio.addEventListener('loadedmetadata', () => { time.textContent = `0:00 / ${formatAudioTime(audio.duration)}`; });
        audio.addEventListener('timeupdate', updateAudioProgress);
        audio.addEventListener('ended', () => { progress.value = 0; time.textContent = `0:00 / ${formatAudioTime(audio.duration || 0)}`; });
        progress.addEventListener('input', () => { if (audio.duration) audio.currentTime = (Number(progress.value) / 100) * audio.duration; });
    }

    if (msg.video) {
        const video = messageEl.querySelector('.message-video-note');
        const playButton = messageEl.querySelector('.video-note-play');
        video.src = msg.video;
        video.load();
        playButton.addEventListener('click', async () => {
            if (video.paused) await video.play();
            else video.pause();
        });
        video.addEventListener('play', () => { playButton.innerHTML = '<i class="fas fa-pause"></i>'; });
        video.addEventListener('pause', () => { playButton.innerHTML = '<i class="fas fa-play"></i>'; });
        video.addEventListener('ended', () => { playButton.innerHTML = '<i class="fas fa-rotate-left"></i>'; });
        video.addEventListener('error', () => console.error('Не удалось воспроизвести видеокружок'));
    }

    return messageEl;
}

function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (!size) return 'Размер неизвестен';
    if (size < 1024) return `${size} Б`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
    return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function getFileSizeFromData(data) {
    const match = typeof data === 'string' ? data.match(/^data:[^;]+;base64,(.*)$/) : null;
    return match ? Math.ceil(match[1].length * 3 / 4) : 0;
}

function renderFileAttachment(file) {
    const name = escapeHtml(file.name || 'Файл');
    const type = escapeHtml(file.type || 'application/octet-stream');
    const data = escapeHtml(file.data);
    const size = formatFileSize(file.size || getFileSizeFromData(file.data));
    if ((file.type || '').startsWith('image/')) {
        return `<div class="message-file message-image-file"><a href="${data}" target="_blank" rel="noreferrer"><img src="${data}" alt="${name}"></a><div class="message-file-info"><strong>${name}</strong><small>${type} · ${size}</small><a class="message-file-download" href="${data}" download="${name}"><i class="fas fa-download"></i> Скачать</a></div></div>`;
    }
    return `<div class="message-file"><div class="message-file-icon"><i class="fas fa-file"></i></div><div class="message-file-info"><strong>${name}</strong><small>${type} · ${size}</small><a class="message-file-download" href="${data}" download="${name}"><i class="fas fa-download"></i> Скачать</a></div></div>`;
}

function renderMentionText(text) {
    return escapeHtml(text).replace(/(^|\s)(@[\wА-Яа-яЁё0-9_]+)/g, '$1<span class="message-mention">$2</span>');
}

// ===== ОТПРАВКА СООБЩЕНИЯ =====
function setupAppEvents() {
    document.querySelectorAll('.search-box input').forEach(input => {
        input.addEventListener('input', () => filterSidebarItems(input.value));
    });
    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    document.getElementById('attach-image-btn').addEventListener('click', () => {
        document.getElementById('image-upload').click();
    });
    document.getElementById('attach-file-btn').addEventListener('click', () => {
        document.getElementById('file-upload').click();
    });
    document.getElementById('schedule-message-btn').addEventListener('click', scheduleMessage);

    document.querySelector('.menu-button')?.addEventListener('click', () => {
        const sidebar = document.querySelector('.channels-sidebar');
        if (sidebar) sidebar.classList.toggle('active');
    });

    document.querySelector('.mobile-menu-button')?.addEventListener('click', () => {
        document.querySelector('.channels-sidebar')?.classList.toggle('active');
    });

    document.querySelector('.main-container')?.addEventListener('click', event => {
        if (event.target === event.currentTarget) {
            document.querySelector('.channels-sidebar')?.classList.remove('active');
        }
    });

    document.querySelectorAll('.channel-item, .contact-item').forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                document.querySelector('.channels-sidebar')?.classList.remove('active');
            }
        });
    });

    document.getElementById('image-upload').addEventListener('change', handleImageSelection);
    document.getElementById('file-upload').addEventListener('change', handleFileSelection);
    document.getElementById('remove-image-btn').addEventListener('click', removePendingImage);
    document.getElementById('remove-file-btn').addEventListener('click', removePendingFile);
    document.getElementById('remove-reply-btn').addEventListener('click', clearReply);
    document.getElementById('add-story-btn').addEventListener('click', () => document.getElementById('story-upload').click());
    document.getElementById('story-upload').addEventListener('change', handleStoryUpload);
    document.getElementById('voice-message-btn').addEventListener('click', toggleVoiceMessageRecording);
    document.getElementById('video-note-btn').addEventListener('click', toggleVideoNoteRecording);
    document.getElementById('stop-recording-btn').addEventListener('click', stopMediaRecording);
    document.getElementById('sticker-btn').addEventListener('click', () => document.getElementById('sticker-panel').classList.toggle('hidden'));
    document.querySelectorAll('[data-sticker]').forEach(button => {
        button.addEventListener('click', () => sendSticker(button.dataset.sticker));
    });
    document.querySelector('.input-wrapper .fa-paper-plane').parentElement.addEventListener('click', sendMessage);
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('add-contact-btn').addEventListener('click', openAddContactDialog);
    document.getElementById('block-user-btn').addEventListener('click', toggleBlockCurrentUser);
    document.getElementById('create-bot-btn').addEventListener('click', createBot);
    document.getElementById('add-bot-block-btn').addEventListener('click', () => addBotBlock('reply'));
    document.getElementById('bot-builder-save').addEventListener('click', saveBotBuilder);
    document.getElementById('bot-builder-cancel').addEventListener('click', () => document.getElementById('bot-builder-modal').classList.add('hidden'));
    document.getElementById('edit-profile-btn').addEventListener('click', openProfileDialog);
    document.getElementById('left-edit-profile-btn').addEventListener('click', openProfileDialog);
    document.getElementById('profile-save-btn').addEventListener('click', saveProfile);
    document.getElementById('profile-cancel-btn').addEventListener('click', () => document.getElementById('profile-modal').classList.add('hidden'));
    document.getElementById('profile-avatar-btn').addEventListener('click', () => document.getElementById('profile-avatar-upload').click());
    document.getElementById('profile-avatar-upload').addEventListener('change', handleProfileAvatarUpload);
    document.getElementById('voice-call-btn').addEventListener('click', startVoiceCall);
    document.getElementById('video-call-btn').addEventListener('click', startVideoCall);
    document.getElementById('voice-leave-btn').addEventListener('click', leaveVoiceCall);
    document.getElementById('voice-end-btn').addEventListener('click', leaveVoiceCall);
    document.getElementById('voice-mute-btn').addEventListener('click', toggleVoiceMute);
    document.getElementById('voice-video-btn').addEventListener('click', toggleVoiceVideo);
    document.getElementById('screen-share-btn').addEventListener('click', toggleScreenShare);
    document.getElementById('voice-output-btn').addEventListener('click', toggleVoiceOutput);
    document.getElementById('accept-call-btn').addEventListener('click', acceptIncomingCall);
    document.getElementById('decline-call-btn').addEventListener('click', declineIncomingCall);
    document.getElementById('add-channel-btn')?.addEventListener('click', createChannel);
    document.getElementById('server-create-channel-btn').addEventListener('click', openChannelMenu);
    document.getElementById('add-group-btn').addEventListener('click', createGroup);
    document.getElementById('buy-premium-btn').addEventListener('click', buyPremium);
    document.getElementById('admin-panel-btn').addEventListener('click', openAdminPanel);
    document.getElementById('content-panel-btn').addEventListener('click', openContentManagement);
    document.getElementById('content-close-btn').addEventListener('click', () => document.getElementById('content-modal').classList.add('hidden'));
    document.getElementById('monkey-nft-btn').addEventListener('click', openMonkeyNftCollection);
    document.getElementById('monkey-nft-close-btn').addEventListener('click', () => document.getElementById('monkey-nft-modal').classList.add('hidden'));
    document.getElementById('monkey-nft-search').addEventListener('input', event => renderMonkeyNfts(event.target.value));
    document.getElementById('admin-close-btn').addEventListener('click', closeAdminPanel);
    document.getElementById('admin-money-btn').addEventListener('click', () => adminAction('grant-money'));
    document.getElementById('admin-premium-btn').addEventListener('click', () => adminAction('grant-premium'));
    document.getElementById('admin-developer-btn').addEventListener('click', () => adminAction('grant-developer'));
    document.getElementById('admin-admin-btn').addEventListener('click', () => adminAction('grant-admin'));
    document.getElementById('admin-verification-btn').addEventListener('click', () => adminAction('grant-verification'));
    document.getElementById('invite-channel-btn').addEventListener('click', inviteToCurrentChannel);
    document.getElementById('channel-settings-btn').addEventListener('click', openContainerSettings);
    document.getElementById('channel-delete-btn').addEventListener('click', deleteCurrentContainer);
}

let monkeyNftCatalog = [];

async function openMonkeyNftCollection() {
    if (!appState.currentDMUser) return showToast('Открой личный чат, чтобы отправить обезьянку');
    const response = await fetch(`${API_URL}/api/monkey-nfts`, { credentials: 'include' });
    monkeyNftCatalog = await response.json().catch(() => []);
    renderMonkeyNfts('');
    document.getElementById('monkey-nft-modal').classList.remove('hidden');
}

function renderMonkeyNfts(query) {
    const normalizedQuery = String(query || '').toLowerCase().trim();
    const items = monkeyNftCatalog.filter(item => item.name.toLowerCase().includes(normalizedQuery));
    document.getElementById('monkey-nft-list').innerHTML = items.map(item => `<button class="monkey-nft-card" type="button" data-monkey-nft-id="${escapeHtml(item.id)}"><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.rarity)} · выбрать звёзды</span></button>`).join('') || '<small>Обезьянки не найдены</small>';
    document.querySelectorAll('#monkey-nft-list [data-monkey-nft-id]').forEach(button => button.addEventListener('click', () => sendMonkeyNft(button.dataset.monkeyNftId)));
}

async function sendMonkeyNft(nftId) {
    const starAmount = await openModal({ title: 'Сколько звёзд отправить?', description: 'NFT бесплатная. Звёзды будут переданы вместе с ней.', confirmText: 'Отправить', icon: 'fa-star', input: true });
    if (!starAmount || !/^\d+$/.test(String(starAmount).trim())) return;
    const response = await fetch(`${API_URL}/api/monkey-nfts/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ recipient: appState.currentDMUser, nftId, starAmount: Number(starAmount) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || 'Не удалось отправить обезьянку');
    document.getElementById('monkey-nft-modal').classList.add('hidden');
    if (data.balance !== undefined) document.getElementById('money-count').textContent = `${data.balance} ★`;
    await loadDirectMessages(appState.currentDMUser);
    showToast('NFT Monkey отправлена ✓');
}

function filterSidebarItems(value) {
    const query = value.trim().toLowerCase();
    document.querySelectorAll('.channel-item, .contact-item').forEach(item => {
        item.classList.toggle('search-hidden', Boolean(query) && !item.textContent.toLowerCase().includes(query));
    });
}

async function inviteToCurrentChannel() {
    if (appState.currentDMUser || appState.currentChannel === 'general' || appState.currentChannel === 'announcements' || appState.currentChannel === 'random' || appState.currentChannel === 'events') {
        return showToast('Приглашать можно только в созданный канал или группу');
    }
    const username = await openModal({ title: 'Пригласить участника', description: 'Введите username пользователя.', confirmText: 'Пригласить', icon: 'fa-user-plus', input: true });
    if (!username || !username.trim()) return;
    const isGroup = appState.channels[appState.currentChannel]?.isGroup;
    const endpoint = isGroup ? `/api/groups/${appState.currentChannel}/invite` : `/api/channels/${appState.currentChannel}/invite`;
    try {
        const response = await fetch(`${API_URL}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username.trim() }) });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Не удалось пригласить пользователя');
        showToast(`@${username.trim()} приглашен ✓`);
    } catch (error) {
        showToast('Не удалось пригласить пользователя');
    }
}

async function createChannel() {
    const name = await openModal({
        title: 'Новый канал',
        description: 'Название будет видно всем участникам Pulscord.',
        confirmText: 'Создать',
        icon: 'fa-hashtag',
        input: true
    });
    if (!name || !name.trim()) return;

    try {
        const response = await fetch(`${API_URL}/api/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ name: name.trim(), private: true })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || 'Не удалось создать канал');
        await loadChannels();
        switchChannel(data.id);
        showToast('Канал создан ✓');
    } catch (error) {
        console.error('Ошибка создания канала:', error);
        showToast(`Не удалось создать канал: ${error.message}`);
    }
}

async function openChannelMenu() {
    const result = await openModal({
        title: 'Канал',
        description: 'Введите название канала, чтобы войти. Кнопка «Создать» создаст новый канал.',
        confirmText: 'Войти',
        cancelText: 'Создать',
        cancelValue: '__create__',
        icon: 'fa-hashtag',
        input: true
    });
    if (result === '__create__') return createChannel();
    if (!result || !result.trim()) return;

    try {
        const response = await fetch(`${API_URL}/api/channels/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ name: result.trim() })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || 'Не удалось войти в канал');
        await loadChannels();
        switchChannel(data.id);
        showToast('Вы вошли в канал ✓');
    } catch (error) {
        showToast(`Не удалось войти в канал: ${error.message}`);
    }
}

async function createGroup() {
    const name = await openModal({ title: 'Новая группа', description: 'Создайте закрытую группу и приглашайте участников по username.', confirmText: 'Создать', icon: 'fa-user-group', input: true });
    if (!name || !name.trim()) return;
    try {
        const response = await fetch(`${API_URL}/api/groups`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() })
        });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Не удалось создать группу');
        await loadChannels();
        switchChannel(data.id);
        showToast('Группа создана ✓');
    } catch (error) {
        console.error('Ошибка создания группы:', error);
        showToast('Не удалось создать группу');
    }
}

async function buyPremium() {
    const confirmed = await openModal({ title: 'Купить Premium?', description: 'Стоимость Pulscord Premium — 1000 Pulscord Money.', confirmText: 'Купить за 1000 ★', icon: 'fa-star' });
    if (!confirmed) return;
    try {
        const response = await fetch(`${API_URL}/api/premium/buy`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Покупка не выполнена');
        appState.currentUser = data.user;
        localStorage.setItem('currentUser', JSON.stringify(data.user));
        document.getElementById('money-count').textContent = `${data.user.money} ★`;
        showToast('Premium активирован ✓');
    } catch (error) {
        showToast('Не удалось купить Premium');
    }
}

async function openAdminPanel() {
    try {
        const response = await fetch(`${API_URL}/api/admin/overview`);
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Нет доступа');
        const select = document.getElementById('admin-user-select');
        select.innerHTML = data.users.map(user => `<option value="${escapeHtml(user.username)}">@${escapeHtml(user.username)} — ${user.money || 0} ★</option>`).join('');
        document.getElementById('admin-modal').classList.remove('hidden');
    } catch (error) {
        showToast('Не удалось открыть админ-панель');
    }
}

async function openContentManagement() {
    try {
        const response = await fetch(`${API_URL}/api/admin/content`, { credentials: 'include' });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Нет доступа');
        const list = document.getElementById('content-management-list');
        const item = (label, value, action, id) => `<div class="management-row"><span>${label}: ${escapeHtml(value)}</span>${action ? `<button type="button" data-management-action="${action}" data-management-id="${escapeHtml(id)}" title="Удалить"><i class="fas fa-trash"></i></button>` : ''}</div>`;
        const chatItem = (id, label, details, type) => `<div class="management-row"><button class="management-chat-select" type="button" data-chat-id="${escapeHtml(id)}" data-chat-label="${escapeHtml(label)}"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(details)}</small></button>${type === 'dm-chat' ? '' : `<button type="button" data-management-action="${type}" data-management-id="${escapeHtml(id)}" title="Удалить"><i class="fas fa-trash"></i></button>`}</div>`;
        list.innerHTML = `<div class="management-section"><h3>Чаты</h3>${data.groups.map(group => chatItem(group.id, group.name, `Группа · ${group.members} участников`, 'group')).join('')}${data.channels.map(channel => chatItem(channel.id, channel.name, `Канал · ${channel.messages} сообщений`, 'channel')).join('')}${[...new Set(data.messages.filter(message => message.dm).map(message => message.dm))].map(dm => chatItem(dm, `ЛС: ${dm.replace('__', ' ↔ ')}`, 'Личный чат', 'dm-chat')).join('') || '<small>Нет чатов</small>'}</div><div class="management-section"><h3 id="selected-chat-title">Выбери чат</h3><div id="selected-chat-messages" class="selected-chat-messages"><small>Нажми на группу, канал или личный чат, чтобы увидеть сообщения.</small></div></div><div class="management-section"><h3>Боты (${data.bots.length})</h3>${data.bots.length ? data.bots.map(bot => item(`${bot.name || bot.username} /${bot.command}`, bot.username, 'bot', bot.username)).join('') : '<small>Нет ботов</small>'}</div>`;
        list.querySelectorAll('[data-management-action]').forEach(button => button.addEventListener('click', () => deleteManagedContent(button.dataset.managementAction, button.dataset.managementId)));
        list.querySelectorAll('[data-chat-id]').forEach(button => button.addEventListener('click', () => showManagedChat(data, button.dataset.chatId, button.dataset.chatLabel)));
        document.getElementById('content-modal').classList.remove('hidden');
    } catch (error) {
        showToast('Не удалось открыть управление чатами');
    }
}

function showManagedChat(data, chatId, label) {
    const messages = data.messages.filter(message => message.dm === chatId || (!message.dm && message.channel === chatId));
    document.getElementById('selected-chat-title').textContent = `${label} · сообщений: ${messages.length}`;
    document.getElementById('selected-chat-messages').innerHTML = messages.length ? messages.map(message => `<div class="managed-message"><strong>${escapeHtml(message.author)}</strong><span>${escapeHtml(message.text)}</span><button type="button" data-management-action="${message.dm ? 'dm-message' : 'message'}" data-management-id="${escapeHtml(`${message.dm || message.channel}::${message.id}`)}" title="Удалить"><i class="fas fa-trash"></i></button></div>`).join('') : '<small>В этом чате пока нет сообщений.</small>';
    document.querySelectorAll('#selected-chat-messages [data-management-action]').forEach(button => button.addEventListener('click', () => deleteManagedContent(button.dataset.managementAction, button.dataset.managementId)));
}

async function deleteManagedContent(type, id) {
    const confirmed = await openModal({ title: 'Удалить объект?', description: 'Действие доступно только Deverlope и необратимо.', confirmText: 'Удалить', icon: 'fa-trash', danger: true });
    if (!confirmed) return;
    let endpoint;
    if (type === 'bot') endpoint = `/api/admin/bots/${encodeURIComponent(id)}`;
    if (type === 'group') endpoint = `/api/groups/${encodeURIComponent(id)}`;
    if (type === 'channel') endpoint = `/api/channels/${encodeURIComponent(id)}`;
        if (type === 'message') {
        const separator = id.lastIndexOf('::');
        endpoint = `/api/channels/${encodeURIComponent(id.slice(0, separator))}/messages/${encodeURIComponent(id.slice(separator + 2))}`;
    }
        if (type === 'dm-message') {
            const separator = id.lastIndexOf('::');
            const users = id.slice(0, separator).split('__');
            const contact = users[0] === appState.currentUser.username ? users[1] : users[0];
            endpoint = `/api/dms/${encodeURIComponent(appState.currentUser.username)}/${encodeURIComponent(contact)}/messages/${encodeURIComponent(id.slice(separator + 2))}`;
        }
    const response = await fetch(`${API_URL}${endpoint}`, { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: appState.currentUser.username, deleteFor: 'everyone' }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || 'Не удалось удалить');
    showToast('Удалено ✓');
    openContentManagement();
    loadChannels();
}

function closeAdminPanel() {
    document.getElementById('admin-modal').classList.add('hidden');
}

async function adminAction(action) {
    const username = document.getElementById('admin-user-select').value;
    const amount = Number(document.getElementById('admin-amount-input').value);
    const body = action === 'grant-money'
        ? { username, amount }
        : action === 'grant-verification'
            ? { targetType: document.getElementById('verification-target-type').value, targetId: document.getElementById('verification-target-id').value.trim() || username }
            : { username };
    try {
        const response = await fetch(`${API_URL}/api/admin/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Операция не выполнена');
        showToast('Изменения применены ✓');
        openAdminPanel();
    } catch (error) {
        showToast('Админская операция не выполнена');
    }
}

function handleImageSelection(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Выберите изображение');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        appState.pendingImage = reader.result;
        const preview = document.getElementById('image-preview');
        document.getElementById('image-preview-image').src = reader.result;
        document.getElementById('image-preview-name').textContent = file.name;
        preview.classList.remove('hidden');
        showToast('Фото добавлено ✓');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function handleFileSelection(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const maxSize = appState.currentUser?.premium ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
    if (file.size > maxSize) {
        const limitText = appState.currentUser?.premium ? '50 МБ' : '5 МБ';
        showToast(`Файл слишком большой. Лимит для ${appState.currentUser?.premium ? 'Premium' : 'обычного'} аккаунта — ${limitText}`);
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        appState.pendingFile = { name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: reader.result };
        document.getElementById('file-preview-name').textContent = file.name;
        document.getElementById('file-preview-details').textContent = `${file.type || 'Файл'} · ${formatFileSize(file.size)} · Готово к отправке`;
        document.getElementById('file-preview').classList.remove('hidden');
        showToast(`Файл «${file.name}» добавлен ✓`);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

async function loadStories() {
    try {
        const response = await fetch(`${API_URL}/api/stories`);
        if (!response.ok) return;
        const stories = await response.json();
        const strip = document.getElementById('stories-strip');
        if (!strip) return;
        strip.querySelectorAll('.story-item').forEach(item => item.remove());
        stories.forEach(story => {
            const item = document.createElement('button');
            item.className = 'story-item';
            item.type = 'button';
            item.title = `Сторис ${story.author}`;
            item.innerHTML = `<img src="${story.image}" alt="Сторис ${escapeHtml(story.author)}"><small>${escapeHtml(story.author)}</small>`;
            item.addEventListener('click', () => openStoryViewer(story));
            strip.appendChild(item);
        });
    } catch (error) {
        console.error('Ошибка загрузки сторис:', error);
    }
}

function handleStoryUpload(event) {
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = async () => {
        const response = await fetch(`${API_URL}/api/stories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: reader.result })
        });
        if (response.ok) showToast('Сторис опубликована ✓');
        else showToast('Не удалось опубликовать сторис');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function openStoryViewer(story) {
    const viewer = document.createElement('div');
    viewer.className = 'story-viewer';
    viewer.innerHTML = `<button class="story-viewer-close" type="button"><i class="fas fa-xmark"></i></button><img src="${story.image}" alt="Сторис ${escapeHtml(story.author)}"><strong>${escapeHtml(story.author)}</strong>`;
    viewer.querySelector('.story-viewer-close').addEventListener('click', () => viewer.remove());
    viewer.addEventListener('click', event => { if (event.target === viewer) viewer.remove(); });
    document.body.appendChild(viewer);
}

function getRecorderMime(video) {
    const options = video ? ['video/webm;codecs=vp8,opus', 'video/webm'] : ['audio/webm;codecs=opus', 'audio/webm'];
    return options.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

async function toggleVoiceMessageRecording() {
    if (appState.mediaRecorder) return stopMediaRecording();
    await startMediaRecording('audio');
}

async function toggleVideoNoteRecording() {
    if (appState.mediaRecorder) return stopMediaRecording();
    await startMediaRecording('video');
}

async function startMediaRecording(type) {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        showToast('Запись медиа не поддерживается этим браузером');
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia(type === 'video'
            ? { audio: true, video: { width: { ideal: 480 }, height: { ideal: 480 }, facingMode: 'user' } }
            : { audio: true });
        if (type === 'video') {
            const preview = document.getElementById('recording-video-preview');
            document.getElementById('recording-video').srcObject = stream;
            preview.classList.remove('hidden');
        }
        const mimeType = getRecorderMime(type === 'video');
        appState.mediaChunks = [];
        appState.mediaRecordingType = type;
        appState.mediaRecordingStartedAt = Date.now();
        appState.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        appState.mediaRecorder.ondataavailable = event => { if (event.data.size) appState.mediaChunks.push(event.data); };
        appState.mediaRecorder.onstop = async () => {
            const blob = new Blob(appState.mediaChunks, { type: mimeType || (type === 'video' ? 'video/webm' : 'audio/webm') });
            stream.getTracks().forEach(track => track.stop());
            document.getElementById('recording-video').srcObject = null;
            document.getElementById('recording-video-preview').classList.add('hidden');
            const dataUrl = await blobToDataUrl(blob);
            await sendMediaMessage(type, dataUrl);
            appState.mediaRecorder = null;
            appState.mediaChunks = [];
            updateRecordingButtons();
        };
        appState.mediaRecorder.start();
        updateRecordingButtons();
        showToast(type === 'video' ? 'Запись кружочка началась. Нажмите ещё раз для отправки.' : 'Запись голосового началась. Нажмите ещё раз для отправки.');
    } catch (error) {
        showToast('Разрешите доступ к микрофону' + (type === 'video' ? ' и камере' : ''));
    }
}

function stopMediaRecording() {
    if (appState.mediaRecorder?.state !== 'inactive') appState.mediaRecorder.stop();
}

function updateRecordingButtons() {
    const recording = Boolean(appState.mediaRecorder);
    const indicator = document.getElementById('recording-indicator');
    indicator?.classList.toggle('hidden', !recording);
    if (recording) {
        document.getElementById('recording-label').textContent = appState.mediaRecordingType === 'video' ? 'Запись видеокружка' : 'Запись голосового';
        clearInterval(appState.mediaRecordingTimer);
        appState.mediaRecordingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - appState.mediaRecordingStartedAt) / 1000);
            document.getElementById('recording-timer').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
        }, 500);
    } else {
        clearInterval(appState.mediaRecordingTimer);
        appState.mediaRecordingTimer = null;
        document.getElementById('recording-timer').textContent = '00:00';
    }
    document.getElementById('voice-message-btn')?.classList.toggle('recording', recording && appState.mediaRecordingType === 'audio');
    document.getElementById('video-note-btn')?.classList.toggle('recording', recording && appState.mediaRecordingType === 'video');
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function sendMediaMessage(type, dataUrl) {
    const payload = {
        author: appState.currentUser.username,
        avatar: appState.currentUser.avatar,
        text: '',
        image: null,
        audio: type === 'audio' ? dataUrl : null,
        video: type === 'video' ? dataUrl : null
    };
    const username = encodeURIComponent(appState.currentUser.username);
    const endpoint = appState.currentDMUser
        ? `${API_URL}/api/dms/${username}/${encodeURIComponent(appState.currentDMUser)}/messages`
        : `${API_URL}/api/channels/${encodeURIComponent(appState.currentChannel)}/messages`;
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) });
    if (response.ok) showToast(type === 'video' ? 'Видеокружок отправлен ✓' : 'Голосовое отправлено ✓');
    else {
        const data = await response.json().catch(() => ({}));
        showToast(data.error || `Не удалось отправить медиа (${response.status})`);
    }
}

function removePendingImage() {
    appState.pendingImage = null;
    document.getElementById('image-preview').classList.add('hidden');
    document.getElementById('image-preview-image').removeAttribute('src');
}

function removePendingFile() {
    appState.pendingFile = null;
    document.getElementById('file-preview').classList.add('hidden');
    document.getElementById('file-preview-name').textContent = 'Файл';
    document.getElementById('file-preview-details').textContent = 'Готово к отправке';
}

function sendSticker(sticker) {
    document.getElementById('sticker-panel').classList.add('hidden');
    const input = document.getElementById('message-input');
    input.value = `[[sticker:${sticker}]]`;
    sendMessage();
}

async function sendMessage() {
    if (!appState.currentDMUser && !appState.currentChannel) {
        showToast('Сначала выберите чат');
        return;
    }
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    const image = appState.pendingImage;
    const file = appState.pendingFile;

    if (!text && !image && !file) return;

    try {
        const payload = {
            author: appState.currentUser.username,
            avatar: appState.currentUser.avatar,
            text,
            image: image || null,
            file: file || null,
            replyTo: appState.replyTo || null
        };

        if (appState.currentDMUser) {
            const response = await fetch(`${API_URL}/api/dms/${encodeURIComponent(appState.currentUser.username)}/${encodeURIComponent(appState.currentDMUser)}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ text, image: image || null, file: file || null, replyTo: appState.replyTo || null })
            });
            if (response.ok) {
                input.value = '';
                removePendingImage();
                removePendingFile();
                clearReply();
                await loadDirectMessages(appState.currentDMUser);
                showToast(file ? 'Файл отправлен ✓' : image ? 'Фото отправлено ✓' : 'Сообщение отправлено ✓');
            } else {
                const data = await response.json().catch(() => ({}));
                showToast(data.error || `Не удалось отправить сообщение (${response.status})`);
            }
            return;
        }

        const response = await fetch(`${API_URL}/api/channels/${appState.currentChannel}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            input.value = '';
            input.style.height = 'auto';
            removePendingImage();
            appState.pendingFile = null;
            clearReply();
            showToast(file ? 'Файл отправлен ✓' : image ? 'Фото отправлено ✓' : 'Сообщение отправлено ✓');
        } else {
            const data = await response.json().catch(() => ({}));
            showToast(data.error || `Не удалось отправить сообщение (${response.status})`);
        }
    } catch (error) {
        console.error('Ошибка отправки:', error);
        showToast('Ошибка отправки сообщения');
    }
}

async function scheduleMessage() {
    if (!appState.currentUser?.premium && appState.currentUser?.username !== 'Deverlope') return showToast('Отложенная отправка доступна только Premium');
    if (!appState.currentDMUser && !appState.currentChannel) return showToast('Сначала выбери чат');
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text) return showToast('Сначала напиши сообщение');
    const minutes = await openModal({ title: 'Отправить позже', description: 'Через сколько минут отправить? От 1 до 43200.', confirmText: 'Запланировать', icon: 'fa-clock', input: true });
    const delay = Number(minutes);
    if (!Number.isInteger(delay) || delay < 1 || delay > 43200) return showToast('Укажи целое число минут от 1 до 43200');
    const endpoint = appState.currentDMUser
        ? `${API_URL}/api/dms/${encodeURIComponent(appState.currentUser.username)}/${encodeURIComponent(appState.currentDMUser)}/schedule`
        : `${API_URL}/api/channels/${encodeURIComponent(appState.currentChannel)}/schedule`;
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ text, sendAt: new Date(Date.now() + delay * 60000).toISOString() }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || 'Не удалось запланировать сообщение');
    input.value = '';
    showToast(`Сообщение отправится через ${delay} мин. ✓`);
}

function prepareReply(message) {
    appState.replyTo = { id: message.id, author: message.author, text: message.text || 'Медиа-сообщение' };
    const preview = document.getElementById('reply-preview');
    if (preview) {
        document.getElementById('reply-preview-author').textContent = `Ответ на ${message.author}`;
        document.getElementById('reply-preview-text').textContent = appState.replyTo.text;
        preview.classList.remove('hidden');
    }
    document.getElementById('message-input')?.focus();
}

function clearReply() {
    appState.replyTo = null;
    document.getElementById('reply-preview')?.classList.add('hidden');
}

async function forwardMessage(message) {
    const text = message.text || 'Медиа-сообщение';
    const confirmed = await openModal({ title: 'Переслать сообщение?', description: text, confirmText: 'Переслать', icon: 'fa-share' });
    if (!confirmed) return;
    const input = document.getElementById('message-input');
    input.value = `↪ ${message.author}: ${text}`;
    sendMessage();
}

async function editMessage(messageId, channel, oldText) {
    const newText = await openModal({
        title: 'Редактировать сообщение',
        description: 'Изменения будут видны всем участникам канала.',
        value: oldText,
        confirmText: 'Сохранить',
        icon: 'fa-pen',
        input: true
    });
    if (!newText || !newText.trim()) return;

    try {
        const endpoint = channel.startsWith('dm:')
            ? `${API_URL}/api/dms/${encodeURIComponent(appState.currentUser.username)}/${encodeURIComponent(channel.slice(3))}/messages/${messageId}`
            : `${API_URL}/api/channels/${channel}/messages/${messageId}`;
        const response = await fetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: newText.trim(),
                author: appState.currentUser.username
            })
        });

        if (response.ok) {
            channel.startsWith('dm:') ? loadDirectMessages(channel.slice(3)) : loadMessages(channel);
            showToast('Сообщение отредактировано ✓');
        }
    } catch (error) {
        console.error('Ошибка редактирования:', error);
        showToast('Ошибка редактирования');
    }
}

async function toggleReaction(messageId, channel, emoji) {
    const isDM = channel.startsWith('dm:');
    const endpoint = isDM
        ? `${API_URL}/api/dms/${encodeURIComponent(appState.currentUser.username)}/${encodeURIComponent(channel.slice(3))}/messages/${messageId}/reactions`
        : `${API_URL}/api/channels/${channel}/messages/${messageId}/reactions`;
    const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji })
    });
    if (response.ok) isDM ? loadDirectMessages(channel.slice(3)) : loadMessages(channel);
}

async function addReaction(messageId, channel) {
    const emoji = await openModal({
        title: 'Добавить реакцию',
        description: 'Введите emoji, например: ❤️ 👍 😂',
        confirmText: 'Добавить',
        cancelText: 'Отмена',
        icon: 'fa-face-smile',
        input: true
    });
    if (!emoji || !emoji.trim()) return;
    await toggleReaction(messageId, channel, emoji.trim().split(/\s+/)[0]);
}

async function togglePin(messageId, channel) {
    if (channel.startsWith('dm:')) return showToast('В личных чатах закрепление пока недоступно');
    const response = await fetch(`${API_URL}/api/channels/${encodeURIComponent(channel)}/messages/${messageId}/pin`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || 'Не удалось изменить закрепление');
    await loadMessages(channel);
    showToast(data.pinned ? 'Сообщение закреплено ✓' : 'Сообщение откреплено ✓');
}

async function deleteMessage(messageId, channel, messageAuthor) {
    const canDeleteAll = appState.currentUser.username === 'Deverlope' || appState.currentUser.username === messageAuthor;
    let deleteFor = 'self';

    if (canDeleteAll) {
        const deleteEverywhere = await openModal({
            title: 'Удалить сообщение',
            description: 'Выберите, где удалить это сообщение.',
            confirmText: 'У всех',
            cancelText: 'У себя',
            icon: 'fa-trash',
            danger: true
        });
        if (deleteEverywhere === null) return;
        deleteFor = deleteEverywhere ? 'everyone' : 'self';
    } else {
        const confirmed = await openModal({
            title: 'Удалить у себя?',
            description: 'Сообщение исчезнет только в вашем чате.',
            confirmText: 'Удалить',
            icon: 'fa-eye-slash',
            danger: true
        });
        if (!confirmed) return;
    }

    try {
        const endpoint = channel.startsWith('dm:')
            ? `${API_URL}/api/dms/${encodeURIComponent(appState.currentUser.username)}/${encodeURIComponent(channel.slice(3))}/messages/${messageId}`
            : `${API_URL}/api/channels/${channel}/messages/${messageId}`;
        const response = await fetch(endpoint, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                author: appState.currentUser.username,
                deleteFor
            })
        });

        if (response.ok) {
            channel.startsWith('dm:') ? loadDirectMessages(channel.slice(3)) : loadMessages(channel);
            showToast('Сообщение удалено ✓');
        }
    } catch (error) {
        console.error('Ошибка удаления:', error);
        showToast('Ошибка удаления');
    }
}

async function startVoiceCall() {
    startCall(false);
}

async function startVideoCall() {
    startCall(true);
}

async function startCall(video, roomOverride = null) {
    if (appState.voiceRoom) return;
    if (!appState.currentUser) {
        showToast('Сначала войдите в аккаунт, затем примите звонок');
        return;
    }
    appState.voiceCallStartedAt = Date.now();
    showVoiceCallPanel();
    setVoiceCallStatus(video ? 'Подготовка видеозвонка...' : 'Подготовка звонка...', 'connecting');
    if (!navigator.mediaDevices?.getUserMedia) {
        setVoiceCallStatus('Микрофон недоступен на этом устройстве', 'error');
        return;
    }
    if (!appState.currentDMUser && !roomOverride) {
        showToast('Откройте личный чат, чтобы позвонить собеседнику');
        return;
    }
    try {
        appState.voiceStream = await requestCallMedia(video);
        appState.cameraTrack = appState.voiceStream.getVideoTracks()[0] || null;
        appState.videoEnabled = video;
        appState.voiceRoom = roomOverride || getVoiceRoomKey();
        appState.voiceParticipants.clear();
        appState.voiceCallStartedAt = Date.now();
        appState.voiceMuted = false;
        document.getElementById('voice-call-btn').classList.add('hidden');
        document.getElementById('video-call-btn').classList.add('hidden');
        document.getElementById('voice-leave-btn').classList.remove('hidden');
        if (video) {
            const localVideo = document.getElementById('voice-local-video');
            localVideo.srcObject = appState.voiceStream;
            document.getElementById('voice-video-grid').classList.remove('hidden');
        }
        socket.emit('voice-join', {
            room: appState.voiceRoom,
            username: appState.currentUser.username,
            targetUsername: roomOverride ? null : appState.currentDMUser,
            video
        });
    } catch (error) {
        appState.voiceStream?.getTracks().forEach(track => track.stop());
        appState.voiceStream = null;
        console.error('Ошибка доступа к устройствам:', error);
        const messages = {
            NotAllowedError: 'Разрешите микрофон и камеру в настройках приложения Android.',
            NotFoundError: 'Камера или микрофон не найдены.',
            NotReadableError: 'Камера или микрофон уже используются другой программой.',
            OverconstrainedError: 'Настройки камеры или микрофона не поддерживаются этим устройством.',
            SecurityError: 'Разрешите доступ к микрофону и камере в настройках Android.'
        };
        setVoiceCallStatus(messages[error.name] || 'Не удалось открыть камеру и микрофон', 'error');
        document.getElementById('voice-call-subtitle').textContent = 'Проверьте разрешения и повторите звонок';
    }
}

async function requestCallMedia(video) {
    const preferred = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000,
                sampleSize: 16
            },
            video
    };
    try {
        return await navigator.mediaDevices.getUserMedia(preferred);
    } catch (error) {
        if (!['OverconstrainedError', 'NotReadableError'].includes(error.name)) throw error;
        return navigator.mediaDevices.getUserMedia({ audio: true, video: Boolean(video) });
    }
}

function showIncomingCall(call) {
    appState.incomingCall = call;
    const panel = document.getElementById('incoming-call-panel');
    document.getElementById('incoming-call-caller').textContent = `${call.username} звонит вам`;
    document.getElementById('incoming-call-title').textContent = call.video ? 'Входящий видеозвонок' : 'Входящий звонок';
    document.getElementById('incoming-call-icon').className = `fas fa-${call.video ? 'video' : 'phone'}`;
    panel.classList.remove('hidden');
}

async function acceptIncomingCall() {
    const call = appState.incomingCall;
    if (!call) return;
    document.getElementById('incoming-call-panel').classList.add('hidden');
    appState.incomingCall = null;
    await startCall(call.video, call.room);
}

function declineIncomingCall() {
    const call = appState.incomingCall;
    if (!call) return;
    socket.emit('voice-reject', { target: call.socketId, username: appState.currentUser?.username });
    appState.incomingCall = null;
    document.getElementById('incoming-call-panel').classList.add('hidden');
}

function showVoiceCallPanel() {
    const panel = document.getElementById('voice-call-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    document.getElementById('voice-call-btn')?.classList.add('hidden');
    document.getElementById('video-call-btn')?.classList.add('hidden');
    document.getElementById('voice-leave-btn')?.classList.remove('hidden');
    updateVoiceCallUI();
    clearInterval(appState.voiceCallTimer);
    appState.voiceCallTimer = setInterval(updateVoiceCallUI, 1000);
}

function getVoiceRoomKey() {
    if (appState.currentDMUser) {
        const users = [appState.currentUser.username, appState.currentDMUser].sort();
        return `dm:${users[0]}:${users[1]}`;
    }
    return `channel:${appState.currentChannel}`;
}

function updateVoiceCallUI() {
    const title = document.getElementById('voice-call-title');
    const subtitle = document.getElementById('voice-call-subtitle');
    const status = document.getElementById('voice-call-status');
    const timer = document.getElementById('voice-call-timer');
    const avatar = document.getElementById('voice-call-avatar');
    const participants = document.getElementById('voice-call-participants');
    if (!title || !subtitle || !status || !timer || !avatar || !participants) return;

    const channelName = appState.currentDMUser ? `Звонок с ${appState.currentDMUser}` : 'Звонок';
    const names = [...appState.voiceParticipants.values()];
    title.textContent = channelName;
    subtitle.textContent = names.length ? `${names.length + 1} участника в звонке` : 'Ожидание ответа';
    if (status.dataset.manual !== 'true') status.textContent = names.length ? 'В эфире' : 'Вызов...';
    avatar.textContent = appState.currentUser?.username?.slice(0, 2).toUpperCase() || 'П';
    participants.innerHTML = names.map(name => `<span><i class="fas fa-circle"></i>${escapeHtml(name)}</span>`).join('');

    const elapsed = appState.voiceCallStartedAt ? Math.floor((Date.now() - appState.voiceCallStartedAt) / 1000) : 0;
    timer.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}

function setVoiceCallStatus(text, state = 'connecting') {
    const status = document.getElementById('voice-call-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.manual = state === 'connecting' || state === 'error' ? 'true' : 'false';
    status.dataset.state = state;
}

function toggleVoiceMute() {
    if (!appState.voiceStream) {
        setVoiceCallStatus('Сначала разрешите доступ к микрофону', 'error');
        return;
    }
    appState.voiceMuted = !appState.voiceMuted;
    appState.voiceStream.getAudioTracks().forEach(track => { track.enabled = !appState.voiceMuted; });
    const button = document.getElementById('voice-mute-btn');
    const label = document.getElementById('voice-mute-label');
    button.classList.toggle('muted', appState.voiceMuted);
    button.innerHTML = `<i class="fas fa-microphone${appState.voiceMuted ? '-slash' : ''}"></i>`;
    button.insertAdjacentHTML('beforeend', `<span id="voice-mute-label">${appState.voiceMuted ? 'Включить микрофон' : 'Микрофон'}</span>`);
    button.setAttribute('aria-pressed', String(appState.voiceMuted));
    button.title = appState.voiceMuted ? 'Включить микрофон' : 'Выключить микрофон';
    showToast(appState.voiceMuted ? 'Микрофон выключен' : 'Микрофон включен');
}

async function toggleVoiceVideo() {
    if (!appState.voiceStream) return;
    const button = document.getElementById('voice-video-btn');
    const currentTrack = appState.voiceStream.getVideoTracks()[0] || null;
    if (!currentTrack) {
        try {
            const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
            appState.cameraTrack = cameraStream.getVideoTracks()[0] || null;
            if (!appState.cameraTrack) return;
            appState.voiceStream.addTrack(appState.cameraTrack);
            for (const peer of appState.peerConnections.values()) {
                const sender = getVideoSender(peer);
                if (sender) {
                    const transceiver = peer.getTransceivers().find(item => item.sender === sender);
                    if (transceiver) transceiver.direction = 'sendrecv';
                    await sender.replaceTrack(appState.cameraTrack);
                } else {
                    peer.addTrack(appState.cameraTrack, appState.voiceStream);
                }
            }
            appState.videoEnabled = true;
            document.getElementById('voice-local-video').srcObject = appState.voiceStream;
            document.getElementById('voice-video-grid').classList.remove('hidden');
            button.classList.add('active');
            button.setAttribute('aria-pressed', 'true');
            button.title = 'Выключить видео';
            showToast('Видео включено');
            await renegotiateVoicePeers();
        } catch (error) {
            showToast(error.name === 'NotAllowedError' ? 'Разрешите камеру в настройках приложения' : 'Не удалось включить видео');
        }
        return;
    }
    currentTrack.enabled = !currentTrack.enabled;
    appState.videoEnabled = currentTrack.enabled;
    button.classList.toggle('active', currentTrack.enabled);
    button.setAttribute('aria-pressed', String(currentTrack.enabled));
    button.title = currentTrack.enabled ? 'Выключить видео' : 'Включить видео';
    button.querySelector('i').className = `fas fa-video${currentTrack.enabled ? '' : '-slash'}`;
    showToast(currentTrack.enabled ? 'Видео включено' : 'Видео выключено');
}

async function toggleVoiceOutput() {
    const button = document.getElementById('voice-output-btn');
    const audios = [...document.querySelectorAll('audio[id^="voice-audio-"]')];
    const speakerMode = button.getAttribute('aria-pressed') !== 'true';
    for (const audio of audios) {
        if (typeof audio.setSinkId === 'function') {
            await audio.setSinkId(speakerMode ? 'default' : 'communications').catch(() => {});
        }
        audio.volume = speakerMode ? 1 : 0.7;
    }
    button.setAttribute('aria-pressed', String(speakerMode));
    button.classList.toggle('active', speakerMode);
    button.title = speakerMode ? 'Выключить громкую связь' : 'Включить громкую связь';
    showToast(speakerMode ? 'Звук включён' : 'Наушники включены');
}

async function toggleScreenShare() {
    if (!appState.voiceRoom) return showToast('Сначала начните звонок');
    if (appState.screenSharing) {
        await stopScreenShare();
        return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
        showToast('Ваш браузер не поддерживает демонстрацию экрана');
        return;
    }
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        appState.screenTrack = screenStream.getVideoTracks()[0];
        appState.screenAudioTrack = screenStream.getAudioTracks()[0] || null;
        appState.screenSharing = true;
        appState.screenTrack.onended = stopScreenShare;
        const localVideo = document.getElementById('voice-local-video');
        localVideo.srcObject = screenStream;
        document.getElementById('voice-video-grid').classList.remove('hidden');

        for (const peer of appState.peerConnections.values()) {
            const sender = getVideoSender(peer);
            if (sender) {
                const transceiver = peer.getTransceivers().find(item => item.sender === sender);
                if (transceiver) transceiver.direction = 'sendrecv';
                await sender.replaceTrack(appState.screenTrack);
            }
            if (appState.screenAudioTrack) peer.addTrack(appState.screenAudioTrack, screenStream);
        }
        await renegotiateVoicePeers();
        const button = document.getElementById('screen-share-btn');
        button.classList.add('active');
        button.title = 'Остановить демонстрацию';
        document.getElementById('screen-share-label').textContent = 'Остановить';
        showToast('Демонстрация экрана включена ✓');
    } catch (error) {
        if (error.name !== 'NotAllowedError') showToast('Не удалось включить демонстрацию экрана');
    }
}

async function stopScreenShare() {
    if (!appState.screenSharing) return;
    appState.screenTrack?.stop();
    appState.screenAudioTrack?.stop();
    appState.screenTrack = null;
    appState.screenAudioTrack = null;
    appState.screenSharing = false;
    for (const peer of appState.peerConnections.values()) {
        const sender = getVideoSender(peer);
        if (sender) {
            await sender.replaceTrack(appState.cameraTrack || null);
            if (!appState.cameraTrack) {
                const transceiver = peer.getTransceivers().find(item => item.sender === sender);
                if (transceiver) transceiver.direction = 'recvonly';
            }
        }
        peer.getSenders()
            .filter(item => item.track?.kind === 'audio' && item.track !== appState.voiceStream?.getAudioTracks()[0])
            .forEach(item => peer.removeTrack(item));
    }
    const localVideo = document.getElementById('voice-local-video');
    localVideo.srcObject = appState.cameraTrack ? appState.voiceStream : null;
    if (!appState.cameraTrack) document.getElementById('voice-video-grid').classList.add('hidden');
    await renegotiateVoicePeers();
    const button = document.getElementById('screen-share-btn');
    button.classList.remove('active');
    button.title = 'Показать экран';
    document.getElementById('screen-share-label').textContent = 'Экран';
    showToast('Демонстрация экрана остановлена');
}

async function renegotiateVoicePeers() {
    for (const socketId of appState.peerConnections.keys()) await createVoiceOffer(socketId);
}

function getVideoSender(peer) {
    const directSender = peer.getSenders().find(sender => sender.track?.kind === 'video');
    if (directSender) return directSender;
    return peer.getTransceivers().find(transceiver => transceiver.receiver.track?.kind === 'video')?.sender || null;
}

async function getVoicePeer(socketId) {
    if (appState.peerConnections.has(socketId)) return appState.peerConnections.get(socketId);
    const peer = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        iceCandidatePoolSize: 10
    });
    const localVideoTrack = appState.voiceStream?.getVideoTracks()[0];
    appState.voiceStream?.getAudioTracks().forEach(track => peer.addTrack(track, appState.voiceStream));
    if (localVideoTrack) {
        peer.addTrack(localVideoTrack, appState.voiceStream);
    } else {
        peer.addTransceiver('video', { direction: 'recvonly' });
    }
    const audioSender = peer.getSenders().find(sender => sender.track?.kind === 'audio');
    if (audioSender) {
        const parameters = audioSender.getParameters();
        parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
        parameters.encodings[0].maxBitrate = 64000;
        parameters.encodings[0].dtx = 'disabled';
        await audioSender.setParameters(parameters).catch(() => {});
    }
    peer.onicecandidate = event => {
        if (event.candidate) socket.emit('voice-ice-candidate', { target: socketId, candidate: event.candidate });
    };
    peer.ontrack = event => {
        let remoteStream = appState.remoteStreams.get(socketId);
        if (!remoteStream) {
            remoteStream = new MediaStream();
            appState.remoteStreams.set(socketId, remoteStream);
        }
        if (!remoteStream.getTracks().some(track => track.id === event.track.id)) remoteStream.addTrack(event.track);
        let audio = document.getElementById(`voice-audio-${socketId}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `voice-audio-${socketId}`;
            audio.autoplay = true;
            document.body.appendChild(audio);
        }
        audio.srcObject = remoteStream;
        if (event.track.kind === 'video') {
            document.getElementById('voice-video-grid')?.classList.remove('hidden');
            let video = document.getElementById(`voice-video-${socketId}`);
            if (!video) {
                video = document.createElement('video');
                video.id = `voice-video-${socketId}`;
                video.autoplay = true;
                video.playsInline = true;
                document.getElementById('voice-remote-videos')?.appendChild(video);
            }
            video.srcObject = remoteStream;
        }
    };
    appState.peerConnections.set(socketId, peer);
    return peer;
}

async function flushVoiceIceCandidates(socketId, peer) {
    const pending = appState.pendingVoiceCandidates.get(socketId) || [];
    for (const candidate of pending) await peer.addIceCandidate(candidate);
    appState.pendingVoiceCandidates.delete(socketId);
    appState.remoteStreams.delete(socketId);
}

async function createVoiceOffer(socketId) {
    const peer = await getVoicePeer(socketId);
    if (peer.signalingState !== 'stable') return;
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit('voice-offer', { target: socketId, offer });
}

function closeVoicePeer(socketId) {
    const peer = appState.peerConnections.get(socketId);
    if (peer) peer.close();
    appState.peerConnections.delete(socketId);
    appState.pendingVoiceCandidates.delete(socketId);
    document.getElementById(`voice-audio-${socketId}`)?.remove();
    document.getElementById(`voice-video-${socketId}`)?.remove();
}

function leaveVoiceCall() {
    document.getElementById('voice-call-panel')?.classList.add('hidden');
    document.getElementById('voice-leave-btn')?.classList.add('hidden');
    document.getElementById('voice-call-btn')?.classList.remove('hidden');
    document.getElementById('video-call-btn')?.classList.remove('hidden');
    const hadVoiceRoom = Boolean(appState.voiceRoom);
    if (hadVoiceRoom) socket.emit('voice-leave');
    appState.peerConnections.forEach((peer, socketId) => closeVoicePeer(socketId));
    appState.voiceStream?.getTracks().forEach(track => track.stop());
    appState.screenTrack?.stop();
    appState.screenAudioTrack?.stop();
    appState.voiceStream = null;
    appState.voiceRoom = null;
    appState.voiceParticipants.clear();
    appState.pendingVoiceCandidates.clear();
    appState.remoteStreams.clear();
    appState.voiceCallStartedAt = null;
    clearInterval(appState.voiceCallTimer);
    appState.voiceCallTimer = null;
    appState.voiceMuted = false;
    appState.videoEnabled = false;
    appState.cameraTrack = null;
    appState.screenTrack = null;
    appState.screenAudioTrack = null;
    appState.screenSharing = false;
    const screenButton = document.getElementById('screen-share-btn');
    screenButton.classList.remove('active');
    screenButton.title = 'Показать экран';
    document.getElementById('screen-share-label').textContent = 'Экран';
    const muteButton = document.getElementById('voice-mute-btn');
    muteButton.classList.remove('muted');
    muteButton.setAttribute('aria-pressed', 'false');
    muteButton.title = 'Выключить микрофон';
    muteButton.innerHTML = '<i class="fas fa-microphone"></i><span id="voice-mute-label">Микрофон</span>';
    document.getElementById('voice-local-video').srcObject = null;
    document.getElementById('voice-video-grid').classList.add('hidden');
    const videoButton = document.getElementById('voice-video-btn');
    videoButton?.classList.remove('active');
    videoButton?.setAttribute('aria-pressed', 'false');
    if (videoButton) {
        videoButton.title = 'Включить видео';
        videoButton.querySelector('i').className = 'fas fa-video';
    }
    const outputButton = document.getElementById('voice-output-btn');
    outputButton?.classList.remove('active');
    outputButton?.setAttribute('aria-pressed', 'false');
    document.getElementById('voice-remote-videos').innerHTML = '';
    if (hadVoiceRoom) showToast('Вы вышли из голосового звонка');
}

// ===== КОНТАКТЫ =====
function openAddContactDialog() {
    openModal({
        title: 'Новая заявка',
        description: 'Введите username зарегистрированного пользователя.',
        confirmText: 'Отправить',
        icon: 'fa-user-plus',
        input: true
    }).then(username => {
        if (username && username.trim()) addContact(username.trim());
    });
}

async function addContact(username) {
    try {
        const response = await fetch(`${API_URL}/api/requests/${encodeURIComponent(appState.currentUser.username)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipientUsername: username })
        });

        const data = await response.json();

        if (response.ok) {
            showToast(`Заявка для @${username} отправлена ✓`);
        } else {
            showToast(`Ошибка: ${data.error}`);
        }
    } catch (error) {
        console.error('Ошибка добавления контакта:', error);
        showToast('Ошибка добавления контакта');
    }
}

function openDirectMessage(username) {
    if (appState.voiceRoom) leaveVoiceCall();
    appState.currentDMUser = username;

    // Закрываем канал
    document.querySelectorAll('.channel-item').forEach(item => {
        item.classList.remove('active');
    });

    // Обновляем заголовок
    document.getElementById('channel-name').textContent = username;
    document.getElementById('channel-desc').textContent = 'Прямое сообщение';
    updateBlockButton(username);
    updateMessageInputState();
    
    // Очищаем сообщения
    const messagesArea = document.getElementById('messages-area');
    document.getElementById('message-input').placeholder = `Сообщение для @${username}`;
    loadDirectMessages(username);
}

async function loadDirectMessages(username) {
    try {
        const response = await fetch(`${API_URL}/api/dms/${encodeURIComponent(appState.currentUser.username)}/${encodeURIComponent(username)}/messages`, {
            credentials: 'include'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(data)) {
            if (response.status === 401) throw new Error('Сессия истекла. Войдите в аккаунт заново.');
            throw new Error(data.error || `Сервер вернул ошибку ${response.status}`);
        }
        const messages = data;
        const messagesArea = document.getElementById('messages-area');
        messagesArea.innerHTML = '';

        if (!messages.length) {
            messagesArea.innerHTML = `<div class="empty-chat"><i class="fas fa-comments"></i><p>Начните чат с @${escapeHtml(username)}</p><span>Ваши сообщения будут сохранены здесь.</span></div>`;
        } else {
            const group = document.createElement('div');
            group.className = 'message-group';
            messages.forEach(message => group.appendChild(createMessageElement(message, `dm:${username}`)));
            messagesArea.appendChild(group);
            scrollToBottom();
        }
        document.getElementById('msg-count').textContent = messages.length;
    } catch (error) {
        console.error('Ошибка загрузки личных сообщений:', error);
        showToast(error.message || 'Не удалось загрузить чат');
    }
}

// ===== ПЕРЕКЛЮЧЕНИЕ КАНАЛА =====
function switchChannel(channel) {
    if (appState.voiceRoom) leaveVoiceCall();
    appState.currentChannel = channel;
    appState.currentDMUser = null;
    document.getElementById('block-user-btn').classList.add('hidden');

    document.querySelectorAll('.channel-item').forEach(item => {
        item.classList.remove('active');
    });
    document.querySelectorAll(`[data-channel="${channel}"]`).forEach(item => item.classList.add('active'));

    const channelInfo = appState.channels[channel];
    document.getElementById('channel-name').textContent = channelInfo.name;
    const subscriberCount = channelInfo.subscriberCount ?? (channelInfo.members || []).length;
    document.getElementById('channel-desc').textContent = `${channelInfo.description} • Подписчики: ${subscriberCount}`;
    const avatar = document.getElementById('channel-avatar');
    avatar.className = channelInfo.avatar ? 'chat-icon has-channel-image' : `chat-icon fas ${channelInfo.isGroup ? 'fa-users' : 'fa-hashtag'}`;
    avatar.innerHTML = channelInfo.avatar ? `<img src="${escapeHtml(channelInfo.avatar)}" alt="">` : '';
    updateContainerActions(channel);
    document.getElementById('message-input').placeholder = 'Напишите сообщение...';
    updateMessageInputState();

    loadMessages(channel);
}

async function toggleBlockCurrentUser() {
    if (!appState.currentDMUser) return;
    const blocked = (appState.currentUser.blockedUsers || []).includes(appState.currentDMUser);
    const response = await fetch(`${API_URL}/api/users/${encodeURIComponent(appState.currentDMUser)}/block`, { method: blocked ? 'DELETE' : 'POST', credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || (blocked ? 'Не удалось разблокировать пользователя' : 'Не удалось заблокировать пользователя'));
    appState.currentUser.blockedUsers = data.blocked || [];
    localStorage.setItem('currentUser', JSON.stringify(appState.currentUser));
    updateBlockButton(appState.currentDMUser);
    showToast(blocked ? 'Пользователь разблокирован ✓' : 'Пользователь заблокирован ✓');
    if (blocked) loadDirectMessages(appState.currentDMUser);
    else document.getElementById('messages-area').innerHTML = '<div class="empty-chat"><i class="fas fa-user-slash"></i><p>Пользователь заблокирован</p></div>';
}

function updateBlockButton(username) {
    const button = document.getElementById('block-user-btn');
    if (!button) return;
    const blocked = (appState.currentUser?.blockedUsers || []).includes(username);
    button.classList.remove('hidden');
    button.title = blocked ? 'Разблокировать пользователя' : 'Заблокировать пользователя';
    button.innerHTML = `<i class="fas ${blocked ? 'fa-user-check' : 'fa-user-slash'}"></i>`;
}

async function showDesktopNotification(title, body, username) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return;
    const notification = new Notification(title, { body, icon: '/favicon.ico' });
    notification.onclick = () => { window.focus(); if (username) openDirectMessage(username); notification.close(); };
}

function updateMessageInputState() {
    const selected = Boolean(appState.currentDMUser || appState.currentChannel);
    document.querySelectorAll('.message-input-area').forEach(area => area.classList.toggle('hidden', !selected));
    const input = document.getElementById('message-input');
    if (!input) return;
    input.disabled = !selected;
    input.placeholder = selected
        ? (appState.currentDMUser ? `Сообщение для @${appState.currentDMUser}` : 'Напишите сообщение...')
        : 'Сначала выберите чат';
    document.querySelector('.input-wrapper .fa-paper-plane')?.parentElement.toggleAttribute('disabled', !selected);
}

function updateContainerActions(channelId) {
    const channel = appState.channels[channelId];
    const manageable = channel && appState.currentUser?.username === 'Deverlope';
    document.getElementById('channel-settings-btn').classList.toggle('hidden', !manageable);
    document.getElementById('channel-delete-btn').classList.toggle('hidden', !manageable);
}

async function openContainerSettings() {
    const channelId = appState.currentChannel;
    const channel = appState.channels[channelId];
    if (!channel) return;
    const name = await openModal({
        title: `${channel.isGroup ? 'Группа' : 'Канал'}: ${channel.name}`,
        description: `Участников: ${(channel.members || []).length}. Введите новое название.`,
        value: channel.name,
        confirmText: 'Сохранить',
        cancelText: 'Закрыть',
        icon: channel.isGroup ? 'fa-users' : 'fa-hashtag',
        input: true
    });
    if (!name || !name.trim()) return;
    const avatar = await chooseContainerAvatar();
    const response = await fetch(`${API_URL}/api/containers/${channelId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), avatar: avatar === undefined ? channel.avatar : avatar })
    });
    const data = await response.json();
    if (!response.ok) return showToast(data.error || 'Не удалось сохранить настройки');
    await loadChannels();
    if (appState.currentChannel === channelId) switchChannel(channelId);
    const username = await openModal({
        title: 'Участники',
        description: `Участников: ${(data.container.members || []).length}. Введите username для исключения или закройте окно.`,
        confirmText: 'Выгнать', cancelText: 'Готово', icon: 'fa-user-minus', input: true
    });
    if (!username || !username.trim()) return;
    const endpoint = channel.isGroup ? `/api/groups/${channelId}/kick` : `/api/channels/${channelId}/kick`;
    const kickResponse = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim() })
    });
    const kickData = await kickResponse.json();
    if (!kickResponse.ok) return showToast(kickData.error || 'Не удалось исключить участника');
    await loadChannels();
    showToast(`@${username.trim()} исключён ✓`);
}

function chooseContainerAvatar() {
    const input = document.getElementById('container-avatar-upload');
    input.value = '';
    return new Promise(resolve => {
        const finish = value => {
            input.removeEventListener('change', onChange);
            resolve(value);
        };
        const onChange = () => {
            const file = input.files?.[0];
            if (!file) return finish(undefined);
            if (!file.type.startsWith('image/')) {
                showToast('Выберите изображение');
                return finish(undefined);
            }
            const reader = new FileReader();
            reader.onload = () => finish(reader.result);
            reader.readAsDataURL(file);
        };
        input.addEventListener('change', onChange, { once: false });
        input.click();
        setTimeout(() => finish(undefined), 15000);
    });
}

async function deleteCurrentContainer() {
    const channelId = appState.currentChannel;
    const channel = appState.channels[channelId];
    if (!channel) return;
    const confirmed = await openModal({
        title: `Удалить ${channel.isGroup ? 'группу' : 'канал'}?`,
        description: 'Все сообщения и участники будут удалены без возможности восстановления.',
        confirmText: 'Удалить', icon: 'fa-trash', danger: true
    });
    if (!confirmed) return;
    const endpoint = channel.isGroup ? `/api/groups/${channelId}` : `/api/channels/${channelId}`;
    const response = await fetch(`${API_URL}${endpoint}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) return showToast(data.error || 'Не удалось удалить');
    await loadChannels();
    const firstChannel = Object.keys(appState.channels)[0];
    if (firstChannel) switchChannel(firstChannel);
    showToast(`${channel.isGroup ? 'Группа' : 'Канал'} удалён ✓`);
}

function handleProfileAvatarUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        showToast('Выберите изображение');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        const dataUrl = reader.result;
        document.getElementById('profile-avatar-input').value = dataUrl;
        updateProfileAvatarPreview(dataUrl);
        showToast('Фото для аватарки выбрано ✓');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

async function openProfileDialog() {
    const modal = document.getElementById('profile-modal');
    document.getElementById('profile-username-input').value = appState.currentUser.username;
    document.getElementById('profile-avatar-input').value = appState.currentUser.avatar;
    updateProfileAvatarPreview(appState.currentUser.avatar);
    document.getElementById('profile-password-input').value = '';
    modal.classList.remove('hidden');
}

function updateProfileAvatarPreview(avatar) {
    const preview = document.getElementById('profile-avatar-preview');
    if (!preview) return;
    applyAvatarToElement(preview, avatar, appState.currentUser?.username?.[0] || 'П');
}

async function saveProfile() {
    const username = document.getElementById('profile-username-input').value.trim();
    const avatarInput = document.getElementById('profile-avatar-input').value.trim();
    const avatar = avatarInput && avatarInput.startsWith('data:image') ? avatarInput : (avatarInput || appState.currentUser.avatar);
    const password = document.getElementById('profile-password-input').value;
    try {
        const response = await fetch(`${API_URL}/api/user/${encodeURIComponent(appState.currentUser.username)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, avatar, password })
        });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Не удалось сохранить профиль');
        appState.currentUser = data.user;
        localStorage.setItem('currentUser', JSON.stringify(data.user));
        document.getElementById('profile-modal').classList.add('hidden');
        updateCurrentUserUI();
        showToast('Профиль обновлен ✓');
    } catch (error) {
        console.error('Ошибка обновления профиля:', error);
        showToast('Не удалось сохранить профиль');
    }
}

function updateCurrentUserUI() {
    document.getElementById('user-username').textContent = appState.currentUser.username;
    document.getElementById('user-username').classList.toggle('premium-user', Boolean(appState.currentUser.premium));

    applyAvatarToElement(document.getElementById('user-avatar'), appState.currentUser.avatar, appState.currentUser.username ? appState.currentUser.username[0] : '?');
    applyAvatarToElement(document.getElementById('left-user-avatar'), appState.currentUser.avatar, appState.currentUser.username ? appState.currentUser.username[0] : '?');

    document.getElementById('left-user-username').textContent = appState.currentUser.username;
    document.getElementById('left-user-username').classList.toggle('premium-user', Boolean(appState.currentUser.premium));
}

// ===== ВЫХОД =====
function logout() {
    openModal({
        title: 'Выйти из аккаунта?',
        description: 'Вы действительно хотите выйти из аккаунта?',
        confirmText: 'Выйти',
        icon: 'fa-sign-out-alt',
        danger: true
    }).then(confirmed => {
        if (!confirmed) return;
        fetch(`${API_URL}/api/auth/logout`, { method: 'POST' }).catch(console.error);
        localStorage.removeItem('currentUser');
        localStorage.removeItem('pulscord_session_token');
        appState.currentUser = null;
        socket.emit('user-logout');
        
        document.getElementById('auth-screen').classList.remove('hidden');
        document.getElementById('app-screen').classList.add('hidden');
        
        document.getElementById('login-form').reset();
        document.getElementById('register-form').reset();
    });
}

// ===== УТИЛИТЫ =====
function openModal({ title, description, value = '', confirmText = 'Подтвердить', cancelText = 'Отмена', cancelValue = null, icon = 'fa-circle-question', danger = false, input: requiresInput = false }) {
    const modal = document.getElementById('app-modal');
    const input = document.getElementById('modal-input');
    const confirmButton = document.getElementById('modal-confirm');
    const cancelButton = document.getElementById('modal-cancel');
    const iconElement = document.getElementById('modal-icon').querySelector('i');

    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-description').textContent = description;
    input.value = value;
    input.classList.toggle('hidden', !requiresInput);
    confirmButton.textContent = confirmText;
    cancelButton.textContent = cancelText;
    confirmButton.classList.toggle('danger', danger);
    iconElement.className = `fas ${icon}`;
    modal.classList.remove('hidden');

    return new Promise(resolve => {
        const close = result => {
            modal.classList.add('hidden');
            confirmButton.removeEventListener('click', onConfirm);
            cancelButton.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKeydown);
            resolve(result);
        };
        const onConfirm = () => close(input.classList.contains('hidden') ? true : input.value);
        const onCancel = () => close(cancelValue);
        const onDismiss = () => close(null);
        const onBackdrop = event => {
            if (event.target === modal) onDismiss();
        };
        const onKeydown = event => {
            if (event.key === 'Escape') onDismiss();
            if (event.key === 'Enter' && document.activeElement === input) onConfirm();
        };

        confirmButton.addEventListener('click', onConfirm);
        cancelButton.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKeydown);
        if (!input.classList.contains('hidden')) {
            input.focus();
            input.select();
        } else {
            confirmButton.focus();
        }
    });
}

function scrollToBottom() {
    const messagesArea = document.getElementById('messages-area');
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: var(--primary-color);
        color: white;
        padding: 12px 20px;
        border-radius: 4px;
        z-index: 1000;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateOnlineUsers() {
    document.getElementById('online-stat').textContent = appState.onlineUsers.size;
}

function updateTime() {
    const now = new Date();
    const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('time-stat').textContent = time;
}

// Добавляем CSS анимации
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(400px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(400px); opacity: 0; }
    }
`;
document.head.appendChild(style);
