import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { supabase, friendlyNetworkError, withTimeout, retryResult } from '../lib/supabase';

interface Profile { id: string; username: string; name: string; avatar_color: string; squad_id: string | null; }
interface Squad { id: string; name: string; invite_code: string; created_by: string; }
interface LeaderboardEntry extends Profile { total_seconds: number; }
export interface WeekLeaderboardEntry extends Profile {
  week_seconds: number; today_seconds: number;
  active_days: number; sessions_count: number; focus_score: number;
}
interface BannedUser { id: string; name: string; username: string; avatar_color: string; }
interface UserStats { total_seconds: number; today_seconds: number; week_seconds: number; sessions_count: number; }
interface SessionRow { id: string; duration_seconds: number; created_at: string; }

interface StoreState {
  user: Profile | null;
  token: string | null;
  squad: Squad | null;
  leaderboard: LeaderboardEntry[];
  weekBoard: WeekLeaderboardEntry[];
  bans: BannedUser[];
  stats: UserStats | null;
  sessions: SessionRow[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  syncError: string | null;
  lastSyncAt: number | null;
  registerByUsername: (username: string, name: string, password: string) => Promise<void>;
  loginByUsername: (username: string, password: string) => Promise<void>;
  createSquad: (name: string) => Promise<void>;
  joinSquad: (code: string) => Promise<void>;
  leaveSquad: () => Promise<void>;
  /** Отправить ПРИРОСТ секунд текущей сессии. Одна сессия = одна строка на сервере. */
  syncTime: (sessionKey: string, deltaSeconds: number, final?: boolean) => Promise<boolean>;
  fetchLeaderboard: () => Promise<void>;
  fetchWeekLeaderboard: () => Promise<void>;
  fetchStats: () => Promise<void>;
  fetchSessions: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  fetchBans: () => Promise<void>;
  banMember: (targetId: string) => Promise<void>;
  unbanMember: (targetId: string) => Promise<void>;
  signOut: () => void;
  logoutEverywhere: () => Promise<void>;
}

const num = (v: unknown) => Number(v) || 0;

const inflight = new Map<string, Promise<void>>();
function dedupe(key: string, fn: () => Promise<void>): Promise<void> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- Очередь неотправленных чанков (переживает закрытие вкладки) ----------
const PENDING_KEY = 'ege-focus-pending-v2';
type PendingItem = { userId: string; sessionKey: string; seconds: number; final: boolean; at: number };

function readPending(): PendingItem[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return (Array.isArray(arr) ? arr : []).filter(
      (p) => p && typeof p.userId === 'string' && typeof p.sessionKey === 'string' && Number(p.seconds) >= 0,
    );
  } catch { return []; }
}
function writePending(items: PendingItem[]) {
  try {
    if (items.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(items.slice(-500)));
  } catch {}
}
/** Кладём/дописываем чанк в очередь ДО отправки. Чанки одной сессии склеиваются. */
export function queuePendingChunk(userId: string, sessionKey: string, seconds: number, final: boolean) {
  const items = readPending();
  const existing = items.find((p) => p.userId === userId && p.sessionKey === sessionKey && !p.final);
  if (existing) {
    existing.seconds += Math.floor(seconds);
    existing.final = existing.final || final;
    existing.at = Date.now();
  } else {
    items.push({ userId, sessionKey, seconds: Math.floor(seconds), final, at: Date.now() });
  }
  writePending(items);
}
export function getPendingFor(userId: string): PendingItem[] {
  return readPending().filter((p) => p.userId === userId);
}
/** Сколько секунд лежит в очереди и ещё не подтверждено сервером. */
export function pendingSecondsFor(userId: string): number {
  return getPendingFor(userId).reduce((a, p) => a + p.seconds, 0);
}
function removePending(userId: string, sessionKey: string) {
  writePending(readPending().filter((p) => !(p.userId === userId && p.sessionKey === sessionKey)));
}

// ---------- Токен сессии: sessionStorage, не localStorage ----------
const TOKEN_KEY = 'ege-focus-token';
function readToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// Один ключ сессии не отправляется параллельно дважды
const syncingKeys = new Set<string>();
let lastSquadFetch = 0;

