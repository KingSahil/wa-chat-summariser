import 'dotenv/config';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import Groq from 'groq-sdk';
import axios from 'axios';
import { readFile } from 'fs/promises';

const { Client, LocalAuth } = pkg;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const systemPrompt = await readFile('./system_prompt.txt', 'utf-8');

let _io = null;
let _status = 'loading'; // 'loading' | 'qr' | 'connected'
let _qr = null;

// Auto-summary: track unread group message counts per chatId
const unreadCounts = new Map();
const AUTO_THRESHOLD = parseInt(process.env.AUTO_SUMMARY_THRESHOLD || '20');

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
            '--no-zygote',
            '--single-process',
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
});

client.on('disconnected', () => {
    _status = 'loading';
    emit('error', '[STATUS] WhatsApp client disconnected');
});

async function summariseChat(chat, limit, socketId) {
    let message_collection = [];
    let asc_messages = await chat.fetchMessages({ limit });

    for (const message of asc_messages) {
        let contact = await message.getContact();
        let contact_name = contact.name || contact.pushname || message.author || 'Unknown';
        message_collection.push(`${message.author ?? contact_name} aka ${contact_name} : ${message.body}`);
    }
    message_collection.pop();

    emit('info', '[STATUS] Messages fetched and recorded');
    emit('info', '[STATUS] Sending messages to AI...');

    const ai_response = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL,
        messages: [
            { role: 'system', content: systemPrompt.trim() },
            { role: 'user', content: message_collection.join('\n') }
        ],
    });

    const summary = ai_response.choices[0].message.content.replace(/<think>.*?<\/think>/gs, '').trim();
    emit('success', '[STATUS] Summary generated');
    return summary;
}

async function sendNtfy(summary) {
    try {
        const response = await axios.post(process.env.NTFY_TOPIC, summary, {
            headers: {
                'Title': process.env.NTFY_TITLE,
                'Priority': process.env.NTFY_PRIORITY,
            },
        });
        emit('success', '[STATUS] Notification sent: ' + response.data.message);
    } catch (error) {
        emit('error', '[STATUS] Error sending notification: ' + error.message);
    }
}

client.on('message_create', async (msg) => {
    emit('info', `[DEBUG] Message received: "${msg.body}" | fromMe: ${msg.fromMe}`);

    // Auto-summary: count incoming group messages (not from me)
    if (!msg.fromMe) {
        const chat = await msg.getChat();
        if (chat.isGroup) {
            const id = chat.id._serialized;
            const count = (unreadCounts.get(id) || 0) + 1;
            unreadCounts.set(id, count);
            emit('info', `[AUTO] "${chat.name}" unread: ${count}/${AUTO_THRESHOLD}`);

            if (count >= AUTO_THRESHOLD) {
                unreadCounts.set(id, 0); // reset before async work
                emit('info', `[AUTO] Threshold hit for "${chat.name}" — generating summary...`);
                try {
                    const summary = await summariseChat(chat, AUTO_THRESHOLD);
                    const ntfyText = `📋 ${chat.name}\n\n${summary}`;
                    await sendNtfy(ntfyText);
                    if (_io) _io.emit('summary_done', summary);
                } catch (err) {
                    emit('error', '[AUTO ERROR] ' + err.message);
                }
            }
        }
    }

    if ((msg.body.startsWith("!summarise") || msg.body.startsWith("!summarize")) && msg.fromMe) {
        const parts = msg.body.split(" ");
        const secondArg = parts[1];
        let chat, number_of_messages;

        if (!secondArg) {
            chat = await msg.getChat();
            number_of_messages = parseInt(process.env.DEFAULT_MESSAGE_LIMIT);
        } else if (!isNaN(secondArg)) {
            chat = await msg.getChat();
            number_of_messages = parseInt(secondArg);
        } else {
            const lastArg = parts[parts.length - 1];
            const hasCount = !isNaN(lastArg) && parts.length > 2;
            number_of_messages = hasCount ? parseInt(lastArg) : parseInt(process.env.DEFAULT_MESSAGE_LIMIT);
            const groupName = hasCount ? parts.slice(1, -1).join(" ") : parts.slice(1).join(" ");

            emit('info', `[STATUS] Searching for chat: "${groupName}"`);
            const allChats = await client.getChats();
            chat = allChats.find(c => c.name?.toLowerCase() === groupName.toLowerCase())
                || allChats.find(c => c.name?.toLowerCase().includes(groupName.toLowerCase()));

            if (!chat) { emit('error', `[ERROR] No chat found matching "${groupName}"`); return; }
            emit('info', `[STATUS] Found chat: "${chat.name}"`);
        }

        try {
            const summary = await summariseChat(chat, number_of_messages);
            await sendNtfy(summary);
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

export { client, summariseChat, sendNtfy };
export function getStatus() { return { status: _status, qr: _qr }; }

