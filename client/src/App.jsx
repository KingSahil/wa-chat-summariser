import { useState, useEffect } from 'react';
import { useSocket } from './hooks/useSocket';
import { api } from './api';
import QRScreen from './components/QRScreen';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import SettingsModal from './components/SettingsModal';
import ApiKeySetupModal from './components/ApiKeySetupModal';
import TutorialModal from './components/TutorialModal';

function generateSessionId() {
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID();

    // Fallback for non-secure contexts (http) or older browsers.
    // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const bytes = c?.getRandomValues
        ? c.getRandomValues(new Uint8Array(16))
        : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function App() {
    // Initialise session ID synchronously so api.js and useSocket can use it
    // immediately without waiting for an async effect.
    const [sessionId] = useState(() => {
        let id = localStorage.getItem('wa_session_id');
        if (!id) {
            id = generateSessionId();
            localStorage.setItem('wa_session_id', id);
        }
        return id;
    });

    const { status, qr, logs, summary, setSummary } = useSocket(sessionId);
    const [chats, setChats] = useState([]);
    const [selectedChat, setSelectedChat] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [isCheckingApiKey, setIsCheckingApiKey] = useState(true);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [hasNtfyTopic, setHasNtfyTopic] = useState(false);
    const [hasSeenTutorial, setHasSeenTutorial] = useState(true);
    const [showTutorial, setShowTutorial] = useState(false);

    useEffect(() => {
        if (status === 'connected') {
            api.get('/api/chats')
                .then(data => setChats(Array.isArray(data) ? data : []))
                .catch(() => {});

            api.get('/api/settings')
                .then(data => {
                    setHasApiKey(Boolean(data?.GROQ_API_KEY_SET));
                    setHasNtfyTopic(Boolean(data?.NTFY_TOPIC_SET));
                    const seen = Boolean(data?.TUTORIAL_SEEN);
                    setHasSeenTutorial(seen);
                    if (Boolean(data?.GROQ_API_KEY_SET) && Boolean(data?.NTFY_TOPIC_SET) && !seen) {
                        setShowTutorial(true);
                    }
                })
                .catch(() => {
                    setHasApiKey(false);
                    setHasNtfyTopic(false);
                })
                .finally(() => {
                    setIsCheckingApiKey(false);
                });
        } else {
            setIsCheckingApiKey(true);
            setHasApiKey(false);
            setHasNtfyTopic(false);
        }
    }, [status]);

    if (status !== 'connected') {
        return <QRScreen qr={qr} status={status} />;
    }

    if (isCheckingApiKey) {
        return (
            <div className="flex items-center justify-center h-screen bg-[#0b141a] text-[#8696a0] text-sm">
                Checking configuration...
            </div>
        );
    }

    function handleSelectChat(chat) {
        setSelectedChat(chat);
        if (chat.unreadCount > 0) {
            api.post(`/api/chats/${chat.id}/read`)
                .catch(() => {});
            setChats(prev => prev.map(c => c.id === chat.id ? { ...c, unreadCount: 0 } : c));
        }
    }

    return (
        <div className="flex h-screen overflow-hidden">
            <Sidebar
                chats={chats}
                selectedId={selectedChat?.id}
                onSelect={handleSelectChat}
                onSettings={() => setShowSettings(true)}
            />
            <ChatPanel
                chat={selectedChat}
                logs={logs}
                summary={summary}
                setSummary={setSummary}
            />
            {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
            {(!hasApiKey || !hasNtfyTopic) && <ApiKeySetupModal onSaved={() => {
                setHasApiKey(true);
                setHasNtfyTopic(true);
                if (!hasSeenTutorial) {
                    setShowTutorial(true);
                }
            }} />
            }
            {showTutorial && <TutorialModal onClose={() => {
                api.post('/api/settings', { TUTORIAL_SEEN: 'true' }).catch(() => {});
                setHasSeenTutorial(true);
                setShowTutorial(false);
            }} />}
        </div>
    );
}
