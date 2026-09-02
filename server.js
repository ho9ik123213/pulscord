const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const cors = require('cors');
const selfsigned = require('selfsigned');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

function getLocalIP() {
    const addresses = Object.values(os.networkInterfaces()).flat().filter(iface => iface && iface.family === 'IPv4' && !iface.internal).map(iface => iface.address);
    return addresses.find(address => address.startsWith('192.168.')) ||
        addresses.find(address => address.startsWith('26.')) ||
        addresses.find(address => address.startsWith('10.')) ||
        addresses.find(address => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) ||
        addresses[0] || 'localhost';
}

const localIP = getLocalIP();
const certificateIPs = [...new Set(['127.0.0.1', localIP, '192.168.3.6', '26.197.223.15'])];
const certificate = selfsigned.generate([
    { name: 'commonName', value: 'Pulscord Local' },
    { name: 'subjectAltName', value: 'localhost' }
], {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        ...certificateIPs.map(ip => ({ type: 7, ip }))
    ] }]
});
const secureServer = https.createServer({ key: certificate.private, cert: certificate.cert }, app);
const secureIo = socketIo(secureServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

function broadcastEvent(event, payload) {
    io.emit(event, payload);
    secureIo.emit(event, payload);
}

// Middleware
app.use(cors({
    origin: (origin, callback) => callback(null, origin || true),
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// Простая база данных (JSON файлы)
const dbDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Функции работы с БД
function loadJSON(filename) {
    const filepath = path.join(dbDir, filename);
    try {
        const contents = fs.readFileSync(filepath, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(contents);
    } catch (e) {
        return null;
    }
}

function saveJSON(filename, data) {
    const filepath = path.join(dbDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

function appendChannelMessage(channelId, author, text) {
    const users = loadJSON('users.json') || {};
    const messages = loadJSON('messages.json') || {};
    messages[channelId] = messages[channelId] || [];
    const message = { id: Date.now(), author, avatar: users[author]?.avatar || author[0].toUpperCase(), premium: Boolean(users[author]?.premium), developer: Boolean(users[author]?.developer), admin: Boolean(users[author]?.admin), text, image: null, audio: null, video: null, file: null, timestamp: new Date().toISOString(), edited: false };
    messages[channelId].push(message);
    saveJSON('messages.json', messages);
    broadcastEvent('message', { channel: channelId, message });
    return message;
}

function appendDirectMessage(firstUser, secondUser, text) {
    const users = loadJSON('users.json') || {};
    const directMessages = loadJSON('direct-messages.json') || {};
    const key = getDMKey(firstUser, secondUser);
    directMessages[key] = directMessages[key] || [];
    const message = { id: Date.now(), author: firstUser, avatar: users[firstUser]?.avatar || firstUser[0].toUpperCase(), premium: Boolean(users[firstUser]?.premium), developer: Boolean(users[firstUser]?.developer), admin: Boolean(users[firstUser]?.admin), text, image: null, audio: null, video: null, file: null, timestamp: new Date().toISOString(), edited: false };
    directMessages[key].push(message);
    saveJSON('direct-messages.json', directMessages);
    broadcastEvent('direct-message', { users: [firstUser, secondUser], message });
    return message;
}

function processScheduledMessages() {
    const scheduled = loadJSON('scheduled-messages.json') || [];
    const now = Date.now();
    const pending = [];
    scheduled.forEach(item => {
        if (new Date(item.sendAt).getTime() <= now) {
            if (item.type === 'dm') appendDirectMessage(item.author, item.recipient, item.text);
            else appendChannelMessage(item.channel, item.author, item.text);
        }
        else pending.push(item);
    });
    if (pending.length !== scheduled.length) saveJSON('scheduled-messages.json', pending);
}

function schoolAssistantResponse(command) {
    const input = String(command || '').trim().replace(/^\/school\s*/i, '').trim();
    if (!input || /^help|помощь$/i.test(input)) {
        return '🎓 Школьный помощник\nВыбери нужный раздел или напиши вопрос после /school.';
    }
    if (/^(time|время)$/i.test(input)) {
        return `🕒 Сейчас ${new Date().toLocaleString('ru-RU')}`;
    }
    if (/^(formula|формулы)$/i.test(input)) {
        return '📚 Формулы:\n• Площадь прямоугольника: S = a × b\n• Площадь треугольника: S = a × h / 2\n• Теорема Пифагора: c² = a² + b²\n• Скорость: v = s / t\n• Проценты: число × процент / 100';
    }
    const calculation = input.match(/^(?:calc|считай|посчитай)\s+(.+)$/i);
    if (calculation) {
        try {
            const expression = calculation[1].replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
            if (!/^[0-9+\-*/().^]+$/.test(expression) || expression.length > 100) throw new Error('invalid');
            const tokens = expression.match(/\d*\.?\d+|[()+\-*/^]/g) || [];
            let position = 0;
            const parsePrimary = () => {
                const token = tokens[position++];
                if (token === '(') { const value = parseAdditive(); if (tokens[position++] !== ')') throw new Error('invalid'); return value; }
                if (token === '-') return -parsePrimary();
                if (!token || !/^\d*\.?\d+$/.test(token)) throw new Error('invalid');
                return Number(token);
            };
            const parsePower = () => { const left = parsePrimary(); return tokens[position] === '^' ? (position++, Math.pow(left, parsePower())) : left; };
            const parseMultiplicative = () => { let value = parsePower(); while (['*', '/'].includes(tokens[position])) { const operator = tokens[position++]; const right = parsePower(); value = operator === '*' ? value * right : value / right; } return value; };
            const parseAdditive = () => { let value = parseMultiplicative(); while (['+', '-'].includes(tokens[position])) { const operator = tokens[position++]; const right = parseMultiplicative(); value = operator === '+' ? value + right : value - right; } return value; };
            const result = parseAdditive();
            if (position !== tokens.length || !Number.isFinite(result)) throw new Error('invalid');
            return `🧮 Ответ: ${Number(result.toFixed(10))}`;
        } catch {
            return '🧮 Не удалось посчитать. Пример: /school calc 12.5 * (8 - 3)';
        }
    }
    return `🎓 По теме «${input}» лучше уточнить предмет и класс. Я могу помочь с математикой, физикой, формулами и объяснением темы.`;
}

function createSchoolMessage(text, schoolMenu = false) {
    return {
        id: Date.now() + 1,
        author: 'School Assistant',
        avatar: '🎓',
        premium: false,
        developer: false,
        admin: false,
        bot: true,
        schoolMenu,
        text,
        image: null,
        audio: null,
        video: null,
        file: null,
        timestamp: new Date().toISOString(),
        edited: false
    };
}

function createBotMessage(botUser, text) {
    return { id: Date.now() + 1, author: botUser.username, avatar: botUser.avatar || '🤖', premium: false, developer: false, admin: false, bot: true, text, image: null, audio: null, video: null, file: null, timestamp: new Date().toISOString(), edited: false };
}

function getBotResponse(text, users) {
    const input = String(text || '').trim();
    if (!input) return null;

    const commandMatch = input.match(/^\/([^\s]+)(?:\s+(.*))?$/s);
    const command = commandMatch?.[1]?.toLowerCase();
    const commandText = commandMatch?.[2] || '';

    const botEntry = Object.entries(users).find(([, user]) => {
        if (!user || typeof user !== 'object' || !user.bot) return false;
        const triggerType = user.botTriggerType || 'command';
        if (triggerType === 'command') return typeof user.botCommand === 'string' && user.botCommand === command;
        if (triggerType === 'keyword') {
            const keyword = typeof user.botKeyword === 'string' ? user.botKeyword.trim() : '';
            return keyword && input.toLowerCase().includes(keyword.toLowerCase());
        }
        return false;
    });

    if (!botEntry) return null;

    const [username, botUser] = botEntry;
    if (!botUser || typeof botUser !== 'object') return null;

    const botBlocks = Array.isArray(botUser.botBlocks) ? botUser.botBlocks : [];
    const condition = botBlocks.find(block => block && typeof block === 'object' && block.type === 'condition');
    const conditionValue = condition && typeof condition.value === 'string' ? condition.value.trim() : '';
    if (conditionValue && !input.toLowerCase().includes(conditionValue.toLowerCase())) return null;

    const responseText = String(botUser.botResponse ?? '').replace(/\{text\}/gi, commandText || input).trim();
    if (!responseText) return null;

    return { username, message: createBotMessage({ ...botUser, username }, responseText) };
}

// Инициализация БД
function initDatabase() {
    const users = loadJSON('users.json') || {};
    if (!users['School Assistant']) {
        users['School Assistant'] = { avatar: '🎓', status: 'online', role: 'bot', premium: false, developer: false, admin: false, bot: true };
        saveJSON('users.json', users);
    }
    if (!loadJSON('messages.json')) {
        saveJSON('messages.json', {
            'announcements': [],
            'random': [],
            'events': []
        });
    }
    if (!loadJSON('scheduled-messages.json')) saveJSON('scheduled-messages.json', []);
    if (!loadJSON('direct-messages.json')) {
        saveJSON('direct-messages.json', {});
    }
    if (!loadJSON('channels.json')) {
        saveJSON('channels.json', {
            'announcements': { name: 'объявления', description: 'Объявления', created: new Date() },
            'random': { name: 'случайное', description: 'Случайные темы', created: new Date() },
            'events': { name: 'события', description: 'События', created: new Date() }
        });
    }
    const channels = loadJSON('channels.json') || {};
    const messages = loadJSON('messages.json') || {};
    if (channels.general) {
        delete channels.general;
        saveJSON('channels.json', channels);
    }
    if (messages.general) {
        delete messages.general;
        saveJSON('messages.json', messages);
    }
    if (!loadJSON('contacts.json')) {
        saveJSON('contacts.json', {});
    }
    if (!loadJSON('friend-requests.json')) {
        saveJSON('friend-requests.json', []);
    }
    if (!loadJSON('sessions.json')) {
        saveJSON('sessions.json', {});
    }
    if (!loadJSON('groups.json')) {
        saveJSON('groups.json', {});
    }
    if (!loadJSON('stories.json')) {
        saveJSON('stories.json', []);
    }

    const metadataUsers = loadJSON('users.json') || {};
    let changed = false;
    Object.values(metadataUsers).forEach(user => {
        if (typeof user.money !== 'number') { user.money = 0; changed = true; }
        if (typeof user.premium !== 'boolean') { user.premium = false; changed = true; }
        if (typeof user.developer !== 'boolean') { user.developer = false; changed = true; }
        if (typeof user.admin !== 'boolean') { user.admin = false; changed = true; }
    });
    if (metadataUsers.Deverlope) {
        if (metadataUsers.Deverlope.role !== 'admin') { metadataUsers.Deverlope.role = 'admin'; changed = true; }
        if (!metadataUsers.Deverlope.admin) { metadataUsers.Deverlope.admin = true; changed = true; }
        if (!metadataUsers.Deverlope.developer) { metadataUsers.Deverlope.developer = true; changed = true; }
    }
    if (changed) saveJSON('users.json', metadataUsers);
}

initDatabase();
setInterval(processScheduledMessages, 10000);

function parseCookies(req) {
    return (req.headers.cookie || '').split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator === -1) return cookies;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        cookies[key] = decodeURIComponent(value);
        return cookies;
    }, {});
}

function getSessionUser(req) {
    const token = parseCookies(req).pulscord_session;
    if (!token) return null;

    const sessions = loadJSON('sessions.json') || {};
    const session = sessions[token];
    if (!session || session.expiresAt < Date.now()) return null;

    const users = loadJSON('users.json') || {};
    const user = users[session.username];
    return user ? publicUser(session.username, user) : null;
}

function createSession(username) {
    const sessions = loadJSON('sessions.json') || {};
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = { username, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30 };
    saveJSON('sessions.json', sessions);
    return token;
}

function setSessionCookie(res, token) {
    res.setHeader('Set-Cookie', `pulscord_session=${encodeURIComponent(token)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', 'pulscord_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');
}

function sendAuthResponse(res, username, user, statusCode = 200) {
    setSessionCookie(res, createSession(username));
    res.status(statusCode).json({
        success: true,
        user: {
            username,
            avatar: user.avatar,
            role: user.role,
            money: user.money || 0,
            premium: Boolean(user.premium),
            developer: Boolean(user.developer),
            admin: Boolean(user.admin)
            ,verified: Boolean(user.verified)
        }
    });
}

function publicUser(username, user) {
    return {
        username,
        avatar: user.avatar,
        role: user.role,
        money: user.money || 0,
        premium: Boolean(user.premium),
        developer: Boolean(user.developer),
        admin: Boolean(user.admin),
        verified: Boolean(user.verified),
        bot: Boolean(user.bot),
        botName: user.botName || null,
        botCommand: user.botCommand || null,
        botKeyword: user.botKeyword || null,
        botTriggerType: user.botTriggerType || 'command',
        blockedUsers: user.blockedUsers || []
    };
}

function requireAdmin(req, res) {
    const user = getSessionUser(req);
    if (!user || (user.username !== 'Deverlope' && !user.admin)) {
        res.status(403).json({ error: 'Нет прав администратора' });
        return null;
    }
    return user;
}

function canDeleteAllMessages(user, message) {
    return user.username === 'Deverlope';
}

// Онлайн пользователи
const onlineUsers = new Map();
const voiceRooms = new Map();

function leaveVoiceRoom(socket) {
    const room = socket.data.voiceRoom;
    if (!room) return;
    const members = voiceRooms.get(room);
    if (members) {
        members.delete(socket.id);
        socket.to(`voice:${room}`).emit('voice-user-left', { socketId: socket.id });
        if (!members.size) voiceRooms.delete(room);
    }
    socket.leave(`voice:${room}`);
    socket.data.voiceRoom = null;
}

function getVoiceInviteRecipients(socketServer, callerSocket, room) {
    const members = voiceRooms.get(room) || new Map();
    const recipients = [];
    const directUsers = room.startsWith('dm:') ? room.split(':').slice(1) : null;
    const channelName = room.startsWith('channel:') ? room.slice('channel:'.length) : null;
    const channels = channelName ? loadJSON('channels.json') || {} : {};
    const channel = channelName ? channels[channelName] : null;

    for (const [socketId, candidate] of socketServer.sockets.sockets) {
        if (socketId === callerSocket.id || members.has(socketId) || !candidate.data.username) continue;
        if (directUsers && !directUsers.includes(candidate.data.username)) continue;
        if (channel?.private && !channel.members?.includes(candidate.data.username)) continue;
        recipients.push(candidate);
    }
    return recipients;
}

function getOnlineUserSnapshot() {
    const users = new Map();
    for (const user of onlineUsers.values()) users.set(user.username, user);
    return [...users.values()];
}

// ===== REST API =====

app.get('/api/stories', (req, res) => {
    const sessionUser = getSessionUser(req);
    const contacts = loadJSON('contacts.json') || {};
    const allowedAuthors = new Set(sessionUser ? [sessionUser.username, ...(contacts[sessionUser.username] || [])] : []);
    const stories = (loadJSON('stories.json') || []).filter(story => Date.now() - new Date(story.createdAt).getTime() < 24 * 60 * 60 * 1000);
    saveJSON('stories.json', stories);
    const users = loadJSON('users.json') || {};
    res.json(stories.filter(story => allowedAuthors.has(story.author)).map(story => ({
        ...story,
        avatar: users[story.author]?.avatar || story.author[0].toUpperCase(),
        developer: Boolean(users[story.author]?.developer),
        admin: Boolean(users[story.author]?.admin)
    })));
});

app.get('/api/monkey-nfts', (req, res) => {
    res.json(loadJSON('monkey-nfts.json') || []);
});

app.post('/api/stories', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    if (!req.body.image) return res.status(400).json({ error: 'Фото для сторис обязательно' });
    const stories = (loadJSON('stories.json') || []).filter(story => Date.now() - new Date(story.createdAt).getTime() < 24 * 60 * 60 * 1000);
    const story = { id: Date.now(), author: user.username, image: req.body.image, createdAt: new Date().toISOString() };
    stories.push(story);
    saveJSON('stories.json', stories);
    broadcastEvent('story-created', story);
    res.status(201).json(story);
});

// Регистрация
app.post('/api/auth/register', (req, res) => {
    const { username, password, avatar } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Требуется имя пользователя и пароль' });
    }

    const users = loadJSON('users.json');

    if (users[username]) {
        return res.status(400).json({ error: 'Пользователь уже существует' });
    }

    users[username] = {
        password,
        avatar: avatar || username[0].toUpperCase(),
        created: new Date(),
        role: 'user',
        status: 'online',
        money: 0,
        premium: false,
        developer: false,
        admin: false
    };

    saveJSON('users.json', users);

    sendAuthResponse(res, username, users[username]);
});

// Вход
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Требуется имя и пароль' });
    }

    const users = loadJSON('users.json');
    const user = users[username];

    if (!user || user.password !== password) {
        return res.status(401).json({ error: 'Неверные учетные данные' });
    }

    sendAuthResponse(res, username, user);
});

app.get('/api/auth/me', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Сессия истекла' });
    res.json({ success: true, user });
});

app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req).pulscord_session;
    const sessions = loadJSON('sessions.json') || {};
    if (token) delete sessions[token];
    saveJSON('sessions.json', sessions);
    clearSessionCookie(res);
    res.json({ success: true });
});

app.post('/api/premium/buy', (req, res) => {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) return res.status(401).json({ error: 'Требуется вход' });

    const users = loadJSON('users.json') || {};
    const user = users[sessionUser.username];
    if (user.premium) return res.json({ success: true, user: publicUser(sessionUser.username, user) });
    if ((user.money || 0) < 1000) return res.status(400).json({ error: 'Нужно 1000 Pulscord Money' });
    user.money -= 1000;
    user.premium = true;
    saveJSON('users.json', users);
    res.json({ success: true, user: publicUser(sessionUser.username, user) });
});

app.post('/api/bots', (req, res) => {
    const owner = getSessionUser(req);
    if (!owner) return res.status(401).json({ error: 'Требуется вход' });
    if (!owner.premium && owner.username !== 'Deverlope') return res.status(403).json({ error: 'Создание ботов доступно только Premium-пользователям' });
    const name = String(req.body.name || '').trim();
    const blocks = Array.isArray(req.body.blocks) ? req.body.blocks.map(block => ({ type: String(block.type || ''), value: String(block.value || '').trim() })).filter(block => ['trigger', 'reply', 'condition'].includes(block.type) && block.value).slice(0, 20) : [];
    if (blocks.length) {
        const trigger = blocks.find(block => block.type === 'trigger');
        const replies = blocks.filter(block => block.type === 'reply');
        if (!trigger || !replies.length) return res.status(400).json({ error: 'Добавь блок запуска и блок ответа' });
        const triggerValue = trigger.value.replace(/^\//, '').toLowerCase();
        const triggerType = trigger.value.startsWith('/') ? 'command' : 'keyword';
        const username = `bot_${triggerValue}`;
        const users = loadJSON('users.json') || {};
        if (users[username]) return res.status(409).json({ error: 'Такой триггер уже занят' });
        users[username] = { password: crypto.randomBytes(24).toString('hex'), avatar: '🤖', status: 'online', role: 'bot', premium: false, developer: false, admin: false, bot: true, botName: name, botCommand: triggerType === 'command' ? triggerValue : null, botKeyword: triggerType === 'keyword' ? triggerValue : null, botTriggerType: triggerType, botBlocks: blocks, botResponse: replies.map(block => block.value).join('\n'), botOwner: owner.username, created: new Date().toISOString() };
        saveJSON('users.json', users);
        const contacts = loadJSON('contacts.json') || {};
        contacts[owner.username] = [...new Set([...(contacts[owner.username] || []), username])];
        saveJSON('contacts.json', contacts);
        io.emit('contact-added', { username: owner.username, contact: username });
        return res.status(201).json({ username, bot: publicUser(username, users[username]) });
    }
    const command = String(req.body.command || '').trim().replace(/^\//, '').toLowerCase();
    const triggerType = req.body.triggerType === 'keyword' ? 'keyword' : 'command';
    const responseText = String(req.body.response || '').trim();
    if (!/^[\wА-Яа-яЁё ]{2,32}$/.test(name)) return res.status(400).json({ error: 'Имя бота: от 2 до 32 символов' });
    if (!/^[a-zа-яё][\wа-яё-]{1,20}$/i.test(command)) return res.status(400).json({ error: 'Триггер должен содержать 2-21 букв, цифр или дефисов' });
    if (!responseText || responseText.length > 1000) return res.status(400).json({ error: 'Ответ бота обязателен и не длиннее 1000 символов' });
    const users = loadJSON('users.json') || {};
    const username = `bot_${command}`;
    if (users[username]) return res.status(409).json({ error: 'Такая команда уже занята' });
    users[username] = { password: crypto.randomBytes(24).toString('hex'), avatar: '🤖', status: 'online', role: 'bot', premium: false, developer: false, admin: false, bot: true, botName: name, botCommand: triggerType === 'command' ? command : null, botKeyword: triggerType === 'keyword' ? command : null, botTriggerType: triggerType, botResponse: responseText, botOwner: owner.username, created: new Date().toISOString() };
    saveJSON('users.json', users);
    const contacts = loadJSON('contacts.json') || {};
    contacts[owner.username] = contacts[owner.username] || [];
    contacts[owner.username].push(username);
    saveJSON('contacts.json', contacts);
    io.emit('contact-added', { username: owner.username, contact: username });
    res.status(201).json({ username, bot: publicUser(username, users[username]) });
});

app.delete('/api/admin/bots/:username', (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.username !== 'Deverlope') return res.status(403).json({ error: 'Удалять ботов может только Deverlope' });
    const users = loadJSON('users.json') || {};
    if (!users[req.params.username]?.bot) return res.status(404).json({ error: 'Бот не найден' });
    delete users[req.params.username];
    saveJSON('users.json', users);
    const contacts = loadJSON('contacts.json') || {};
    Object.keys(contacts).forEach(username => { contacts[username] = (contacts[username] || []).filter(contact => contact !== req.params.username); });
    saveJSON('contacts.json', contacts);
    const directMessages = loadJSON('direct-messages.json') || {};
    Object.keys(directMessages).filter(key => key.split('__').includes(req.params.username)).forEach(key => delete directMessages[key]);
    saveJSON('direct-messages.json', directMessages);
    io.emit('contact-added', { deleted: req.params.username });
    res.json({ success: true });
});

app.get('/api/admin/content', (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.username !== 'Deverlope') return res.status(403).json({ error: 'Нет доступа' });
    const users = loadJSON('users.json') || {};
    const channels = loadJSON('channels.json') || {};
    const groups = loadJSON('groups.json') || {};
    const messages = loadJSON('messages.json') || {};
    const directMessages = loadJSON('direct-messages.json') || {};
    res.json({
        bots: Object.entries(users).filter(([, item]) => item.bot).map(([username, item]) => ({ username, name: item.botName, command: item.botCommand, keyword: item.botKeyword, triggerType: item.botTriggerType || 'command' })),
        groups: Object.entries(groups).map(([id, item]) => ({ id, name: item.name, owner: item.owner, members: (item.members || []).length })),
        channels: Object.entries(channels).map(([id, item]) => ({ id, name: item.name, owner: item.owner || 'system', messages: (messages[id] || []).length })),
        messages: [
            ...Object.entries(messages).flatMap(([channel, items]) => items.map(item => ({ channel, id: item.id, author: item.author, text: item.text || 'медиа-сообщение' }))),
            ...Object.entries(directMessages).flatMap(([dm, items]) => items.map(item => ({ channel: `ЛС: ${dm}`, dm, id: item.id, author: item.author, text: item.text || 'медиа-сообщение' })))
        ],
        messageCount: Object.values(messages).reduce((total, items) => total + items.length, 0) + Object.values(directMessages).reduce((total, items) => total + items.length, 0)
    });
});

app.get('/api/admin/overview', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = loadJSON('users.json') || {};
    res.json({ users: Object.entries(users).map(([username, user]) => publicUser(username, user)) });
});

app.post('/api/admin/grant-money', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const username = String(req.body.username || '').trim();
    const amount = Number(req.body.amount);
    const users = loadJSON('users.json') || {};
    if (!users[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Сумма должна быть положительным целым числом' });
    users[username].money = (users[username].money || 0) + amount;
    saveJSON('users.json', users);
    res.json({ success: true, user: publicUser(username, users[username]) });
});

app.post('/api/admin/grant-premium', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const username = String(req.body.username || '').trim();
    const users = loadJSON('users.json') || {};
    if (!users[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    users[username].premium = true;
    saveJSON('users.json', users);
    res.json({ success: true, user: publicUser(username, users[username]) });
});

app.post('/api/admin/grant-developer', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const username = String(req.body.username || '').trim();
    const users = loadJSON('users.json') || {};
    if (!users[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    users[username].developer = true;
    saveJSON('users.json', users);
    res.json({ success: true, user: publicUser(username, users[username]) });
});

app.post('/api/admin/grant-admin', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const username = String(req.body.username || '').trim();
    const users = loadJSON('users.json') || {};
    if (!users[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    users[username].admin = true;
    users[username].role = 'admin';
    saveJSON('users.json', users);
    res.json({ success: true, user: publicUser(username, users[username]) });
});

app.post('/api/admin/grant-verification', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const targetType = String(req.body.targetType || 'user').trim();
    const targetId = String(req.body.targetId || '').trim();
    if (!targetId || !['user', 'group', 'channel'].includes(targetType)) return res.status(400).json({ error: 'Укажите тип и объект для верификации' });

    if (targetType === 'user') {
        const users = loadJSON('users.json') || {};
        if (!users[targetId]) return res.status(404).json({ error: 'Пользователь не найден' });
        users[targetId].verified = true;
        saveJSON('users.json', users);
        broadcastEvent('verification-updated', { targetType, targetId, verified: true });
        return res.json({ success: true, targetType, targetId, verified: true, user: publicUser(targetId, users[targetId]) });
    }

    const filename = targetType === 'group' ? 'groups.json' : 'channels.json';
    const containers = loadJSON(filename) || {};
    if (!containers[targetId]) return res.status(404).json({ error: `${targetType === 'group' ? 'Группа' : 'Канал'} не найден` });
    containers[targetId].verified = true;
    saveJSON(filename, containers);
    broadcastEvent('verification-updated', { targetType, targetId, verified: true });
    res.json({ success: true, targetType, targetId, verified: true });
});

// Получить профиль пользователя
app.get('/api/user/:username', (req, res) => {
    const users = loadJSON('users.json');
    const user = users[req.params.username];

    if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ ...publicUser(req.params.username, user), status: user.status, created: user.created });
});

app.put('/api/user/:username', (req, res) => {
    const sessionUser = getSessionUser(req);
    if (!sessionUser || sessionUser.username !== req.params.username) {
        return res.status(401).json({ error: 'Требуется вход' });
    }

    const users = loadJSON('users.json') || {};
    const oldUsername = sessionUser.username;
    const newUsername = String(req.body.username || oldUsername).trim();
    const rawAvatar = String(req.body.avatar || users[oldUsername].avatar).trim();
    const avatar = rawAvatar.startsWith('data:image') ? rawAvatar : rawAvatar.slice(0, 2);
    const password = String(req.body.password || '').trim();

    if (!newUsername || newUsername.length < 3) return res.status(400).json({ error: 'Username должен быть не короче 3 символов' });
    if (!avatar) return res.status(400).json({ error: 'Аватар не может быть пустым' });
    if (newUsername !== oldUsername && users[newUsername]) return res.status(400).json({ error: 'Такой username уже занят' });

    const user = users[oldUsername];
    if (newUsername !== oldUsername) {
        users[newUsername] = user;
        delete users[oldUsername];
        const contacts = loadJSON('contacts.json') || {};
        if (contacts[oldUsername]) { contacts[newUsername] = contacts[oldUsername].map(name => name === oldUsername ? newUsername : name); delete contacts[oldUsername]; }
        Object.values(contacts).forEach(list => list.forEach((name, index) => { if (name === oldUsername) list[index] = newUsername; }));
        saveJSON('contacts.json', contacts);

        const requests = loadJSON('friend-requests.json') || [];
        requests.forEach(request => { if (request.from === oldUsername) request.from = newUsername; if (request.to === oldUsername) request.to = newUsername; });
        saveJSON('friend-requests.json', requests);

        const groups = loadJSON('groups.json') || {};
        Object.values(groups).forEach(group => { if (group.owner === oldUsername) group.owner = newUsername; group.members = group.members.map(name => name === oldUsername ? newUsername : name); });
        saveJSON('groups.json', groups);

        const channels = loadJSON('channels.json') || {};
        Object.values(channels).forEach(channel => { if (channel.members) channel.members = channel.members.map(name => name === oldUsername ? newUsername : name); });
        saveJSON('channels.json', channels);

        const messages = loadJSON('messages.json') || {};
        Object.values(messages).forEach(list => list.forEach(message => { if (message.author === oldUsername) message.author = newUsername; }));
        saveJSON('messages.json', messages);

        const directMessages = loadJSON('direct-messages.json') || {};
        const migratedDMs = {};
        Object.entries(directMessages).forEach(([key, list]) => {
            const newKey = key.split('__').map(name => name === oldUsername ? newUsername : name).sort().join('__');
            migratedDMs[newKey] = [...(migratedDMs[newKey] || []), ...list.map(message => ({ ...message, author: message.author === oldUsername ? newUsername : message.author }))];
        });
        saveJSON('direct-messages.json', migratedDMs);

        const sessions = loadJSON('sessions.json') || {};
        Object.values(sessions).forEach(session => { if (session.username === oldUsername) session.username = newUsername; });
        saveJSON('sessions.json', sessions);
    }

    const updatedUser = users[newUsername];
    updatedUser.avatar = avatar;
    if (password) updatedUser.password = password;
    saveJSON('users.json', users);
    res.json({ success: true, user: publicUser(newUsername, updatedUser) });
});

// Получить все пользователей
app.get('/api/users', (req, res) => {
    const users = loadJSON('users.json');
    const userList = Object.entries(users).map(([username, data]) => ({
        username,
        avatar: data.avatar,
        status: data.status,
        role: data.role,
        verified: Boolean(data.verified)
    }));
    res.json(userList);
});

// Получить каналы
app.get('/api/channels', (req, res) => {
    const channels = loadJSON('channels.json') || {};
    const groups = loadJSON('groups.json') || {};
    const user = getSessionUser(req);
    const visibleGroups = Object.fromEntries(Object.entries(groups).filter(([, group]) => {
        return user && group.members.includes(user.username);
    }).map(([id, group]) => [id, {
        name: group.name,
        description: 'Групповой чат',
        isGroup: true,
        private: true
        ,avatar: group.avatar || null,
        owner: group.owner,
        members: group.members,
        subscriberCount: (group.members || []).length
            ,verified: Boolean(group.verified)
    }]));
    const visibleChannels = Object.fromEntries(Object.entries(channels).filter(([, channel]) =>
        !channel.private || (user && (channel.members || []).includes(user.username))
    ).map(([id, channel]) => [id, {
        ...channel,
        avatar: channel.avatar || null,
        owner: channel.owner || 'Deverlope',
        members: channel.members || [],
        subscriberCount: (channel.members || []).length
        ,verified: Boolean(channel.verified)
    }]));
    res.json({ ...visibleChannels, ...visibleGroups });
});

app.post('/api/channels', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });

    const name = String(req.body.name || '').trim();
    const id = name.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '');
    if (!name || !id) return res.status(400).json({ error: 'Введите название канала' });

    const channels = loadJSON('channels.json') || {};
    if (channels[id]) return res.status(400).json({ error: 'Такой канал уже существует' });
    channels[id] = {
        name,
        description: `Канал создан @${user.username}`,
        created: new Date().toISOString(),
        owner: user.username,
        avatar: String(req.body.avatar || '').trim() || null,
        private: Boolean(req.body.private),
        members: Boolean(req.body.private) ? [user.username] : []
    };
    saveJSON('channels.json', channels);
    const messages = loadJSON('messages.json') || {};
    messages[id] = [];
    saveJSON('messages.json', messages);
    broadcastEvent('channel-created', { id, channel: channels[id] });
    res.status(201).json({ id, channel: channels[id] });
});

app.post('/api/channels/join', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    const channelName = String(req.body.name || '').trim();
    if (!channelName) return res.status(400).json({ error: 'Введите название канала' });
    const channels = loadJSON('channels.json') || {};
    const entry = Object.entries(channels).find(([id, channel]) =>
        id.toLowerCase() === channelName.toLowerCase() || channel.name.toLowerCase() === channelName.toLowerCase()
    );
    if (!entry) return res.status(404).json({ error: 'Канал не найден' });
    const [id, channel] = entry;
    channel.members = [...new Set([...(channel.members || []), user.username])];
    saveJSON('channels.json', channels);
    broadcastEvent('channel-created', { id, channel });
    res.json({ success: true, id, channel });
});

app.post('/api/groups', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Введите название группы' });
    const id = `group-${crypto.randomUUID()}`;
    const groups = loadJSON('groups.json') || {};
    groups[id] = { name, owner: user.username, avatar: String(req.body.avatar || '').trim() || null, members: [user.username], created: new Date().toISOString() };
    saveJSON('groups.json', groups);
    const messages = loadJSON('messages.json') || {};
    messages[id] = [];
    saveJSON('messages.json', messages);
    broadcastEvent('channel-created', { id, channel: { name, description: 'Групповой чат', isGroup: true, private: true } });
    res.status(201).json({ id, group: groups[id] });
});

function canManageContainer(user, container) {
    return user.username === 'Deverlope' || container.owner === user.username;
}

app.put('/api/containers/:containerId', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    const channels = loadJSON('channels.json') || {};
    const groups = loadJSON('groups.json') || {};
    const container = channels[req.params.containerId] || groups[req.params.containerId];
    if (!container) return res.status(404).json({ error: 'Группа или канал не найдены' });
    if (!canManageContainer(user, container)) return res.status(403).json({ error: 'Изменять может только владелец или Deverlope' });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Введите название' });
    container.name = name;
    container.avatar = String(req.body.avatar || '').trim() || null;
    if (channels[req.params.containerId]) {
        channels[req.params.containerId] = container;
        saveJSON('channels.json', channels);
    } else {
        groups[req.params.containerId] = container;
        saveJSON('groups.json', groups);
    }
    broadcastEvent('channel-created', { id: req.params.containerId, channel: { ...container, isGroup: Boolean(groups[req.params.containerId]) } });
    res.json({ success: true, container });
});

app.delete('/api/groups/:groupId', (req, res) => {
    const user = getSessionUser(req);
    const groups = loadJSON('groups.json') || {};
    const group = groups[req.params.groupId];
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    if (user.username !== 'Deverlope') return res.status(403).json({ error: 'Удалять группы может только Deverlope' });
    delete groups[req.params.groupId];
    saveJSON('groups.json', groups);
    const messages = loadJSON('messages.json') || {};
    delete messages[req.params.groupId];
    saveJSON('messages.json', messages);
    broadcastEvent('channel-created', { deleted: req.params.groupId });
    res.json({ success: true });
});

app.delete('/api/channels/:channelId', (req, res) => {
    const user = getSessionUser(req);
    const channels = loadJSON('channels.json') || {};
    const channel = channels[req.params.channelId];
    const protectedChannels = ['general', 'announcements', 'random', 'events'];
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    if (protectedChannels.includes(req.params.channelId)) return res.status(403).json({ error: 'Системный канал нельзя удалить' });
    if (user.username !== 'Deverlope') return res.status(403).json({ error: 'Удалять каналы может только Deverlope' });
    delete channels[req.params.channelId];
    saveJSON('channels.json', channels);
    const messages = loadJSON('messages.json') || {};
    delete messages[req.params.channelId];
    saveJSON('messages.json', messages);
    broadcastEvent('channel-created', { deleted: req.params.channelId });
    res.json({ success: true });
});

function removeMember(req, res, type) {
    const user = getSessionUser(req);
    const store = loadJSON(`${type}s.json`) || {};
    const id = type === 'group' ? req.params.groupId : req.params.channelId;
    const container = store[id];
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    if (!container) return res.status(404).json({ error: `${type === 'group' ? 'Группа' : 'Канал'} не найден` });
    if (!canManageContainer(user, container)) return res.status(403).json({ error: 'Управлять участниками может только владелец или Deverlope' });
    const username = String(req.body.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Укажите username' });
    if (username === container.owner) return res.status(400).json({ error: 'Нельзя исключить владельца' });
    container.members = (container.members || []).filter(member => member !== username);
    saveJSON(`${type}s.json`, store);
    broadcastEvent('channel-created', { id, channel: container });
    res.json({ success: true, container });
}

app.post('/api/groups/:groupId/kick', (req, res) => removeMember(req, res, 'group'));
app.post('/api/channels/:channelId/kick', (req, res) => removeMember(req, res, 'channel'));

app.post('/api/groups/:groupId/invite', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    const groups = loadJSON('groups.json') || {};
    const group = groups[req.params.groupId];
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    if (!group.members.includes(user.username)) return res.status(403).json({ error: 'Вы не участник группы' });
    const username = String(req.body.username || '').trim();
    const users = loadJSON('users.json') || {};
    if (!users[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!group.members.includes(username)) group.members.push(username);
    saveJSON('groups.json', groups);
    broadcastEvent('channel-created', { id: req.params.groupId, channel: { name: group.name, description: 'Групповой чат', isGroup: true, private: true } });
    res.json({ success: true, group });
});

app.post('/api/channels/:channelId/invite', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    const channels = loadJSON('channels.json') || {};
    const channel = channels[req.params.channelId];
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    if (!channel.private || !channel.members.includes(user.username)) {
        return res.status(403).json({ error: 'Приглашать можно только из закрытого канала' });
    }
    const username = String(req.body.username || '').trim();
    const users = loadJSON('users.json') || {};
    if (!users[username]) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!channel.members.includes(username)) channel.members.push(username);
    saveJSON('channels.json', channels);
    broadcastEvent('channel-created', { id: req.params.channelId, channel });
    res.json({ success: true, channel });
});

function canAccessChannel(req, channelId) {
    const user = getSessionUser(req);
    if (!user) return false;
    const channels = loadJSON('channels.json') || {};
    const groups = loadJSON('groups.json') || {};
    const channel = channels[channelId];
    const group = groups[channelId];
    if (!channel && !group) return false;
    if (group) return group.members.includes(user.username);
    if (channel?.private) return channel.members.includes(user.username);
    return true;
}

app.post('/api/channels/:channel/schedule', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    if (!user.premium && user.username !== 'Deverlope') return res.status(403).json({ error: 'Отложенная отправка доступна только Premium-пользователям' });
    if (!canAccessChannel(req, req.params.channel)) return res.status(403).json({ error: 'Нет доступа к каналу' });
    const text = String(req.body.text || '').trim();
    const sendAt = new Date(req.body.sendAt);
    if (!text) return res.status(400).json({ error: 'Текст сообщения обязателен' });
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now() || sendAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'Дата должна быть в будущем, максимум через 30 дней' });
    const scheduled = loadJSON('scheduled-messages.json') || [];
    const item = { id: crypto.randomUUID(), channel: req.params.channel, author: user.username, text, sendAt: sendAt.toISOString() };
    scheduled.push(item);
    saveJSON('scheduled-messages.json', scheduled);
    res.status(201).json(item);
});

app.post('/api/dms/:username/:contactUsername/schedule', (req, res) => {
    const user = requireDMUsers(req, res);
    if (!user) return;
    if (!user.premium && user.username !== 'Deverlope') return res.status(403).json({ error: 'Отложенная отправка доступна только Premium-пользователям' });
    if (isBlocked(user.username, req.params.contactUsername)) return res.status(403).json({ error: 'Сообщения заблокированы' });
    const text = String(req.body.text || '').trim();
    const sendAt = new Date(req.body.sendAt);
    if (!text) return res.status(400).json({ error: 'Текст сообщения обязателен' });
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now() || sendAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'Дата должна быть в будущем, максимум через 30 дней' });
    const scheduled = loadJSON('scheduled-messages.json') || [];
    const item = { id: crypto.randomUUID(), type: 'dm', author: user.username, recipient: req.params.contactUsername, text, sendAt: sendAt.toISOString() };
    scheduled.push(item);
    saveJSON('scheduled-messages.json', scheduled);
    res.status(201).json(item);
});

// Получить сообщения канала
app.get('/api/channels/:channel/messages', (req, res) => {
    const user = getSessionUser(req);
    if (!user || !canAccessChannel(req, req.params.channel)) return res.status(403).json({ error: 'Нет доступа к каналу' });
    const messages = loadJSON('messages.json');
    const users = loadJSON('users.json') || {};
    const channelMessages = messages[req.params.channel] || [];
    res.json(channelMessages.filter(message => !(message.hiddenFor || []).includes(user.username)).map(message => ({
        ...message,
        premium: Boolean(users[message.author]?.premium),
        developer: Boolean(users[message.author]?.developer),
        admin: Boolean(users[message.author]?.admin)
    })));
});

// Отправить сообщение в канал
app.post('/api/channels/:channel/messages', (req, res) => {
    if (!canAccessChannel(req, req.params.channel)) return res.status(403).json({ error: 'Нет доступа к каналу' });
    const { author, text, image, audio, video, file, replyTo } = req.body;
    const hasText = typeof text === 'string' ? text.trim() : '';

    if (!author || (!hasText && !image && !audio && !video && !file)) {
        return res.status(400).json({ error: 'Требуется автор, текст или медиа' });
    }

    const users = loadJSON('users.json') || {};
    const authorUser = users[author];
    if (!authorUser) return res.status(401).json({ error: 'Пользователь не найден' });
    const maxFileSize = authorUser.premium ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
    if (file && Number(file.size) > maxFileSize) {
        return res.status(413).json({ error: `Размер файла превышает лимит: ${authorUser.premium ? 'до 50 МБ' : 'до 5 МБ'} для ${authorUser.premium ? 'Premium' : 'обычного'} аккаунта` });
    }
    const messages = loadJSON('messages.json');

    if (!messages[req.params.channel]) {
        messages[req.params.channel] = [];
    }

    const message = {
        id: Date.now(),
        author,
        avatar: authorUser.avatar || author[0].toUpperCase(),
        premium: Boolean(authorUser.premium),
        developer: Boolean(authorUser.developer),
        admin: Boolean(authorUser.admin),
        text: hasText,
        image: image || null,
        audio: audio || null,
        video: video || null,
        file: file && file.data ? { name: String(file.name || 'Файл'), type: String(file.type || 'application/octet-stream'), size: Number(file.size) || 0, data: file.data } : null,
        replyTo: replyTo && replyTo.id ? { id: replyTo.id, author: String(replyTo.author || ''), text: String(replyTo.text || '') } : null,
        timestamp: new Date(),
        edited: false
    };

    messages[req.params.channel].push(message);
    const schoolMessage = /^\/school(?:\s|$)/i.test(hasText) ? createSchoolMessage(schoolAssistantResponse(hasText), /^\/school$/i.test(hasText)) : null;
    if (schoolMessage) messages[req.params.channel].push(schoolMessage);
    const botResponse = getBotResponse(hasText, users);
    if (botResponse) messages[req.params.channel].push(botResponse.message);
    saveJSON('messages.json', messages);

    broadcastEvent('message', {
        channel: req.params.channel,
        message
    });
    if (schoolMessage) broadcastEvent('message', { channel: req.params.channel, message: schoolMessage });
    if (botResponse) broadcastEvent('message', { channel: req.params.channel, message: botResponse.message });

    res.json({ message, schoolMessage, botMessage: botResponse?.message || null });
});

// Редактировать сообщение
app.put('/api/channels/:channel/messages/:id', (req, res) => {
    if (!canAccessChannel(req, req.params.channel)) return res.status(403).json({ error: 'Нет доступа к каналу' });
    const { text, author } = req.body;
    const messages = loadJSON('messages.json');

    if (!messages[req.params.channel]) {
        return res.status(404).json({ error: 'Канал не найден' });
    }

    const message = messages[req.params.channel].find(m => m.id == req.params.id);

    if (!message) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
    }

    if (message.author !== author) {
        return res.status(403).json({ error: 'Вы не можете редактировать это сообщение' });
    }

    message.text = text;
    message.edited = true;
    message.editedAt = new Date();

    saveJSON('messages.json', messages);

    broadcastEvent('message-edited', {
        channel: req.params.channel,
        message
    });

    res.json(message);
});

// Удалить сообщение
app.delete('/api/channels/:channel/messages/:id', (req, res) => {
    const user = getSessionUser(req);
    if (!user || !canAccessChannel(req, req.params.channel)) return res.status(403).json({ error: 'Нет доступа к каналу' });
    const deleteFor = req.body.deleteFor === 'self' ? 'self' : 'everyone';
    const messages = loadJSON('messages.json');

    if (!messages[req.params.channel]) {
        return res.status(404).json({ error: 'Канал не найден' });
    }

    const index = messages[req.params.channel].findIndex(m => m.id == req.params.id);

    if (index === -1) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
    }

    const message = messages[req.params.channel][index];

    if (deleteFor === 'everyone' && !canDeleteAllMessages(user, message)) {
        return res.status(403).json({ error: 'Удалить сообщение у всех может только автор или Deverlope' });
    }

    if (deleteFor === 'self') {
        message.hiddenFor = [...new Set([...(message.hiddenFor || []), user.username])];
    } else {
        messages[req.params.channel].splice(index, 1);
    }
    saveJSON('messages.json', messages);

    broadcastEvent('message-deleted', {
        channel: req.params.channel,
        messageId: req.params.id,
        deleteFor
    });

    res.json({ success: true });
});

app.post('/api/channels/:channel/messages/:id/pin', (req, res) => {
    const user = getSessionUser(req);
    if (!user || !canAccessChannel(req, req.params.channel)) return res.status(403).json({ error: 'Нет доступа к каналу' });
    const channels = loadJSON('channels.json') || {};
    const channel = channels[req.params.channel];
    const canPin = user.username === 'Deverlope' || channel?.owner === user.username || user.admin;
    if (!canPin) return res.status(403).json({ error: 'Закреплять сообщения может только администратор' });
    const messages = loadJSON('messages.json') || {};
    const message = (messages[req.params.channel] || []).find(item => item.id == req.params.id);
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    message.pinned = !message.pinned;
    saveJSON('messages.json', messages);
    broadcastEvent('message-pinned', { channel: req.params.channel, messageId: req.params.id, pinned: message.pinned });
    res.json({ pinned: message.pinned });
});

app.post('/api/channels/:channel/messages/:id/reactions', (req, res) => {
    const user = getSessionUser(req);
    if (!user || !canAccessChannel(req, req.params.channel)) return res.status(403).json({ error: 'Нет доступа к каналу' });
    const messages = loadJSON('messages.json') || {};
    const message = (messages[req.params.channel] || []).find(item => item.id == req.params.id);
    const emoji = String(req.body.emoji || '').trim();
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (!emoji || emoji.length > 8) return res.status(400).json({ error: 'Недопустимая реакция' });
    message.reactions = message.reactions || {};
    message.reactions[emoji] = message.reactions[emoji] || [];
    const users = message.reactions[emoji];
    const userIndex = users.indexOf(user.username);
    if (userIndex === -1) users.push(user.username);
    else users.splice(userIndex, 1);
    if (!users.length) delete message.reactions[emoji];
    saveJSON('messages.json', messages);
    broadcastEvent('message-reaction', { channel: req.params.channel, messageId: req.params.id, reactions: message.reactions });
    res.json({ reactions: message.reactions });
});

// ===== КОНТАКТЫ =====

// Получить контакты пользователя
app.get('/api/contacts/:username', (req, res) => {
    const contacts = loadJSON('contacts.json');
    const userContacts = contacts[req.params.username] || [];
    
    // Получаем информацию о каждом контакте
    const users = loadJSON('users.json');
    const contactList = userContacts.map(contactUsername => {
        const user = users[contactUsername];
        if (user) {
            return {
                username: contactUsername,
                avatar: user.avatar,
                status: user.status,
                role: user.role,
                premium: Boolean(user.premium),
                admin: Boolean(user.admin),
                developer: Boolean(user.developer),
                verified: Boolean(user.verified),
                bot: Boolean(user.bot),
                botName: user.botName || null,
                botCommand: user.botCommand || null
            };
        }
    }).filter(Boolean);

    res.json(contactList);
});

// Добавить контакт
app.post('/api/contacts/:username/add', (req, res) => {
    const { contactUsername, currentUsername } = req.body;

    if (!contactUsername) {
        return res.status(400).json({ error: 'Требуется имя контакта' });
    }

    const users = loadJSON('users.json');

    // Проверяем, существует ли пользователь
    if (!users[contactUsername]) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, не пытается ли добавить себя
    if (contactUsername === currentUsername) {
        return res.status(400).json({ error: 'Нельзя добавить себя в контакты' });
    }

    const contacts = loadJSON('contacts.json');

    if (!contacts[currentUsername]) {
        contacts[currentUsername] = [];
    }

    // Проверяем, не добавлен ли уже
    if (contacts[currentUsername].includes(contactUsername)) {
        return res.status(400).json({ error: 'Контакт уже добавлен' });
    }

    contacts[currentUsername].push(contactUsername);
    saveJSON('contacts.json', contacts);

    io.emit('contact-added', {
        username: currentUsername,
        contact: contactUsername
    });

    res.json({
        success: true,
        contact: {
            username: contactUsername,
            avatar: users[contactUsername].avatar,
            status: users[contactUsername].status
        }
    });
});

// Удалить контакт
app.delete('/api/contacts/:username/remove/:contactUsername', (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.username !== req.params.username) return res.status(401).json({ error: 'Требуется вход' });
    const contactUsername = req.params.contactUsername;
    if (contactUsername === req.params.username) return res.status(400).json({ error: 'Нельзя удалить себя из контактов' });

    const contacts = loadJSON('contacts.json') || {};
    contacts[req.params.username] = (contacts[req.params.username] || []).filter(username => username !== contactUsername);
    contacts[contactUsername] = (contacts[contactUsername] || []).filter(username => username !== req.params.username);
    saveJSON('contacts.json', contacts);

    const requests = loadJSON('friend-requests.json') || [];
    const filteredRequests = requests.filter(request => !(
        (request.from === req.params.username && request.to === contactUsername) ||
        (request.from === contactUsername && request.to === req.params.username)
    ));
    if (filteredRequests.length !== requests.length) saveJSON('friend-requests.json', filteredRequests);

    broadcastEvent('contact-removed', { usernames: [req.params.username, contactUsername], contact: contactUsername });
    res.json({ success: true, removed: contactUsername });
});

app.post('/api/users/:username/block', (req, res) => {
    const user = getSessionUser(req);
    const target = req.params.username;
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    if (target === user.username) return res.status(400).json({ error: 'Нельзя заблокировать себя' });
    const users = loadJSON('users.json') || {};
    if (!users[target]) return res.status(404).json({ error: 'Пользователь не найден' });
    users[user.username].blockedUsers = [...new Set([...(users[user.username].blockedUsers || []), target])];
    saveJSON('users.json', users);
    res.json({ success: true, blocked: users[user.username].blockedUsers });
});

app.delete('/api/users/:username/block', (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    const users = loadJSON('users.json') || {};
    users[user.username].blockedUsers = (users[user.username].blockedUsers || []).filter(username => username !== req.params.username);
    saveJSON('users.json', users);
    res.json({ success: true, blocked: users[user.username].blockedUsers });
});

// Поиск пользователя по имени
app.get('/api/search/users/:query', (req, res) => {
    const users = loadJSON('users.json');
    const query = req.params.query.toLowerCase();

    const results = Object.entries(users)
        .filter(([username]) => username.toLowerCase().includes(query))
        .map(([username, data]) => ({
            username,
            avatar: data.avatar,
            status: data.status,
            role: data.role
        }))
        .slice(0, 10); // Максимум 10 результатов

    res.json(results);
});

// ===== ЛИЧНЫЕ СООБЩЕНИЯ =====
function getDMKey(firstUsername, secondUsername) {
    return [firstUsername, secondUsername].sort().join('__');
}

function requireDMUsers(req, res) {
    const sessionUser = getSessionUser(req);
    if (!sessionUser || sessionUser.username !== req.params.username) {
        res.status(401).json({ error: 'Требуется вход' });
        return null;
    }

    const users = loadJSON('users.json') || {};
    if (!users[req.params.contactUsername]) {
        res.status(404).json({ error: 'Пользователь не найден' });
        return null;
    }
    return sessionUser;
}

function isBlocked(firstUser, secondUser) {
    const users = loadJSON('users.json') || {};
    return (users[firstUser]?.blockedUsers || []).includes(secondUser) || (users[secondUser]?.blockedUsers || []).includes(firstUser);
}

app.get('/api/dms/:username/:contactUsername/messages', (req, res) => {
    const sessionUser = requireDMUsers(req, res);
    if (!sessionUser) return;
    if (isBlocked(sessionUser.username, req.params.contactUsername)) return res.status(403).json({ error: 'Этот пользователь заблокирован' });
    const directMessages = loadJSON('direct-messages.json') || {};
    const users = loadJSON('users.json') || {};
    const messages = directMessages[getDMKey(req.params.username, req.params.contactUsername)] || [];
    res.json(messages.filter(message => !(message.hiddenFor || []).includes(sessionUser.username)).map(message => ({
        ...message,
        premium: Boolean(users[message.author]?.premium),
        developer: Boolean(users[message.author]?.developer),
        admin: Boolean(users[message.author]?.admin)
    })));
});

app.post('/api/dms/:username/:contactUsername/messages', (req, res) => {
    const sessionUser = requireDMUsers(req, res);
    if (!sessionUser) return;
    if (isBlocked(sessionUser.username, req.params.contactUsername)) return res.status(403).json({ error: 'Сообщения заблокированы' });

    const text = String(req.body.text || '').trim();
    const image = req.body.image || null;
    const audio = req.body.audio || null;
    const video = req.body.video || null;
    const file = req.body.file || null;
    const replyTo = req.body.replyTo || null;
    if (!text && !image && !audio && !video && !file) return res.status(400).json({ error: 'Текст сообщения или медиа обязательны' });

    const users = loadJSON('users.json') || {};
    const maxFileSize = users[sessionUser.username]?.premium ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
    if (file && Number(file.size) > maxFileSize) {
        return res.status(413).json({ error: `Размер файла превышает лимит: ${users[sessionUser.username]?.premium ? 'до 50 МБ' : 'до 5 МБ'} для ${users[sessionUser.username]?.premium ? 'Premium' : 'обычного'} аккаунта` });
    }
    const directMessages = loadJSON('direct-messages.json') || {};
    const key = getDMKey(sessionUser.username, req.params.contactUsername);
    directMessages[key] = directMessages[key] || [];
    const message = {
        id: Date.now(),
        author: sessionUser.username,
        avatar: users[sessionUser.username].avatar,
        premium: Boolean(users[sessionUser.username].premium),
        developer: Boolean(users[sessionUser.username].developer),
        admin: Boolean(users[sessionUser.username].admin),
        text,
        image: image || null,
        audio,
        video,
        file: file && file.data ? { name: String(file.name || 'Файл'), type: String(file.type || 'application/octet-stream'), size: Number(file.size) || 0, data: file.data } : null,
        replyTo: replyTo && replyTo.id ? { id: replyTo.id, author: String(replyTo.author || ''), text: String(replyTo.text || '') } : null,
        timestamp: new Date().toISOString(),
        edited: false
    };
    directMessages[key].push(message);
    const schoolMessage = /^\/school(?:\s|$)/i.test(text) ? createSchoolMessage(schoolAssistantResponse(text), /^\/school$/i.test(text)) : null;
    if (schoolMessage) directMessages[key].push(schoolMessage);
    const botResponse = getBotResponse(text, users);
    if (botResponse) directMessages[key].push(botResponse.message);
    saveJSON('direct-messages.json', directMessages);
    broadcastEvent('direct-message', {
        users: [sessionUser.username, req.params.contactUsername],
        message
    });
    if (schoolMessage) broadcastEvent('direct-message', { users: [sessionUser.username, req.params.contactUsername], message: schoolMessage });
    if (botResponse) broadcastEvent('direct-message', { users: [sessionUser.username, req.params.contactUsername], message: botResponse.message });
    res.status(201).json({ message, schoolMessage, botMessage: botResponse?.message || null });
});

app.post('/api/monkey-nfts/send', (req, res) => {
    const sender = getSessionUser(req);
    const recipient = String(req.body.recipient || '').trim();
    const starAmount = Number(req.body.starAmount);
    const users = loadJSON('users.json') || {};
    if (!sender) return res.status(401).json({ error: 'Требуется вход' });
    if (!recipient || recipient === sender.username) return res.status(400).json({ error: 'Выбери получателя' });
    if (!users[recipient]) return res.status(404).json({ error: 'Получатель не найден' });
    if (isBlocked(sender.username, recipient)) return res.status(403).json({ error: 'Сообщения заблокированы' });
    if (!Number.isInteger(starAmount) || starAmount < 1 || starAmount > 1000000) return res.status(400).json({ error: 'Укажи от 1 до 1 000 000 звёзд' });
    if (sender.username !== 'Deverlope' && (users[sender.username].money || 0) < starAmount) return res.status(400).json({ error: 'Недостаточно звёзд на балансе' });
    const nftId = String(req.body.nftId || '').trim();
    const collection = loadJSON('monkey-nfts.json') || [];
    const nft = collection.find(item => item.id === nftId);
    if (!nft) return res.status(404).json({ error: 'Обезьянка не найдена' });
    const directMessages = loadJSON('direct-messages.json') || {};
    const key = getDMKey(sender.username, recipient);
    directMessages[key] = directMessages[key] || [];
    if (sender.username !== 'Deverlope') users[sender.username].money -= starAmount;
    saveJSON('users.json', users);
    const message = { id: Date.now(), author: sender.username, avatar: users[sender.username].avatar, premium: Boolean(users[sender.username].premium), developer: Boolean(users[sender.username].developer), admin: Boolean(users[sender.username].admin), text: '', monkeyNft: { ...nft, price: 0, starAmount }, image: null, audio: null, video: null, file: null, timestamp: new Date().toISOString(), edited: false };
    directMessages[key].push(message);
    saveJSON('direct-messages.json', directMessages);
    broadcastEvent('direct-message', { users: [sender.username, recipient], message });
    res.status(201).json({ message, balance: users[sender.username].money || 0 });
});

app.put('/api/dms/:username/:contactUsername/messages/:id', (req, res) => {
    const sessionUser = requireDMUsers(req, res);
    if (!sessionUser) return;

    const directMessages = loadJSON('direct-messages.json') || {};
    const key = getDMKey(sessionUser.username, req.params.contactUsername);
    const message = (directMessages[key] || []).find(item => item.id == req.params.id);
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (message.author !== sessionUser.username) return res.status(403).json({ error: 'Нельзя изменить это сообщение' });

    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Текст сообщения пуст' });
    message.text = text;
    message.edited = true;
    message.editedAt = new Date().toISOString();
    saveJSON('direct-messages.json', directMessages);
    broadcastEvent('direct-message', { users: [sessionUser.username, req.params.contactUsername], message });
    res.json(message);
});

app.delete('/api/dms/:username/:contactUsername/messages/:id', (req, res) => {
    const sessionUser = requireDMUsers(req, res);
    if (!sessionUser) return;

    const directMessages = loadJSON('direct-messages.json') || {};
    const key = getDMKey(sessionUser.username, req.params.contactUsername);
    const messages = directMessages[key] || [];
    const index = messages.findIndex(item => item.id == req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Сообщение не найдено' });
    const message = messages[index];
    const deleteFor = req.body.deleteFor === 'self' ? 'self' : 'everyone';
    if (deleteFor === 'everyone' && !canDeleteAllMessages(sessionUser, message)) {
        return res.status(403).json({ error: 'Удалить сообщение у всех может только автор или Deverlope' });
    }

    if (deleteFor === 'self') {
        message.hiddenFor = [...new Set([...(message.hiddenFor || []), sessionUser.username])];
    } else {
        messages.splice(index, 1);
    }
    saveJSON('direct-messages.json', directMessages);
    broadcastEvent('direct-message', { users: [sessionUser.username, req.params.contactUsername], deletedMessageId: req.params.id, deleteFor });
    res.json({ success: true });
});

app.post('/api/dms/:username/:contactUsername/messages/:id/reactions', (req, res) => {
    const sessionUser = requireDMUsers(req, res);
    if (!sessionUser) return;
    const directMessages = loadJSON('direct-messages.json') || {};
    const key = getDMKey(sessionUser.username, req.params.contactUsername);
    const message = (directMessages[key] || []).find(item => item.id == req.params.id);
    const emoji = String(req.body.emoji || '').trim();
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (!emoji || emoji.length > 8) return res.status(400).json({ error: 'Недопустимая реакция' });
    message.reactions = message.reactions || {};
    message.reactions[emoji] = message.reactions[emoji] || [];
    const users = message.reactions[emoji];
    const userIndex = users.indexOf(sessionUser.username);
    if (userIndex === -1) users.push(sessionUser.username);
    else users.splice(userIndex, 1);
    if (!users.length) delete message.reactions[emoji];
    saveJSON('direct-messages.json', directMessages);
    broadcastEvent('direct-message', { users: [sessionUser.username, req.params.contactUsername], message });
    res.json({ reactions: message.reactions });
});

// ===== ЗАЯВКИ В КОНТАКТЫ =====
app.get('/api/requests/:username', (req, res) => {
    const user = getSessionUser(req);
    if (!user || user.username !== req.params.username) {
        return res.status(401).json({ error: 'Требуется вход' });
    }

    const requests = loadJSON('friend-requests.json') || [];
    const users = loadJSON('users.json') || {};
    res.json(requests
        .filter(request => request.to === user.username && request.status === 'pending')
        .map(request => ({
            ...request,
            avatar: users[request.from]?.avatar || request.from[0].toUpperCase()
        })));
});

app.post('/api/requests/:username', (req, res) => {
    const user = getSessionUser(req);
    const recipientUsername = String(req.body.recipientUsername || '').trim();
    if (!user || user.username !== req.params.username) {
        return res.status(401).json({ error: 'Требуется вход' });
    }
    if (!recipientUsername) return res.status(400).json({ error: 'Введите имя пользователя' });
    if (recipientUsername === user.username) return res.status(400).json({ error: 'Нельзя отправить заявку себе' });

    const users = loadJSON('users.json') || {};
    if (!users[recipientUsername]) return res.status(404).json({ error: 'Пользователь не найден' });

    const contacts = loadJSON('contacts.json') || {};
    if ((contacts[user.username] || []).includes(recipientUsername)) {
        return res.status(400).json({ error: 'Пользователь уже в контактах' });
    }

    const requests = loadJSON('friend-requests.json') || [];
    const existing = requests.find(request =>
        request.from === user.username && request.to === recipientUsername && request.status === 'pending');
    if (existing) return res.status(400).json({ error: 'Заявка уже отправлена' });

    const reverse = requests.find(request =>
        request.from === recipientUsername && request.to === user.username && request.status === 'pending');
    if (reverse) return res.status(400).json({ error: 'У вас уже есть входящая заявка от этого пользователя' });

    const request = {
        id: crypto.randomUUID(),
        from: user.username,
        to: recipientUsername,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    requests.push(request);
    saveJSON('friend-requests.json', requests);
    io.emit('friend-request', { to: recipientUsername, from: user.username });
    res.status(201).json({ success: true, request });
});

app.put('/api/requests/:username/:requestId', (req, res) => {
    const user = getSessionUser(req);
    const action = req.body.action;
    if (!user || user.username !== req.params.username) {
        return res.status(401).json({ error: 'Требуется вход' });
    }
    if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Недопустимое действие' });

    const requests = loadJSON('friend-requests.json') || [];
    const request = requests.find(item => item.id === req.params.requestId && item.to === user.username && item.status === 'pending');
    if (!request) return res.status(404).json({ error: 'Заявка не найдена' });

    request.status = action === 'accept' ? 'accepted' : 'rejected';
    request.updatedAt = new Date().toISOString();
    if (action === 'accept') {
        const contacts = loadJSON('contacts.json') || {};
        contacts[user.username] = contacts[user.username] || [];
        contacts[request.from] = contacts[request.from] || [];
        if (!contacts[user.username].includes(request.from)) contacts[user.username].push(request.from);
        if (!contacts[request.from].includes(user.username)) contacts[request.from].push(user.username);
        saveJSON('contacts.json', contacts);
    }
    saveJSON('friend-requests.json', requests);
    io.emit('contact-updated', { usernames: [user.username, request.from] });
    res.json({ success: true, status: request.status });
});

// ===== WebSocket =====

function registerSocketHandlers(socketServer) {
    socketServer.on('connection', (socket) => {
    console.log(`✓ Пользователь подключился: ${socket.id}`);

    socket.on('user-join', (data) => {
        const { username, avatar } = data;
        socket.data.username = username;
        const users = loadJSON('users.json') || {};
        onlineUsers.set(socket.id, { username, avatar, premium: Boolean(users[username]?.premium) });
        
        socketServer.emit('user-online', {
            username,
            avatar,
            premium: Boolean(users[username]?.premium),
            onlineCount: onlineUsers.size
        });
        socket.emit('online-users', getOnlineUserSnapshot());

        console.log(`✓ ${username} вошел (онлайн: ${onlineUsers.size})`);
    });

    socket.on('message', (data) => {
        const { channel, author, text, avatar } = data;
        const message = {
            id: Date.now(),
            author,
            avatar,
            text,
            timestamp: new Date(),
            edited: false
        };

        // Сохраняем в БД
        const messages = loadJSON('messages.json');
        if (!messages[channel]) messages[channel] = [];
        messages[channel].push(message);
        saveJSON('messages.json', messages);

        // Отправляем всем
        socketServer.emit('message', {
            channel,
            message
        });
    });

    socket.on('voice-join', ({ room, username, targetUsername, video = false }) => {
        socket.data.username = username;
        const members = voiceRooms.get(room) || new Map();
        const existingMembers = [...members.entries()].map(([socketId, member]) => ({ socketId, ...member }));
        members.set(socket.id, { username, video });
        voiceRooms.set(room, members);
        socket.join(`voice:${room}`);
        socket.data.voiceRoom = room;
        socket.to(`voice:${room}`).emit('voice-user-joined', { socketId: socket.id, username, room, video });
        socket.emit('voice-existing-users', existingMembers);
        socket.emit('voice-join-ack', { room, existingMembers });
        const inviteRecipients = targetUsername
            ? [...socketServer.sockets.sockets.values()].filter(recipient => recipient.id !== socket.id && recipient.data.username === targetUsername)
            : getVoiceInviteRecipients(socketServer, socket, room);
        if (!inviteRecipients.length && targetUsername) {
            socket.emit('voice-call-unavailable', { username: targetUsername });
        }
        inviteRecipients.forEach(recipient => {
            recipient.emit('voice-incoming-call', {
                socketId: socket.id,
                username,
                room,
                video
            });
        });
    });

    socket.on('voice-reject', ({ target, username }) => {
        if (target) socketServer.to(target).emit('voice-call-rejected', { username });
    });

    socket.on('user-logout', () => {
        leaveVoiceRoom(socket);
        const user = onlineUsers.get(socket.id);
        if (!user) return;
        onlineUsers.delete(socket.id);
        if (![...onlineUsers.values()].some(item => item.username === user.username)) {
            broadcastEvent('user-offline', { username: user.username, onlineCount: onlineUsers.size });
        }
    });

    socket.on('voice-offer', ({ target, offer }) => {
        socketServer.to(target).emit('voice-offer', { from: socket.id, offer });
    });

    socket.on('voice-answer', ({ target, answer }) => {
        socketServer.to(target).emit('voice-answer', { from: socket.id, answer });
    });

    socket.on('voice-ice-candidate', ({ target, candidate }) => {
        socketServer.to(target).emit('voice-ice-candidate', { from: socket.id, candidate });
    });

    socket.on('voice-leave', () => leaveVoiceRoom(socket));

    socket.on('disconnect', () => {
        leaveVoiceRoom(socket);
        const user = onlineUsers.get(socket.id);
        if (user) {
            onlineUsers.delete(socket.id);
            const stillOnline = [...onlineUsers.values()].some(item => item.username === user.username);
            if (!stillOnline) {
                socketServer.emit('user-offline', {
                    username: user.username,
                    onlineCount: onlineUsers.size
                });
            }
            console.log(`✗ ${user.username} вышел (онлайн: ${onlineUsers.size})`);
        }
    });
    });
}

registerSocketHandlers(io);
registerSocketHandlers(secureIo);

// Запуск сервера
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Слушаем на всех интерфейсах

server.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🎯 Pulscord Server запущен!          ║
║                                        ║
║   Локальный доступ:                   ║
║   http://localhost:${PORT}              ║
║                                        ║
║   Доступ с других устройств:          ║
║   http://${localIP}:${PORT}         ║
║   HTTPS для телефона:                ║
║   https://${localIP}:3443            ║
║                                        ║
╚════════════════════════════════════════╝
    `);
});

secureServer.listen(3443, HOST, () => {
    console.log(`✓ HTTPS доступен: https://${localIP}:3443`);
});
