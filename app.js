// Конфигурация приложения
const APP_CONFIG = {
    servers: {
        'home': { name: 'Главная', icon: '🏠' },
        'server-1': { name: 'Основной сервер', icon: 'O' },
        'server-2': { name: 'Друзья', icon: 'Д' },
        'server-3': { name: 'Проекты', icon: 'П' }
    },
    channels: {
        'general': { name: 'общее', description: 'Основной канал для обсуждения', icon: '#' },
        'announcements': { name: 'объявления', description: 'Важные объявления', icon: '#' },
        'random': { name: 'случайное', description: 'Случайные темы', icon: '#' },
        'events': { name: 'события', description: 'События и мероприятия', icon: '#' }
    },
    users: {
        'user-1': { name: 'Алексей', role: 'Модератор', avatar: 'А', status: 'online' },
        'user-2': { name: 'Мария', role: 'Участник', avatar: 'М', status: 'offline' },
        'user-3': { name: 'Иван', role: 'Участник', avatar: 'И', status: 'online' },
        'user-4': { name: 'Елена', role: 'Участник', avatar: 'Е', status: 'offline' }
    }
};

// Состояние приложения
let appState = {
    currentServer: 'home',
    currentChannel: 'general',
    currentDM: null,
    currentUser: 'Ты',
    messages: {
        'general': [],
        'announcements': [],
        'random': [],
        'events': []
    },
    dmMessages: {
        'user-1': [],
        'user-2': [],
        'user-3': [],
        'user-4': []
    }
};

let pendingImageData = null;

// ===== Инициализация =====
document.addEventListener('DOMContentLoaded', () => {
    // Загружаем сохраненное состояние
    loadState();
    
    // Инициализируем обработчики
    initializeEventListeners();
    
    // Загружаем первый канал
    loadChannel('general');
    
    // Просим разрешение на уведомления
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    
    console.log('✓ Pulscord инициализирован');
});

// ===== Обработчики событий =====
function initializeEventListeners() {
    // Серверы
    document.querySelectorAll('.server-icon').forEach(icon => {
        icon.addEventListener('click', (e) => handleServerClick(e.currentTarget));
    });

    // Каналы
    document.querySelectorAll('.channel-item').forEach(item => {
        item.addEventListener('click', (e) => handleChannelClick(e.currentTarget));
    });

    // Прямые сообщения
    document.querySelectorAll('.dm-item').forEach(item => {
        item.addEventListener('click', (e) => handleDMClick(e.currentTarget));
    });

    // Отправка сообщения
    const messageInput = document.getElementById('message-input');
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Кнопка отправки
    document.querySelectorAll('.input-button').forEach((btn, index) => {
        if (index === 3) { // Последняя кнопка - отправка
            btn.addEventListener('click', sendMessage);
        }
    });

    document.getElementById('attach-image-btn').addEventListener('click', () => {
        document.getElementById('image-upload').click();
    });

    document.getElementById('image-upload').addEventListener('change', handleImageUpload);

    // Быстрые действия
    document.querySelectorAll('.server-add button')[0]?.addEventListener('click', addServer);
    document.querySelectorAll('.section-header button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const sectionType = btn.parentElement.textContent.includes('КАНАЛ') ? 'channel' : 'dm';
            console.log(`Добавить ${sectionType}`);
        });
    });

    // Кнопки в заголовке чата
    document.querySelectorAll('.header-right button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const icon = btn.querySelector('i').className;
            console.log('Действие:', icon);
        });
    });

    // Кнопки профиля
    document.querySelectorAll('.user-actions button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const icon = btn.querySelector('i').className;
            console.log('Действие профиля:', icon);
        });
    });

    // Члены канала
    document.querySelectorAll('.member-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const memberName = item.querySelector('.member-info p').textContent;
            console.log('Выбран участник:', memberName);
        });
    });
}

// ===== Обработчики кликов =====
function handleServerClick(element) {
    // Удаляем активный класс с других серверов
    document.querySelectorAll('.server-icon').forEach(icon => {
        icon.classList.remove('active');
    });

    // Добавляем активный класс текущему серверу
    element.classList.add('active');

    const serverId = element.dataset.server;
    appState.currentServer = serverId;

    // Обновляем название сервера
    const serverName = APP_CONFIG.servers[serverId]?.name || 'Сервер';
    document.getElementById('server-name').textContent = serverName;

    // Загружаем первый канал сервера
    loadChannel('general');
}

