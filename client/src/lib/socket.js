import { io } from 'socket.io-client';

// Singleton Socket.IO client. Lazy-created on first call so we don't open
// a socket before the user has signed in (no cookie to send yet).
//
// `withCredentials: true` tells Socket.IO's underlying engine.io transport
// to include cookies on the handshake — which is where our httpOnly
// `sr_token` cookie lives. The server's io middleware reads it from the
// handshake headers and verifies the JWT.

let socket = null;

export function getSocket() {
  if (socket) return socket;

  const url = import.meta.env.VITE_SOCKET_URL || window.location.origin;
  socket = io(url, {
    withCredentials: true,
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // Useful in dev — keep these subdued and short.
  socket.on('connect', () => console.log('[socket] connected', socket.id));
  socket.on('disconnect', (reason) =>
    console.log('[socket] disconnected:', reason)
  );
  socket.on('connect_error', (err) =>
    console.warn('[socket] connect_error:', err.message)
  );

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
