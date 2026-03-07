// dotenv is configured in entry.cjs (pkg bootstrap) before this module loads
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import Groq from 'groq-sdk';
import axios from 'axios';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
// systemPrompt is inlined by esbuild from generated-prompt.cjs (built by build.js)
import systemPrompt from './generated-prompt.cjs';

const { Client, LocalAuth } = pkg;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let _io = null;
let _status = 'loading'; // 'loading' | 'qr' | 'connected'
let _qr = null;

// Auto-summary: track unread group message counts per chatId
const unreadCounts = new Map();
const AUTO_THRESHOLD = parseInt(process.env.AUTO_SUMMARY_THRESHOLD || '20');

// ── Timeout helper ────────────────────────────────────────────────────────────
// Rejects with a clear error if `promise` doesn't resolve within `ms` ms.
function withTimeout(promise, ms, label = '') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`[TIMEOUT] ${label} did not respond within ${ms} ms`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Watchdog ──────────────────────────────────────────────────────────────────
// Periodically verifies the WhatsApp Puppeteer page is still alive.
// If it stops responding, the client is destroyed and re-initialised.
const WATCHDOG_INTERVAL = 2 * 60 * 1000;  // ping every 2 minutes
const WATCHDOG_TIMEOUT  = 30 * 1000;       // treat as dead after 30 s

let _watchdogTimer = null;
let _restarting    = false;

function startWatchdog() {
    if (_watchdogTimer) clearInterval(_watchdogTimer);
    _watchdogTimer = setInterval(async () => {
        if (_status !== 'connected' || _restarting) return;
        try {
            const state = await withTimeout(client.getState(), WATCHDOG_TIMEOUT, 'watchdog getState');
            emit('info', `[WATCHDOG] Client alive — state: ${state}`);
        } catch (err) {
            emit('error', `[WATCHDOG] Client unresponsive (${err.message}) — restarting...`);
            restartClient();
        }
    }, WATCHDOG_INTERVAL);
}

async function restartClient() {
    if (_restarting) return;
    _restarting = true;
    _status = 'loading';
    emit('error', '[WATCHDOG] Destroying stale client...');

    // Force-kill the underlying browser process so its SingletonLock is released
    // before we attempt destroy() — avoids the "browser already running" crash.
    const browserProc = client.pupBrowser?.process();
    if (browserProc && !browserProc.killed) {
        try { browserProc.kill(); } catch {}
    }

    try { await client.destroy(); } catch {}

    // Remove Chromium's SingletonLock so a fresh launch never thinks the old
    // instance is still alive (handles the case where kill() was async).
    const lockFile = join(process.cwd(), '.wwebjs_auth', 'session', 'SingletonLock');
    try { await unlink(lockFile); } catch {}

    setTimeout(() => {
        _restarting = false;
        emit('info', '[WATCHDOG] Re-initialising WhatsApp client...');
        client.initialize();
    }, 5_000);
}

function emit(level, message) {
    console.log(message);
    if (_io) _io.emit('log', { level, message });
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
        ],
    },
});

client.on('qr', qr => {
    _status = 'qr';
    _qr = qr;
    qrcode.generate(qr, { small: true });
    if (_io) _io.emit('qr', qr);
});

client.on('ready', () => {
    _status = 'connected';
    _qr = null;
    emit('success', '[STATUS] WhatsApp client is ready');
    if (_io) _io.emit('ready');
    startWatchdog();
    // Detect Puppeteer page crashes and auto-recover
    if (client.pupPage) {
        client.pupPage.on('crash', () => {
            emit('error', '[PUPPETEER] Page crashed — restarting client...');
            restartClient();
        });
        client.pupPage.on('close', () => {
            if (_status === 'connected') {
                emit('error', '[PUPPETEER] Page closed unexpectedly — restarting client...');
                restartClient();
            }
        });
    }
});

client.on('disconnected', (reason) => {
    emit('error', `[STATUS] WhatsApp client disconnected (${reason}) — restarting in 5 s...`);
    restartClient();
});

