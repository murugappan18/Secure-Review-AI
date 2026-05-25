import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '../lib/socket.js';

// Subscribe to live review events. Updates the TanStack Query cache for
// `['review', reviewId]` directly so the existing ReviewTheater rendering
// works unchanged — it consumes the same useQuery result.
//
// IMPORTANT cache shape contract: ReviewTheater's queryFn returns
//   { review: Review, isOwner: boolean }
// so every cache write here MUST preserve that wrapper. An earlier version
// of this file stored the raw Review object directly, which silently broke
// the page when a socket replay landed (data.review became undefined and
// the body rendered blank).
//
// Returns { connected, lastEventAt } purely for UI affordances
// (e.g., a "LIVE" pulse indicator).

export function useReviewStream(reviewId, { enabled = true } = {}) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState(null);

  useEffect(() => {
    if (!enabled || !reviewId) return;
    const socket = getSocket();

    const setConn = (v) => () => setConnected(v);
    socket.on('connect', setConn(true));
    socket.on('disconnect', setConn(false));
    if (socket.connected) setConnected(true);

    // Server pushes the current full review state on subscribe. Re-wrap
    // into the { review, isOwner } shape the query cache uses. We assume
    // isOwner=true because socket replay is only delivered to authenticated
    // subscribers (handshake middleware rejects unauthenticated sockets).
    function handleReplay({ review }) {
      queryClient.setQueryData(['review', reviewId], (old) =>
        old ? { ...old, review } : { review, isOwner: true }
      );
    }

    function handleEvent(event) {
      setLastEventAt(Date.now());
      queryClient.setQueryData(['review', reviewId], (old) => {
        if (!old) return old;
        // applyEvent operates on the INNER review. Unwrap, mutate, re-wrap.
        return { ...old, review: applyEvent(old.review, event) };
      });
      // On terminal events, the server has persisted the final findings
      // array and summary; refetch to pull them in.
      if (
        event.type === 'review_complete' ||
        event.type === 'review_failed' ||
        event.type === 'review_stopped'
      ) {
        queryClient.invalidateQueries({ queryKey: ['review', reviewId] });
      }
    }
    function handleSubscriptionError(err) {
      console.warn('[stream] subscription_error', err);
    }

    socket.on('replay', handleReplay);
    socket.on('event', handleEvent);
    socket.on('subscription_error', handleSubscriptionError);

    socket.emit('subscribe:review', { reviewId });

    return () => {
      socket.emit('unsubscribe:review', { reviewId });
      socket.off('replay', handleReplay);
      socket.off('event', handleEvent);
      socket.off('subscription_error', handleSubscriptionError);
      socket.off('connect', setConn(true));
      socket.off('disconnect', setConn(false));
    };
  }, [reviewId, enabled, queryClient]);

  return { connected, lastEventAt };
}

// Mutate the cached Review document for each incremental event so the UI
// renders the live progress without re-fetching. Operates on the INNER
// review object — the caller is responsible for unwrapping/rewrapping
// the { review, isOwner } cache wrapper.
function applyEvent(review, event) {
  if (!review) return review;
  const now = new Date().toISOString();
  switch (event.type) {
    case 'review_start':
      return { ...review, status: 'running', startedAt: now };

    case 'pr_metadata':
      return { ...review, prTitle: event.title };

    case 'phase_start': {
      const phases = [...(review.phases ?? [])];
      // Don't double-add if a replay already has it.
      if (!phases.some((p) => p.name === event.phase && !p.completedAt)) {
        phases.push({ name: event.phase, startedAt: now });
      }
      return { ...review, phases };
    }

    case 'phase_complete': {
      const phases = [...(review.phases ?? [])];
      const idx = lastUncompletedPhaseIndex(phases, event.phase);
      if (idx >= 0) {
        phases[idx] = {
          ...phases[idx],
          completedAt: now,
          durationMs: event.durationMs,
          output: event.output,
        };
      } else {
        phases.push({
          name: event.phase,
          startedAt: now,
          completedAt: now,
          durationMs: event.durationMs,
          output: event.output,
        });
      }
      return { ...review, phases };
    }

    case 'phase_error': {
      const phases = [...(review.phases ?? [])];
      const idx = lastUncompletedPhaseIndex(phases, event.phase);
      if (idx >= 0) {
        phases[idx] = {
          ...phases[idx],
          completedAt: now,
          error: event.error,
        };
      }
      return { ...review, phases };
    }

    case 'tool_call': {
      const toolCalls = [...(review.toolCalls ?? [])];
      toolCalls.push({
        phase: event.phase,
        tool: event.tool,
        arguments: event.arguments,
        timestamp: now,
        // result and durationMs come on the matching tool_result.
      });
      return { ...review, toolCalls };
    }

    case 'tool_result': {
      const toolCalls = [...(review.toolCalls ?? [])];
      // Most-recent matching tool_call without a result.
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        const tc = toolCalls[i];
        if (
          tc.tool === event.tool &&
          tc.phase === event.phase &&
          tc.result === undefined
        ) {
          toolCalls[i] = {
            ...tc,
            result: event.result,
            durationMs: event.durationMs,
            error: event.result?.error ?? null,
          };
          return { ...review, toolCalls };
        }
      }
      // Fallback: no matching tool_call (replay edge case) — append.
      toolCalls.push({
        phase: event.phase,
        tool: event.tool,
        result: event.result,
        durationMs: event.durationMs,
        timestamp: now,
      });
      return { ...review, toolCalls };
    }

    case 'review_complete':
      return {
        ...review,
        status: 'complete',
        completedAt: now,
        durationMs: event.durationMs,
        tokensUsed: event.tokensUsed,
      };

    case 'review_failed':
      return {
        ...review,
        status: 'failed',
        statusMessage: event.error,
        completedAt: now,
      };

    case 'review_stopped':
      return {
        ...review,
        status: 'stopped',
        statusMessage: event.error ?? 'Stopped by user',
        completedAt: now,
      };

    default:
      return review;
  }
}

function lastUncompletedPhaseIndex(phases, name) {
  for (let i = phases.length - 1; i >= 0; i--) {
    if (phases[i].name === name && !phases[i].completedAt) return i;
  }
  return -1;
}
