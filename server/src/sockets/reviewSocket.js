import Review from '../models/Review.js';
import { reviewEventBus } from './eventBus.js';

// Wire Socket.IO connection handling for the review live stream.
//
// Client emits 'subscribe:review' with { reviewId }. We verify ownership,
// join the matching room, send a 'replay' event with the current Review
// state, then forward every subsequent EventBus event for that review.

export function attachReviewSocket(io) {
  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    if (!userId) {
      socket.emit('error', { reason: 'unauthenticated' });
      socket.disconnect(true);
      return;
    }

    // Track this socket's bus listeners so we detach on disconnect.
    const listeners = new Map(); // reviewId → listener fn

    socket.on('subscribe:review', async ({ reviewId } = {}) => {
      if (!reviewId) {
        socket.emit('subscription_error', { reason: 'missing_review_id' });
        return;
      }
      // Owner check — never let a user listen to someone else's review.
      const review = await Review.findOne({ _id: reviewId, userId }).lean();
      if (!review) {
        socket.emit('subscription_error', { reason: 'review_not_found' });
        return;
      }

      const room = `review:${reviewId}`;
      socket.join(room);
      socket.emit('subscribed', { reviewId });

      // Snapshot the current persisted state so the client can render
      // anything that happened before this socket connected (e.g. a refresh
      // mid-review still sees prior phase events). Then live events stream.
      socket.emit('replay', { review });

      // Bridge bus → this specific socket. Using socket-targeted emit
      // instead of room broadcast so each subscriber gets their own copy
      // even when multiple sockets share the room (e.g. browser tabs).
      const listener = (event) => {
        socket.emit('event', event);
      };
      reviewEventBus.on(`review:${reviewId}`, listener);
      listeners.set(String(reviewId), listener);
    });

    socket.on('unsubscribe:review', ({ reviewId } = {}) => {
      const key = String(reviewId);
      const listener = listeners.get(key);
      if (listener) {
        reviewEventBus.off(`review:${reviewId}`, listener);
        listeners.delete(key);
      }
      socket.leave(`review:${reviewId}`);
    });

    socket.on('disconnect', () => {
      // Clean up every bus subscription this socket had.
      for (const [reviewId, listener] of listeners) {
        reviewEventBus.off(`review:${reviewId}`, listener);
      }
      listeners.clear();
    });
  });
}
