export const BACKEND = import.meta.env.VITE_BACKEND_URL || '';

export const api = {
    get: (path) => fetch(`${BACKEND}${path}`).then(r => r.json()),
    post: (path, body) => fetch(`${BACKEND}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }),
};
