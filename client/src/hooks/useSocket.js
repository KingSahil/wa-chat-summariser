import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// In dev: proxy handles routing to localhost:3000
// In production (Vercel): VITE_BACKEND_URL = your Cloudflare tunnel URL
const BACKEND = import.meta.env.VITE_BACKEND_URL || '';

export function useSocket() {
    const [status, setStatus] = useState('loading');
    const [qr, setQr] = useState(null);
    const [logs, setLogs] = useState([]);
    const [summary, setSummary] = useState(null);
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = io(BACKEND, { path: '/socket.io' });
        socketRef.current = socket;

        socket.on('status', s => setStatus(s));
        socket.on('qr', q => { setQr(q); setStatus('qr'); });
        socket.on('ready', () => { setStatus('connected'); setQr(null); });
        socket.on('log', entry => setLogs(prev => [...prev.slice(-199), entry]));
        socket.on('summary_done', s => setSummary(s));

        return () => socket.disconnect();
    }, []);

    return { status, qr, logs, summary, setSummary, socket: socketRef.current };
}
