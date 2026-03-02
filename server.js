import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFile, readFile } from 'fs/promises';
import { init, client, summariseChat, sendNtfy, getStatus, resetUnreadCount } from './main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',')
            : '*',
        methods: ['GET', 'POST'],
    },
});

app.use(cors({
    origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : '*',
}));
app.use(express.json());

// Serve built frontend
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

app.get('/api/chats', async (req, res) => {
    try {
        const { status } = getStatus();
        if (status !== 'connected') return res.status(503).json({ error: 'WhatsApp not connected yet' });
        const chats = await client.getChats();
        const payload = chats.slice(0, 100).map(c => ({
            id: c.id._serialized,
            name: c.name || c.id.user,
            isGroup: c.isGroup,
            unreadCount: c.unreadCount,
            lastMessage: c.lastMessage?.body?.slice(0, 80) || '',
            timestamp: c.timestamp,
        }));
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chats/:id/read', async (req, res) => {
    try {
        const { status } = getStatus();
        if (status !== 'connected') return res.status(503).json({ error: 'WhatsApp not connected yet' });
        const chats = await client.getChats();
        const chat = chats.find(c => c.id._serialized === req.params.id);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        await chat.sendSeen();
        resetUnreadCount(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/summarise', async (req, res) => {
    try {
        const { chatId, limit = 50 } = req.body;
        if (!chatId) return res.status(400).json({ error: 'chatId required' });

        const chats = await client.getChats();
        const chat = chats.find(c => c.id._serialized === chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        const summary = await summariseChat(chat, parseInt(limit));
        await sendNtfy(summary);
        io.emit('summary_done', summary);
        res.json({ summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const allowed = ['GROQ_API_KEY', 'GROQ_MODEL', 'NTFY_TOPIC', 'NTFY_TITLE', 'NTFY_PRIORITY', 'DEFAULT_MESSAGE_LIMIT'];
        const envPath = path.join(__dirname, '.env');
        let content = await readFile(envPath, 'utf-8');

        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                const regex = new RegExp(`^${key}=.*$`, 'm');
                const line = `${key}=${req.body[key]}`;
                if (regex.test(content)) {
                    content = content.replace(regex, line);
                } else {
                    content += `\n${line}`;
                }
                process.env[key] = req.body[key];
            }
        }

        await writeFile(envPath, content, 'utf-8');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/settings', async (req, res) => {
    res.json({
        GROQ_API_KEY: process.env.GROQ_API_KEY ? '***' : '',
        GROQ_MODEL: process.env.GROQ_MODEL || '',
        NTFY_TOPIC: process.env.NTFY_TOPIC || '',
        NTFY_TITLE: process.env.NTFY_TITLE || '',
        NTFY_PRIORITY: process.env.NTFY_PRIORITY || '',
        DEFAULT_MESSAGE_LIMIT: process.env.DEFAULT_MESSAGE_LIMIT || '50',
    });
});

// Catch-all: serve React app
app.use((req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
    console.log('[WS] Client connected:', socket.id);
    const { status, qr } = getStatus();
    socket.emit('status', status);
    if (status === 'qr' && qr) socket.emit('qr', qr);
    if (status === 'connected') socket.emit('ready');
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`[SERVER] Running at http://localhost:${PORT}`);
});
httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        const fallback = Number(PORT) + 1;
        console.warn(`[SERVER] Port ${PORT} in use, retrying on ${fallback}...`);
        setTimeout(() => httpServer.listen(fallback, () => {
            console.log(`[SERVER] Running at http://localhost:${fallback}`);
        }), 1000);
    } else {
        throw err;
    }
});

init(io);
