import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request AbortSignal storage. Set in the route handler when a review is
// kicked off, propagated through the entire async chain via AsyncLocalStorage.
// The Gemini throttle reads it to interrupt sleeps when a user clicks Stop.
//
// This is intentionally a SEPARATE ALS from userContext.js — that one carries
// BYOK keys, this one only carries an abort signal. Mixing them would mean
// every request's userContext has to be re-created if the signal changes,
// which is awkward.

const als = new AsyncLocalStorage();

export function runWithAbortContext(signal, fn) {
  return als.run({ signal }, fn);
}

export function getCurrentAbortSignal() {
  return als.getStore()?.signal ?? null;
}