function handleChannelClick(element) {
    // Удаляем активный класс с других каналов
    document.querySelectorAll('.channel-item, .dm-item').forEach(item => {
        item.classList.remove('active');
    });

    // Добавляем активный класс текущему каналу
    element.classList.add('active');

    const channelId = element.dataset.channel;
    appState.currentChannel = channelId;
    appState.currentDM = null;

    loadChannel(channelId);
}

function handleDMClick(element) {
    // Удаляем активный класс с других элементов
    document.querySelectorAll('.channel-item, .dm-item').forEach(item => {
        item.classList.remove('active');
    });

    // Добавляем активный класс текущему ДМ
    element.classList.add('active');

    const userId = element.dataset.dm;
    appState.currentDM = userId;

    const user = APP_CONFIG.users[userId];
    updateChatHeader(user.name, `Прямой чат с ${user.name}`, user.avatar);
    loadDMMessages(userId);
}

// ===== Загрузка данных =====
function loadChannel(channelId) {
    const channel = APP_CONFIG.channels[channelId];
    if (!channel) return;

    updateChatHeader(channel.name, channel.description, channel.icon);
    loadMessages(channelId);
}

function updateChatHeader(name, description, icon) {
    const chatIcon = document.querySelector('.chat-icon');
    const channelName = document.getElementById('channel-name');
    const channelDesc = document.getElementById('channel-desc');

    if (icon === '#') {
        chatIcon.innerHTML = '<i class="fas fa-hashtag"></i>';
    } else {
        chatIcon.innerHTML = `<span style="font-size: 16px;">${icon}</span>`;
    }

    channelName.textContent = name;
    channelDesc.textContent = description;

    // Обновляем плейсхолдер инпута
    document.getElementById('message-input').placeholder = `Напишите сообщение @${name}`;
}

function loadMessages(channelId) {
    const messagesArea = document.getElementById('messages-area');
    const messages = appState.messages[channelId] || [];

    messagesArea.innerHTML = '';

    if (messages.length === 0) {
        messagesArea.innerHTML = `
            <div style="padding: 40px 20px; text-align: center; color: var(--text-muted); display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
                <i style="font-size: 48px; opacity: 0.3; margin-bottom: 16px;" class="fas fa-comments"></i>
                <p style="font-size: 16px;">Еще нет сообщений</p>
                <p style="font-size: 13px; margin-top: 8px;">Начните разговор! Напишите первое сообщение.</p>
            </div>
        `;
        return;
    }

    const messageGroup = document.createElement('div');
    messageGroup.className = 'message-group';

    messages.forEach((msg, index) => {
        const messageEl = document.createElement('div');
        messageEl.className = `message ${msg.own ? 'own-message' : ''}`;
        messageEl.id = `msg-${msg.id}`;

        const textHtml = msg.text ? `<div class="message-text">${escapeHtml(msg.text)}</div>` : '';
        const imageHtml = msg.image ? `<img class="message-image" src="${msg.image}" alt="Фото в сообщении">` : '';

        messageEl.innerHTML = `
            <div class="avatar">${msg.avatar}</div>
            <div class="message-content">
                <div class="message-header">
                    <span class="username">${msg.author}</span>
                    <span class="timestamp">${msg.timestamp}</span>
                </div>
                ${imageHtml}
                ${textHtml}
                <div class="message-actions" style="margin-top: 4px; font-size: 12px;">
                    ${msg.own ? `
                        <button class="msg-btn edit-btn" data-id="${msg.id}">✏️ Редактировать</button>
                        <button class="msg-btn delete-btn" data-id="${msg.id}">🗑️ Удалить</button>
                    ` : ''}
                </div>
            </div>
        `;
        messageGroup.appendChild(messageEl);

        if (msg.own) {
            messageEl.querySelector('.edit-btn')?.addEventListener('click', () => editMessage(msg.id, channelId));
            messageEl.querySelector('.delete-btn')?.addEventListener('click', () => deleteMessage(msg.id, channelId));
        }
    });

    messagesArea.appendChild(messageGroup);
    scrollToBottom();
}

