// Единый источник правды для таймера. Время считается по Date.now().
// sessionKey — один на всю сессию (старт → паузы → стоп). Все чанки уходят на сервер
// с этим ключом, поэтому 5-минутные автосохранения ОБНОВЛЯЮТ одну сессию, а не плодят новые.
export interface TimerSnapshot {
  isRunning: boolean;
  accumulatedMs: number;
  startedAt: number | null;
  updatedAt: number;
  sessionKey: string | null;
  committedSeconds: number; // сколько секунд сессии уже вынесено в очередь/на сервер
}

const KEY = 'ege-focus-timer';
const CHANNEL = 'ege-focus-timer-sync';
export const MIN_SESSION_SECONDS = 60;

const empty: TimerSnapshot = {
  isRunning: false, accumulatedMs: 0, startedAt: null, updatedAt: 0, sessionKey: null, committedSeconds: 0,
};

function load(): TimerSnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...empty };
    const p = JSON.parse(raw);
    if (typeof p?.accumulatedMs !== 'number') return { ...empty };
    return {
      isRunning: Boolean(p.isRunning),
      accumulatedMs: Math.max(0, p.accumulatedMs),
      startedAt: typeof p.startedAt === 'number' ? p.startedAt : null,
      updatedAt: Number(p.updatedAt) || 0,
      sessionKey: typeof p.sessionKey === 'string' ? p.sessionKey : null,
      committedSeconds: Math.max(0, Number(p.committedSeconds) || 0),
    };
  } catch { return { ...empty }; }
}

let state: TimerSnapshot = load();
const listeners = new Set<(s: TimerSnapshot) => void>();

let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(CHANNEL);
} catch { channel = null; }

function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
function emit(broadcast = true) {
  persist();
  listeners.forEach((l) => l(state));
  if (broadcast && channel) { try { channel.postMessage(state); } catch {} }
}

function newKey(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `${Date.now()}-${rnd}`;
}

export function elapsedSeconds(s: TimerSnapshot = state): number {
  const running = s.isRunning && s.startedAt != null ? Date.now() - s.startedAt : 0;
  return Math.max(0, (s.accumulatedMs + Math.max(0, running)) / 1000);
}

export const getSnapshot = (): TimerSnapshot => state;

export function subscribe(fn: (s: TimerSnapshot) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function start() {
  if (state.isRunning) return;
  state = {
    ...state,
    isRunning: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    sessionKey: state.sessionKey ?? newKey(),
  };
  emit();
}

export function pause(): number {
  const ms = elapsedSeconds() * 1000;
  state = { ...state, isRunning: false, accumulatedMs: ms, startedAt: null, updatedAt: Date.now() };
  emit();
  return Math.floor(ms / 1000);
}

/**
 * Забрать НОВЫЙ кусок времени вместе с ключом СЕССИИ.
 * Таймер на экране НЕ сбрасывается. final=true — конец сессии («Стоп»).
 * Ключ у всех кусков один и тот же — сервер обновляет одну строку сессии.
 * Сессия короче минуты целиком (случайный старт) отбрасывается.
 */
export function commitChunk(final = false): { seconds: number; sessionKey: string; final: boolean } | null {
  if (!state.sessionKey) { if (final) reset(); return null; }
  const total = Math.floor(elapsedSeconds());
  const delta = total - state.committedSeconds;
  if (final && state.committedSeconds === 0 && total < MIN_SESSION_SECONDS) { reset(); return null; }
  if (delta < 1) {
    if (final) {
      // всё уже отправлено чанками — просто закрываем сессию на сервере нулевым финалом
      const key = state.sessionKey;
      reset();
      return { seconds: 0, sessionKey: key, final: true };
    }
    return null;
  }
  if (!final && delta < MIN_SESSION_SECONDS) return null;
  const key = state.sessionKey;
  state = final
    ? { ...empty, updatedAt: Date.now() }
    : { ...state, committedSeconds: state.committedSeconds + delta, updatedAt: Date.now() };
  emit();
  return { seconds: delta, sessionKey: key, final };
}

// «Пульс»: если таймер шёл, а страницы не было больше 6 часов (забыл остановить),
// сессия заканчивается в момент последнего пульса.
const ALIVE_KEY = 'ege-focus-timer-alive';
const MAX_GAP_MS = 6 * 3600_000;

export function touchAlive(force = false) {
  if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  try { localStorage.setItem(ALIVE_KEY, String(Date.now())); } catch {}
}

export function reconcile() {
  if (!state.isRunning || state.startedAt == null) return;
  let alive = 0;
  try { alive = Number(localStorage.getItem(ALIVE_KEY)) || 0; } catch {}
  if (alive > state.startedAt && Date.now() - alive > MAX_GAP_MS) {
    state = { ...state, isRunning: false, accumulatedMs: state.accumulatedMs + (alive - state.startedAt), startedAt: null, updatedAt: Date.now() };
    emit();
  }
}

export function reset() { state = { ...empty, updatedAt: Date.now() }; emit(); }

if (channel) {
  channel.onmessage = (ev: MessageEvent<TimerSnapshot>) => {
    const incoming = ev.data;
    if (incoming && incoming.updatedAt > state.updatedAt) {
      state = incoming; persist(); listeners.forEach((l) => l(state));
    }
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      const incoming: TimerSnapshot = JSON.parse(e.newValue);
      if (incoming.updatedAt > state.updatedAt) {
        state = incoming; listeners.forEach((l) => l(state));
      }
    } catch {}
  });
}

reconcile();