const AUTH_RE = /AUTH_REQUIRED/i;

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      user: null, token: readToken(), squad: null, leaderboard: [], weekBoard: [], bans: [], stats: null, sessions: [],
      isLoading: false, isRefreshing: false, error: null, syncError: null, lastSyncAt: null,

      registerByUsername: async (username, name, password) => {
        set({ isLoading: true, error: null });
        const cleanUsername = username.replace(/[@\s]/g, '').toLowerCase();
        try {
          const { data, error } = await retryResult(() =>
            supabase.rpc('register_user', { input_username: cleanUsername, input_name: name.trim(), p_password: password }),
          );
          if (error) throw new Error(error.message);
          if (!data?.token || !data?.profile) throw new Error('Сервер не вернул профиль');
          writeToken(data.token as string);
          set({ user: data.profile as Profile, token: data.token as string, squad: null, isLoading: false });
          get().fetchStats();
        } catch (e) {
          const msg = friendlyNetworkError(e);
          set({ isLoading: false, error: /USERNAME_TAKEN/i.test(msg) ? 'Этот ник уже занят — перейди на вкладку «Вход»' : msg.replace(/^.*?:\s*/, '') });
        }
      },

      loginByUsername: async (username, password) => {
        set({ isLoading: true, error: null });
        const cleanUsername = username.replace(/[@\s]/g, '').toLowerCase();
        try {
          const { data, error } = await retryResult(() =>
            supabase.rpc('login_with_password', { input_username: cleanUsername, p_password: password }),
          );
          if (error) throw new Error(error.message);
          if (!data?.token || !data?.profile) throw new Error('Сервер не вернул профиль');
          const profile = data.profile as Profile;
          writeToken(data.token as string);
          set({ user: profile, token: data.token as string, isLoading: false });
          if (profile.squad_id) get().fetchLeaderboard();
          get().fetchStats();
          flushPendingChunks();
        } catch (e) {
          const msg = friendlyNetworkError(e);
          set({
            isLoading: false,
            error: /RATE_LIMITED/i.test(msg) ? 'Слишком много попыток входа. Подожди 15 минут.'
              : /INVALID_LOGIN/i.test(msg) ? 'Неверный ник или пароль'
              : msg.replace(/^.*?:\s*/, ''),
          });
        }
      },

      createSquad: async (name) => {
        const { user, token } = get();
        if (!user || !token || !name.trim()) return;
        set({ error: null });
        try {
          const { data: squad, error } = await withTimeout(
            supabase.rpc('create_squad', { p_token: token, p_name: name.trim() }),
          );
          if (error || !squad) throw new Error(error?.message || 'Не удалось создать сквад');
          set({ squad: squad as Squad, user: { ...user, squad_id: (squad as Squad).id } });
          get().fetchLeaderboard();
        } catch (e) { set({ error: friendlyNetworkError(e) }); }
      },

      joinSquad: async (code) => {
        const { user, token } = get();
        if (!user || !token || !code.trim()) return;
        set({ error: null });
        try {
          const { data: squad, error } = await withTimeout(
            supabase.rpc('join_squad', { p_token: token, p_code: code.trim().toUpperCase() }),
          );
          if (error || !squad) {
            const msg = error?.message ?? '';
            throw new Error(msg.includes('BANNED') ? 'Админ сквада заблокировал тебя в этом скваде' : msg || 'Сквад с таким кодом не найден');
          }
          const s = squad as Squad;
          set({ squad: s, user: { ...user, squad_id: s.id } });
          get().fetchLeaderboard();
        } catch (e) { set({ error: friendlyNetworkError(e) }); }
      },

      leaveSquad: async () => {
        const { user, token } = get();
        if (!user || !token) return;
        try {
          const { error } = await withTimeout(supabase.rpc('leave_squad', { p_token: token }));
          if (error) throw new Error(error.message);
        } catch (e) { set({ error: friendlyNetworkError(e) }); return; }
        set({ squad: null, user: { ...user, squad_id: null }, leaderboard: [], weekBoard: [], bans: [] });
      },

      // Чанки каждые 5 минут ОБНОВЛЯЮТ одну сессию на сервере.
      // Сервер режет время по реально прошедшим секундам и игнорит повторы.
      syncTime: async (sessionKey, deltaSeconds, final = false) => {
        const { user, token } = get();
        if (!user || !token) return false;
        const delta = Math.floor(deltaSeconds);
        if (delta < 1 && !final) return false;
        const lockKey = `${user.id}:${sessionKey}`;
        if (syncingKeys.has(lockKey)) return false;
        syncingKeys.add(lockKey);
        queuePendingChunk(user.id, sessionKey, delta, final);
        try {
          const { error } = await retryResult(() =>
            supabase.rpc('sync_study_time', {
              p_token: token, p_session_key: sessionKey, p_delta_seconds: delta, p_final: final,
            }),
          );
          if (error) throw new Error(error.message ?? String(error));
          removePending(user.id, sessionKey);
          set({ syncError: null });
          get().fetchLeaderboard();
          get().fetchStats();
          return true;
        } catch (e) {
          const msg = friendlyNetworkError(e);
          if (AUTH_RE.test(msg)) {
            set({ syncError: 'Сессия входа истекла — войди заново, время сохранено на устройстве.' });
          } else if (/TOO_MANY_SESSIONS/i.test(msg)) {
            set({ syncError: 'Слишком много незавершённых сессий. Заверши текущую и попробуй снова.' });
          } else {
            set({ syncError: 'Время пока не отправилось — оно сохранено на устройстве и уйдёт автоматически.' });
          }
          return false;
        } finally {
          syncingKeys.delete(lockKey);
        }
      },

      fetchLeaderboard: () => dedupe('leaderboard', async () => {
        const { user, token } = get();
        if (!user?.squad_id || !token) { set({ leaderboard: [] }); return; }
        set({ isRefreshing: true });
        // Сквад обновляем через RPC: прямой доступ к таблицам закрыт RLS
        if (Date.now() - lastSquadFetch > 60_000) {
          lastSquadFetch = Date.now();
          Promise.resolve(supabase.rpc('get_my_squad', { p_token: token }))
            .then(({ data }) => {
              const sq = Array.isArray(data) ? data[0] : data;
              if (sq) set({ squad: sq as Squad });
            })
            .catch(() => { lastSquadFetch = 0; });
        }
        try {
          const { data, error } = await retryResult(() =>
            supabase.rpc('get_squad_leaderboard', { p_token: token }),
          );
          if (error) throw new Error(error.message);
          const cleanData: LeaderboardEntry[] = (data ?? []).map((i: any) => ({ ...i, total_seconds: num(i.total_seconds) }));
          if (!cleanData.some((e) => e.id === user.id)) {
            set({ squad: null, user: { ...user, squad_id: null }, leaderboard: [], weekBoard: [], bans: [], isRefreshing: false });
            return;
          }
          set({ leaderboard: cleanData, isRefreshing: false, lastSyncAt: Date.now() });
        } catch (e) {
          set({ isRefreshing: false, syncError: friendlyNetworkError(e) });
        }
      }),

      fetchWeekLeaderboard: () => dedupe('weekBoard', async () => {
        const { user, token } = get();
        if (!user?.squad_id || !token) { set({ weekBoard: [] }); return; }
        try {
          const { data, error } = await retryResult(() =>
            supabase.rpc('get_squad_week_leaderboard', { p_token: token }),
          );
          if (error) throw new Error(error.message);
          set({ weekBoard: (data ?? []).map((i: any): WeekLeaderboardEntry => ({
            ...i,
            week_seconds: num(i.week_seconds), today_seconds: num(i.today_seconds),
            active_days: num(i.active_days), sessions_count: num(i.sessions_count),
            focus_score: num(i.focus_score),
          })) });
        } catch (e) { set({ syncError: friendlyNetworkError(e) }); }
      }),

      fetchStats: () => dedupe('stats', async () => {
        const { user, token } = get();
        if (!user || !token) return;
        try {
          const { data, error } = await retryResult(() => supabase.rpc('get_user_stats', { p_token: token }));
          if (error) throw new Error(error.message);
          const row = Array.isArray(data) ? data[0] : data;
          if (row) set({ stats: {
            total_seconds: num(row.total_seconds), today_seconds: num(row.today_seconds),
            week_seconds: num(row.week_seconds), sessions_count: num(row.sessions_count),
          }});
        } catch (e) { set({ syncError: friendlyNetworkError(e) }); }
      }),

      fetchBans: () => dedupe('bans', async () => {
        const { user, squad, token } = get();
        if (!user || !squad || !token || squad.created_by !== user.id) { set({ bans: [] }); return; }
        try {
          const { data, error } = await withTimeout(supabase.rpc('get_squad_bans', { p_token: token }));
          if (error) throw new Error(error.message);
          set({ bans: (data ?? []) as BannedUser[] });
        } catch (e) { set({ syncError: friendlyNetworkError(e) }); }
      }),

      banMember: async (targetId) => {
        const { token } = get();
        if (!token) return;
        set({ error: null });
        try {
          const { error } = await withTimeout(supabase.rpc('ban_squad_member', { p_token: token, p_target_id: targetId }));
          if (error) throw new Error(error.message);
          await Promise.all([get().fetchLeaderboard(), get().fetchWeekLeaderboard(), get().fetchBans()]);
        } catch (e) { set({ error: friendlyNetworkError(e) }); }
      },

      unbanMember: async (targetId) => {
        const { token } = get();
        if (!token) return;
        set({ error: null });
        try {
          const { error } = await withTimeout(supabase.rpc('unban_squad_member', { p_token: token, p_target_id: targetId }));
          if (error) throw new Error(error.message);
          await get().fetchBans();
        } catch (e) { set({ error: friendlyNetworkError(e) }); }
      },

      fetchSessions: () => dedupe('sessions', async () => {
        const { user, token } = get();
        if (!user || !token) return;
        try {
          const { data, error } = await retryResult(() => supabase.rpc('get_user_sessions', { p_token: token, p_limit: 30 }));
          if (error) throw new Error(error.message);
          set({ sessions: (data ?? []).map((s: any) => ({ ...s, duration_seconds: num(s.duration_seconds) })) });
        } catch (e) { set({ syncError: friendlyNetworkError(e) }); }
      }),

      deleteSession: async (sessionId) => {
        const { user, token } = get();
        if (!user || !token) return;
        const prev = get().sessions;
        set({ sessions: prev.filter((s) => s.id !== sessionId) });
        try {
          const { error } = await withTimeout(supabase.rpc('delete_study_session', { p_token: token, p_session_id: sessionId }));
          if (error) throw new Error(error.message);
          await Promise.all([get().fetchSessions(), get().fetchStats(), get().fetchLeaderboard()]);
        } catch (e) { set({ sessions: prev, syncError: friendlyNetworkError(e) }); }
      },

      logoutEverywhere: async () => {
        const { token } = get();
        if (token) {
          try { await withTimeout(supabase.rpc('logout_all_devices', { p_token: token })); } catch {}
        }
        get().signOut();
      },

      signOut: () => {
        const { token } = get();
        if (token) { try { supabase.rpc('logout_user', { p_token: token }); } catch {} }
        writeToken(null);
        set({
          user: null, token: null, squad: null, leaderboard: [], weekBoard: [], bans: [], stats: null, sessions: [],
          error: null, syncError: null, lastSyncAt: null,
        });
      },
    }),
    {
      name: 'ege-focus-storage-v2',
      partialize: (s) => ({ user: s.user, squad: s.squad, leaderboard: s.leaderboard, weekBoard: s.weekBoard, stats: s.stats, sessions: s.sessions }),
    },
  ),
);

// ---------- Автодосылка очереди ----------
let flushing = false;
export async function flushPendingChunks(): Promise<void> {
  if (flushing) return;
  const { user, token, syncTime } = useStore.getState();
  if (!user || !token) return;
  const mine = getPendingFor(user.id);
  if (mine.length === 0) return;
  flushing = true;
  try {
    for (const p of mine) {
      const ok = await syncTime(p.sessionKey, p.seconds, p.final);
      if (!ok) break;
    }
  } finally { flushing = false; }
}

if (typeof window !== 'undefined') {
  const kick = () => { if (document.visibilityState === 'visible') flushPendingChunks(); };
  setInterval(kick, 20_000);
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', kick);
}