function loadDMMessages(userId) {
    const messagesArea = document.getElementById('messages-area');
    const messages = appState.dmMessages[userId] || [];

    messagesArea.innerHTML = '';

    if (messages.length === 0) {
        const user = APP_CONFIG.users[userId];
        messagesArea.innerHTML = `
            <div style="padding: 40px 20px; text-align: center; color: var(--text-muted); display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
                <i style="font-size: 48px; opacity: 0.3; margin-bottom: 16px;" class="fas fa-envelope"></i>
                <p style="font-size: 16px;">Начните разговор с ${user.name}</p>
                <p style="font-size: 13px; margin-top: 8px;">Отправьте первое сообщение и начните разговор!</p>
            </div>
        `;
        return;
    }

    const messageGroup = document.createElement('div');
    messageGroup.className = 'message-group';

    messages.forEach(msg => {
        const messageEl = document.createElement('div');
        messageEl.className = `message ${msg.own ? 'own-message' : ''}`;
        messageEl.id = `msg-${msg.id}`;

        const textHtml = msg.text ? `<div class="message-text">${escapeHtml(msg.text)}</div>` : '';
        const imageHtml = msg.image ? `<img class="message-image" src="${msg.image}" alt="Фото в сообщении">` : '';

        messageEl.innerHTML = `
            <div class="avatar">${msg.avatar}</div>
            <div class="message-content">
                <div class="message-header">
                    <span class="username">${msg.author}</span>
                    <span class="timestamp">${msg.timestamp}</span>
                </div>
                ${imageHtml}
                ${textHtml}
                <div class="message-actions" style="margin-top: 4px; font-size: 12px;">
                    ${msg.own ? `
                        <button class="msg-btn edit-btn" data-id="${msg.id}" data-user="${userId}">✏️ Редактировать</button>
                        <button class="msg-btn delete-btn" data-id="${msg.id}" data-user="${userId}">🗑️ Удалить</button>
                    ` : ''}
                </div>
            </div>
        `;
        messageGroup.appendChild(messageEl);

        if (msg.own) {
            messageEl.querySelector('.edit-btn')?.addEventListener('click', () => editDMMessage(msg.id, userId));
            messageEl.querySelector('.delete-btn')?.addEventListener('click', () => deleteDMMessage(msg.id, userId));
        }
    });

    messagesArea.appendChild(messageGroup);
    scrollToBottom();
}

// ===== Отправка сообщения =====
function handleImageUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        alert('Выберите изображение');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        pendingImageData = reader.result;
        const input = document.getElementById('message-input');
        input.focus();
        input.placeholder = 'Фото прикреплено. Нажмите Enter, чтобы отправить';
        setTimeout(() => {
            input.placeholder = `Напишите сообщение @${document.getElementById('channel-name').textContent.trim()}`;
        }, 1600);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    const image = pendingImageData;

    if (!text && !image) return;

    const message = {
        id: Date.now(),
        author: appState.currentUser,
        avatar: 'Т',
        timestamp: getCurrentTime(),
        text: text,
        image: image || null,
        own: true,
        edited: false
    };

    const channelId = appState.currentChannel;

    if (appState.currentDM) {
        if (!appState.dmMessages[appState.currentDM]) {
            appState.dmMessages[appState.currentDM] = [];
        }
        appState.dmMessages[appState.currentDM].push(message);
        loadDMMessages(appState.currentDM);
    } else {
        if (channelId && appState.messages[channelId]) {
            appState.messages[channelId].push(message);
        }
        loadMessages(channelId);
    }

    input.value = '';
    input.style.height = 'auto';
    pendingImageData = null;

    saveState();
    showNotification('Pulscord', image ? 'Фото отправлено ✓' : 'Сообщение отправлено ✓');
}

// ===== Редактирование сообщения =====
function editMessage(messageId, channelId) {
    const messages = appState.messages[channelId];
    const message = messages.find(m => m.id === messageId);
    
    if (!message) return;

    const newText = prompt('Отредактируйте сообщение:', message.text);
    if (newText && newText.trim()) {
        message.text = newText.trim();
        message.edited = true;
        message.timestamp = getCurrentTime() + ' (отредактировано)';
        loadMessages(channelId);
        saveState();
    }
}

// ===== Удаление сообщения =====
function deleteMessage(messageId, channelId) {
    if (!confirm('Вы уверены? Это действие необратимо.')) return;

    const messages = appState.messages[channelId];
    const index = messages.findIndex(m => m.id === messageId);
    
    if (index > -1) {
        messages.splice(index, 1);
        loadMessages(channelId);
        saveState();
        showNotification('Pulscord', 'Сообщение удалено ✓');
    }
}

// ===== Дополнительные действия =====
function addServer() {
    const serverName = prompt('Введите название сервера:');
    if (serverName) {
        showNotification('Pulscord', `Сервер "${serverName}" добавлен! ✓`);
    }
}

// ===== Сохранение состояния =====
function saveState() {
    localStorage.setItem('pulscord_state', JSON.stringify(appState));
    console.log('✓ Состояние сохранено');
}