client.on('auth_failure', (msg) => {
    _status = 'loading';
    emit('error', `[AUTH] Authentication failed: ${msg}`);
});

async function summariseChat(chat, limit, detailed = false) {
    // Fetch extra preceding messages to give the AI background context
    const CONTEXT_EXTRA = Math.min(limit, 50);
    const fetchLimit = limit + CONTEXT_EXTRA;

    const all_messages = await withTimeout(chat.fetchMessages({ limit: fetchLimit }), 45_000, 'fetchMessages');

    // Split: older messages are context, newer messages are what we summarise
    const contextMessages = all_messages.slice(0, all_messages.length - limit);
    const targetMessages  = all_messages.slice(all_messages.length - limit);

    const resolveMessages = async (messages, label) => {
        const lines = [];
        for (const message of messages) {
            if (!message.body) continue;
            try {
                let contact_name;
                if (message.fromMe) {
                    contact_name = client.info?.pushname || client.info?.wid?.user || 'Me';
                } else {
                    const contact = await withTimeout(message.getContact(), 8_000, 'getContact');
                    contact_name = contact.name || contact.pushname || message.author || 'Unknown';
                }
                const who = message.fromMe
                    ? contact_name
                    : `${message.author ?? contact_name} aka ${contact_name}`;
                lines.push(`[${label}] ${who}: ${message.body}`);
            } catch {
                // skip messages where contact cannot be resolved
            }
        }
        return lines;
    };

    const contextLines = await resolveMessages(contextMessages, 'CONTEXT');
    const targetLines  = await resolveMessages(targetMessages,  'SUMMARY TARGET');
    targetLines.pop(); // remove the triggering command message itself

    const message_collection = [...contextLines, ...targetLines];

    emit('info', `[STATUS] Messages fetched — ${contextLines.length} context + ${targetLines.length} target`);
    emit('info', '[STATUS] Sending messages to AI...');

    const detailPrefix = detailed
        ? 'Provide a DETAILED, thorough summary covering all decisions, conclusions, questions asked, and important context from the [SUMMARY TARGET] messages. Do not omit anything significant.\n\n'
        : '';

    const ai_response = await withTimeout(
        groq.chat.completions.create({
            model: process.env.GROQ_MODEL,
            messages: [
                { role: 'system', content: detailPrefix + systemPrompt.trim() },
                { role: 'user', content: message_collection.join('\n') }
            ],
        }),
        90_000,
        'Groq API'
    );

    const summary = ai_response.choices[0].message.content.replace(/<think>.*?<\/think>/gs, '').trim();
    emit('success', '[STATUS] Summary generated');
    return summary;
}

async function sendNtfy(summary) {
    try {
        const response = await withTimeout(
            axios.post(process.env.NTFY_TOPIC, summary, {
                headers: {
                    'Title': process.env.NTFY_TITLE,
                    'Priority': process.env.NTFY_PRIORITY,
                },
            }),
            15_000,
            'ntfy'
        );
        emit('success', '[STATUS] Notification sent: ' + response.data.message);
    } catch (error) {
        emit('error', '[STATUS] Error sending notification: ' + error.message);
    }
}

