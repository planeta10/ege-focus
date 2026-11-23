// ЕДИНЫЙ источник правды о времени.
// В localStorage — АБСОЛЮТНОЕ время сессии. На сервер — только разница с подтверждённым.
// После каждого коммита startedAt = now, иначе reload задваивает время.

export interface TimerSnapshot {
  sessionKey: string | null;
  isRunning: boolean;
  startedAt: number | null;
  baseSeconds: number;
  committedSeconds: number;
  totalSeconds: number;
  updatedAt: number;
}

const KEY = 'ege-focus-timer-v3';
const LEGACY_KEYS = ['ege-focus-timer-v2', 'ege-focus-timer-v1', 'ege-focus-timer'];
const MAX_SESSION_SECONDS = 24 * 3600;

type Listener = (s: TimerSnapshot) => void;
const listeners = new Set<Listener>();
const nowMs = () => Date.now();

function fresh(): TimerSnapshot {
  return { sessionKey: null, isRunning: false, startedAt: null, baseSeconds: 0, committedSeconds: 0, totalSeconds: 0, updatedAt: nowMs() };
}

let state: TimerSnapshot = fresh();

function persist(s: TimerSnapshot) {
  state = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}
function emit() { listeners.forEach((l) => l({ ...state })); }
function save(s: TimerSnapshot) { persist(s); emit(); }

function sanitize(p: any): TimerSnapshot {
  const s = fresh();
  s.sessionKey = typeof p.sessionKey === 'string' && p.sessionKey.length >= 8 ? p.sessionKey : null;
  s.isRunning = !!p.isRunning;
  s.startedAt = typeof p.startedAt === 'number' && p.startedAt > 0 && p.startedAt <= nowMs() + 60_000 ? p.startedAt : null;
  const clamp = (v: any) => Math.min(MAX_SESSION_SECONDS, Math.max(0, Math.floor(Number(v) || 0)));
  s.baseSeconds = clamp(p.baseSeconds ?? p.accumulated ?? p.seconds ?? 0);
  s.committedSeconds = clamp(p.committedSeconds ?? 0);
  s.totalSeconds = clamp(p.totalSeconds ?? 0);
  s.totalSeconds = Math.max(s.totalSeconds, s.baseSeconds, s.committedSeconds);
  s.baseSeconds = Math.min(s.baseSeconds, s.totalSeconds);
  s.committedSeconds = Math.min(s.committedSeconds, s.totalSeconds);
  if (s.isRunning && s.startedAt == null) s.isRunning = false;
  if (!s.isRunning) s.startedAt = null;
  s.updatedAt = Number(p.updatedAt) || nowMs();
  return s;
}

function readRaw(): TimerSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
    for (const k of LEGACY_KEYS) {
      const old = localStorage.getItem(k);
      if (!old) continue;
      try { const s = sanitize(JSON.parse(old)); persist(s); return s; } catch {}
    }
  } catch {}
  return fresh();
}

if (typeof localStorage !== 'undefined') state = readRaw();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn({ ...state });
  return () => { listeners.delete(fn); };
}
export function getSnapshot(): TimerSnapshot { return { ...state }; }

export function elapsedSeconds(s: TimerSnapshot = state): number {
  const run = s.isRunning && s.startedAt != null ? Math.max(0, (nowMs() - s.startedAt) / 1000) : 0;
  return Math.min(MAX_SESSION_SECONDS, Math.max(s.totalSeconds, Math.floor(s.baseSeconds + run)));
}

function newKey(): string {
  const rnd = (globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`);
  return `s-${nowMs().toString(36)}-${rnd}`.slice(0, 64);
}

export function start(): void {
  const s = { ...state };
  if (s.isRunning) return;
  if (!s.sessionKey) s.sessionKey = newKey();
  s.baseSeconds = Math.max(s.baseSeconds, s.totalSeconds);
  s.isRunning = true;
  s.startedAt = nowMs();
  s.updatedAt = nowMs();
  save(s);
}

export function pause(): void {
  const s = { ...state };
  const total = elapsedSeconds(s);
  s.baseSeconds = total;
  s.totalSeconds = total;
  s.isRunning = false;
  s.startedAt = null;
  s.updatedAt = nowMs();
  save(s);
}

/** Раз в секунду из UI: фиксируем полное время в localStorage. */
export function tick(): void {
  const total = elapsedSeconds();
  const s = { ...state };
  if (total !== s.totalSeconds) {
    s.totalSeconds = total;
    s.updatedAt = nowMs();
    save(s);
  } else if (s.isRunning && nowMs() - s.updatedAt > 5000) {
    s.updatedAt = nowMs();
    save(s);
  }
}

export function touchAlive(_force = false): void { tick(); }
export function reconcile(): void { tick(); }

export interface Chunk { sessionKey: string; seconds: number; final: boolean; }

export function commitChunk(final = false): Chunk | null {
  const s = { ...state };
  const total = elapsedSeconds(s);
  const delta = total - s.committedSeconds;
  if (!s.sessionKey) s.sessionKey = newKey();

  if (delta < 1 && !final) {
    persist({ ...s, totalSeconds: total, updatedAt: nowMs() });
    return null;
  }

  const key = s.sessionKey!;
  const out = Math.max(0, delta);
  s.committedSeconds = total;
  s.baseSeconds = total;
  s.totalSeconds = total;
  s.updatedAt = nowMs();

  if (final) {
    persist(fresh());
    emit();
    return { sessionKey: key, seconds: out, final: true };
  }
  // КРИТИЧНО: перезапускаем отрезок, иначе reload прибавит учтённое время повторно
  if (s.isRunning) s.startedAt = nowMs();
  save(s);
  return { sessionKey: key, seconds: out, final: false };
}

export function discard(): void { save(fresh()); }

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      const incoming = sanitize(JSON.parse(e.newValue));
      if (incoming.updatedAt >= state.updatedAt) { state = incoming; emit(); }
    } catch {}
  });
}