import { useState, useEffect } from 'react';
import { useSocket } from './hooks/useSocket';
import { api } from './api';
import QRScreen from './components/QRScreen';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import SettingsModal from './components/SettingsModal';

export default function App() {
    const { status, qr, logs, summary, setSummary } = useSocket();
    const [chats, setChats] = useState([]);
    const [selectedChat, setSelectedChat] = useState(null);
    const [showSettings, setShowSettings] = useState(false);

    useEffect(() => {
        if (status === 'connected') {
            api.get('/api/chats')
                .then(data => setChats(Array.isArray(data) ? data : []))
                .catch(() => {});
        }
    }, [status]);

    if (status !== 'connected') {
        return <QRScreen qr={qr} status={status} />;
    }

    return (
        <div className="flex h-screen overflow-hidden">
            <Sidebar
                chats={chats}
                selectedId={selectedChat?.id}
                onSelect={setSelectedChat}
                onSettings={() => setShowSettings(true)}
            />
            <ChatPanel
                chat={selectedChat}
                logs={logs}
                summary={summary}
                setSummary={setSummary}
            />
            {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
        </div>
    );
}