// ===== Загрузка состояния =====
function loadState() {
    const savedState = localStorage.getItem('pulscord_state');
    if (savedState) {
        try {
            const state = JSON.parse(savedState);
            Object.assign(appState, state);
            console.log('✓ Состояние загружено');
            return true;
        } catch (e) {
            console.log('Ошибка при загрузке состояния');
            return false;
        }
    }
    return false;
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    return `Сегодня в ${hours}:${minutes}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollToBottom() {
    const messagesArea = document.getElementById('messages-area');
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

// ===== Улучшенный инпут (автоизменение высоты) =====
document.getElementById('message-input').addEventListener('input', function() {
    this.style.height = 'auto';
    const maxHeight = 100;
    const newHeight = Math.min(this.scrollHeight, maxHeight);
    this.style.height = newHeight + 'px';
});

// ===== Эмодзи и форматирование =====
document.getElementById('message-input').addEventListener('keydown', function(e) {
    // Поддержка Ctrl+B для жирного текста (можно расширить)
    if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        console.log('Жирный текст (демонстрация)');
    }
});

// ===== Поиск =====
document.querySelector('.search-box input').addEventListener('input', function(e) {
    const searchText = e.target.value.toLowerCase();
    const channels = document.querySelectorAll('.channel-item, .dm-item');

    channels.forEach(channel => {
        const text = channel.textContent.toLowerCase();
        if (text.includes(searchText)) {
            channel.style.display = '';
        } else {
            channel.style.display = 'none';
        }
    });
});

// ===== Статус пользователя (демонстрация) =====
function updateUserStatus(status) {
    const statusElement = document.querySelector('.status-text');
    if (statusElement) {
        const statusTexts = {
            'online': '🟢 Активен',
            'idle': '🟡 Отсутствует',
            'dnd': '🔴 Не беспокоить',
            'offline': '⚫ Оффлайн'
        };
        statusElement.textContent = statusTexts[status] || statusTexts['online'];
    }
}

// ===== Редактирование ДМ сообщения =====
function editDMMessage(messageId, userId) {
    const messages = appState.dmMessages[userId];
    const message = messages.find(m => m.id === messageId);
    
    if (!message) return;

    const newText = prompt('Отредактируйте сообщение:', message.text);
    if (newText && newText.trim()) {
        message.text = newText.trim();
        message.edited = true;
        message.timestamp = getCurrentTime() + ' (отредактировано)';
        loadDMMessages(userId);
        saveState();
    }
}

// ===== Удаление ДМ сообщения =====
function deleteDMMessage(messageId, userId) {
    if (!confirm('Вы уверены? Это действие необратимо.')) return;

    const messages = appState.dmMessages[userId];
    const index = messages.findIndex(m => m.id === messageId);
    
    if (index > -1) {
        messages.splice(index, 1);
        loadDMMessages(userId);
        saveState();
        showNotification('Pulscord', 'Сообщение удалено ✓');
    }
}

// Запросить разрешение на уведомления
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

// ===== Контекстное меню (демонстрация) =====
document.addEventListener('contextmenu', function(e) {
    const channel = e.target.closest('.channel-item');
    const dm = e.target.closest('.dm-item');

    if (channel || dm) {
        e.preventDefault();
        console.log('Контекстное меню');
    }
});

// ===== Синхронизация состояния =====
window.addEventListener('beforeunload', () => {
    saveState();
});

// ===== Горячие клавиши =====
document.addEventListener('keydown', (e) => {
    const input = document.getElementById('message-input');
    
    // Ctrl+Enter - быстрая отправка
    if (e.ctrlKey && e.key === 'Enter' && document.activeElement === input) {
        e.preventDefault();
        sendMessage();
    }
    
    // Ctrl+K - поиск (планируется)
    if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        console.log('Открыть поиск');
    }
});

// ===== Интеграция с поиском =====
document.querySelector('.search-box input').addEventListener('input', function(e) {
    const searchText = e.target.value.toLowerCase();
    const channels = document.querySelectorAll('.channel-item, .dm-item');

    channels.forEach(channel => {
        const text = channel.textContent.toLowerCase();
        if (text.includes(searchText)) {
            channel.style.display = '';
        } else {
            channel.style.display = 'none';
        }
    });
});

// ===== Добавим CSS для анимаций =====
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
    
    .msg-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0 4px;
        margin-right: 8px;
        transition: color 0.2s;
        font-size: 12px;
    }
    
    .msg-btn:hover {
        color: var(--primary-color);
    }
    
    .message:hover .message-actions {
        opacity: 1 !important;
    }
`;
document.head.appendChild(style);
