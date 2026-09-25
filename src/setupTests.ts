import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

// jsdom does not ship SubtleCrypto; use Node's real implementation so
// tests exercise genuine SHA-256 rather than the fallback hash.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// jsdom lacks a few browser APIs the dashboard touches.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
