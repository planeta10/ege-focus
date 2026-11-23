// Presence участников сквада. При остановке пир НЕ удаляется:
// публикуем isRunning=false + justFinished=true и держим секунды,
// пока сервер не подтвердит сумму (иначе строка «обнулялась»).

export interface LivePresence {
  userId: string;
  name?: string;
  isRunning: boolean;
  sessionSeconds: number;
  startedAt: number | null;
  at: number;
  justFinished?: boolean;
}

type Listener = (peers: Record<string, LivePresence>) => void;

const listeners = new Set<Listener>();
let peers: Record<string, LivePresence> = {};
let currentSquadId: string | null = null;
let me: LivePresence | null = null;
let realtimeChannel: any = null;
let connecting: Promise<void> | null = null;

let bc: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') bc = new BroadcastChannel('ege-focus-live');
} catch { bc = null; }

const emit = () => listeners.forEach((l) => l({ ...peers }));

export function subscribeLive(fn: Listener): () => void {
  listeners.add(fn);
  fn({ ...peers });
  return () => { listeners.delete(fn); };
}

export const getPeers = (): Record<string, LivePresence> => ({ ...peers });

export function connectLive(squadId: string, client: any | null): Promise<void> {
  if (currentSquadId === squadId && (realtimeChannel || !client)) return Promise.resolve();
  if (connecting) return connecting;

  connecting = (async () => {
    await disconnectLive();
    currentSquadId = squadId;
    if (!client) return;
    try {
      const ch = client.channel(`squad-live-${squadId}`, {
        config: { presence: { key: me?.userId ?? 'anon' } },
      });
      realtimeChannel = ch;
      ch.on('presence', { event: 'sync' }, () => {
        const st = ch.presenceState();
        const next: Record<string, LivePresence> = {};
        for (const key of Object.keys(st)) {
          const arr = st[key] as any[];
          const p = arr?.[arr.length - 1];
          if (p?.userId) next[p.userId] = p as LivePresence;
        }
        for (const [k, v] of Object.entries(peers)) {
          if ((v as any)._local && !next[k]) next[k] = v;
        }
        peers = next;
        emit();
      }).subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED' && me) { try { await ch.track(me); } catch {} }
      });
    } catch { realtimeChannel = null; }
  })().finally(() => { connecting = null; });

  return connecting;
}

export async function disconnectLive() {
  const ch = realtimeChannel;
  realtimeChannel = null;
  currentSquadId = null;
  if (ch) {
    try { await ch.untrack(); } catch {}
    try { ch.unsubscribe(); } catch {}
  }
  peers = {};
  emit();
}

export function publishMe(next: Omit<LivePresence, 'at'>) {
  me = { ...next, at: Date.now() };
  if (realtimeChannel) { try { realtimeChannel.track(me); } catch {} }
  if (bc) { try { bc.postMessage({ type: 'presence', payload: me }); } catch {} }
}

if (bc) {
  bc.onmessage = (ev) => {
    const m = ev.data;
    if (m?.type === 'presence' && m.payload?.userId) {
      peers = { ...peers, [m.payload.userId]: { ...m.payload, _local: true } as any };
      emit();
    }
    if (m?.type === 'bye' && m.userId) {
      // Финальные секунды завершившего участника не стираем
      if (peers[m.userId]?.justFinished) return;
      const rest = { ...peers };
      delete rest[m.userId];
      peers = rest;
      emit();
    }
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (bc && me) { try { bc.postMessage({ type: 'bye', userId: me.userId }); } catch {} }
  });
}

export function liveSeconds(p: LivePresence | undefined, now: number): number {
  if (!p) return 0;
  if (p.isRunning && p.startedAt != null) {
    return Math.max(0, p.sessionSeconds + Math.max(0, now - p.at) / 1000);
  }
  return Math.max(0, p.sessionSeconds);
}

export const isFresh = (p: LivePresence, now: number): boolean => now - p.at < 45_000;

/** Финал держим 90 с — хватает, чтобы сервер подтвердил сумму. */
export const finishedVisible = (p: LivePresence, now: number): boolean =>
  !!p.justFinished && now - p.at < 90_000;