client.on('message_create', async (msg) => {
    // Auto-summary: count incoming group messages (not from me)
    if (!msg.fromMe) {
        let chat;
        try {
            chat = await withTimeout(msg.getChat(), 15_000, 'getChat');
        } catch (err) {
            emit('error', '[AUTO] Failed to get chat: ' + err.message);
            return;
        }
        let senderName = 'Unknown';
        try {
            const contact = await withTimeout(msg.getContact(), 8_000, 'getContact');
            senderName = contact.name || contact.pushname || msg.author || 'Unknown';
        } catch {}
        emit('info', `[MSG] "${chat.name || chat.id.user}" from ${senderName}: ${msg.body}`);
        // "whatsapp summary" trigger — anyone (not me) types it in any chat/group
        if (msg.body.toLowerCase().trim() === 'whatsapp summary') {
            emit('info', `[TRIGGER] "whatsapp summary" requested in "${chat.name || chat.id.user}"`);
            try {
                const summary = await withTimeout(
                    summariseChat(chat, parseInt(process.env.DEFAULT_MESSAGE_LIMIT)),
                    120_000, 'summariseChat trigger');
                await withTimeout(chat.sendMessage(summary), 15_000, 'sendMessage');
                if (_io) _io.emit('summary_done', summary);
            } catch (err) {
                emit('error', '[TRIGGER ERROR] ' + err.message);
            }
            return;
        }

        if (chat.isGroup) {
            const id = chat.id._serialized;
            const count = (unreadCounts.get(id) || 0) + 1;
            unreadCounts.set(id, count);
            emit('info', `[AUTO] "${chat.name}" unread: ${count}/${AUTO_THRESHOLD}`);

            if (count >= AUTO_THRESHOLD) {
                unreadCounts.set(id, 0); // reset before async work
                emit('info', `[AUTO] Threshold hit for "${chat.name}" — generating summary...`);
                try {
                    const summary = await withTimeout(
                        summariseChat(chat, AUTO_THRESHOLD),
                        120_000, 'summariseChat auto');
                    const ntfyText = `📋 ${chat.name}\n\n${summary}`;
                    await withTimeout(sendNtfy(ntfyText), 20_000, 'sendNtfy auto');
                    if (_io) _io.emit('summary_done', summary);
                } catch (err) {
                    emit('error', '[AUTO ERROR] ' + err.message);
                }
            }
        }
    }

    if (msg.fromMe) {
        try {
            const chat = await withTimeout(msg.getChat(), 15_000, 'getChat fromMe');
            emit('info', `[YOU → "${chat.name || chat.id.user}"]: ${msg.body}`);
        } catch { /* ignore */ }
    }

    if ((msg.body.startsWith("!summarise") || msg.body.startsWith("!summarize")) && msg.fromMe) {
        const raw = msg.body;
        const detailed = raw.trimEnd().toLowerCase().endsWith(' detail');
        const stripped = detailed ? raw.trimEnd().slice(0, -7).trimEnd() : raw; // remove trailing ' detail'
        const parts = stripped.split(" ");
        const secondArg = parts[1];
        let chat, number_of_messages;

        if (!secondArg) {
            chat = await withTimeout(msg.getChat(), 15_000, 'getChat cmd');
            number_of_messages = parseInt(process.env.DEFAULT_MESSAGE_LIMIT);
        } else if (!isNaN(secondArg)) {
            chat = await withTimeout(msg.getChat(), 15_000, 'getChat cmd');
            number_of_messages = parseInt(secondArg);
        } else {
            const lastArg = parts[parts.length - 1];
            const hasCount = !isNaN(lastArg) && parts.length > 2;
            number_of_messages = hasCount ? parseInt(lastArg) : parseInt(process.env.DEFAULT_MESSAGE_LIMIT);
            const groupName = hasCount ? parts.slice(1, -1).join(" ") : parts.slice(1).join(" ");

            emit('info', `[STATUS] Searching for chat: "${groupName}"`);
            const allChats = await withTimeout(client.getChats(), 30_000, 'getChats');
            chat = allChats.find(c => c.name?.toLowerCase() === groupName.toLowerCase())
                || allChats.find(c => c.name?.toLowerCase().includes(groupName.toLowerCase()));

            if (!chat) { emit('error', `[ERROR] No chat found matching "${groupName}"`); return; }
            emit('info', `[STATUS] Found chat: "${chat.name}"`);
        }

        try {
            const summary = await withTimeout(
                summariseChat(chat, number_of_messages, detailed),
                120_000, 'summariseChat cmd');
            await withTimeout(sendNtfy(summary), 20_000, 'sendNtfy cmd');
            if (_io) _io.emit('summary_done', summary);
        } catch (err) {
            emit('error', '[ERROR] ' + err.message);
        }
    }
});

export function init(io) {
    _io = io;
    client.initialize();
}

export function resetUnreadCount(chatId) { unreadCounts.set(chatId, 0); }
export { client, summariseChat, sendNtfy };
export function getStatus() { return { status: _status, qr: _qr }; }

