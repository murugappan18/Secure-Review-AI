import { io } from 'socket.io-client';

// Singleton Socket.IO client. Lazy-created on first call so we don't
// open a socket before the user has signed in (no JWT to hand over).
//
// The server's handshake middleware requires `auth.token`. We read it from
// the same localStorage slot the auth store persists to. If the token rotates,
// the easiest path is a page reload — but we expose disconnectSocket() so a
// signed-out → signed-in flow on the same page session also works.

let socket = null;

function readToken() {
  try {
    const raw = localStorage.getItem('sr-auth');
    if (!raw) return null;
    return JSON.parse(raw).state?.token ?? null;
  } catch {
    return null;
  }
}

export function getSocket() {
  if (socket) return socket;

  const url = import.meta.env.VITE_SOCKET_URL || window.location.origin;
  socket = io(url, {
    auth: { token: readToken() },
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // Useful in dev — keep these subdued and short.
  socket.on('connect', () => console.log('[socket] connected', socket.id));
  socket.on('disconnect', (reason) => console.log('[socket] disconnected:', reason));
  socket.on('connect_error', (err) => console.warn('[socket] connect_error:', err.message));

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
