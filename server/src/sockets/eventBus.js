import { EventEmitter } from 'node:events';

// Singleton in-process event bus the agent loop publishes to and the
// Socket.IO layer subscribes from. Decouples agent code from sockets so the
// orchestrator stays transport-agnostic.
//
// Event channel naming:
//   review:<reviewId>   — events about one specific review
//
// Each published event is also re-emitted on 'any' so subscribers wanting
// to log/audit every event can do so without enumerating reviews.

class ReviewEventBus extends EventEmitter {
  publish(reviewId, event) {
    const channel = `review:${reviewId}`;
    this.emit(channel, event);
    this.emit('any', { reviewId, ...event });
  }
}

export const reviewEventBus = new ReviewEventBus();

// Default EventEmitter cap is 10 — Node warns at 11. With many concurrent
// review viewers we'd trip that quickly. Bump it.
reviewEventBus.setMaxListeners(200);
