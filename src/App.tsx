import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Trophy, Clock, LogOut, Users, Plus, LogIn, Copy, XCircle, BarChart3, Ban, Crown, UserCheck, Trash2, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { supabase, isSupabaseConfigured, SUPABASE_URL, SUPABASE_KEY } from './lib/supabase';
import { useStore, flushPendingChunks, queuePendingChunk, getPendingFor, pendingSecondsFor } from './store/useStore';
import * as T from './lib/timer';
import { connectLive, disconnectLive, publishMe, subscribeLive, liveSeconds, isFresh, finishedVisible, type LivePresence } from './lib/live';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'framer-motion';
import { useLiquidGlass } from './lib/liquidGlass';

const fmt = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}`;
};
const fmtShort = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
};

const pageVariants = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 }
};

type View = 'timer' | 'leaderboard' | 'stats';
const AUTOSAVE_EVERY = 300;
const POLL_MS = 20_000;
const HEARTBEAT_MS = 15_000;

type TabItem = { id: View; icon: typeof Clock; label: string };

function TabBar({ tabs, view, onChange }: { tabs: TabItem[]; view: View; onChange: (v: View) => void }) {
  const navRef = useRef<HTMLElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const viewRef = useRef(view);
  const restW = useRef(0);
  const first = useRef(true);
  const left = useMotionValue(0);
  const right = useMotionValue(0);
  const width = useTransform([left, right], (v: number[]) => Math.max(v[1] - v[0], 8));
  const scaleY = useTransform(width, (w: number) => Math.min(1.14, Math.max(0.72, (restW.current || w) / w)));

  const measure = (id: string) => {
    const b = btnRefs.current[id];
    return b ? { l: b.offsetLeft, r: b.offsetLeft + b.offsetWidth } : null;
  };

  useLayoutEffect(() => {
    viewRef.current = view;
    const t = measure(view);
    if (!t) return;
    restW.current = t.r - t.l;
    if (first.current) {
      first.current = false;
      left.set(t.l);
      right.set(t.r);
      return;
    }
    const goingRight = t.l > left.get();
    const lead = { type: 'spring', stiffness: 300, damping: 17, mass: 0.9 } as const;
    const lag = { type: 'spring', stiffness: 110, damping: 14, mass: 1.15 } as const;
    const a = animate(left, t.l, goingRight ? lag : lead);
    const b = animate(right, t.r, goingRight ? lead : lag);
    return () => { a.stop(); b.stop(); };
  }, [view]);

  useEffect(() => {
    if (!navRef.current) return;
    const ro = new ResizeObserver(() => {
      const t = measure(viewRef.current);
      if (!t) return;
      restW.current = t.r - t.l;
      left.set(t.l);
      right.set(t.r);
    });
    ro.observe(navRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <nav ref={navRef} data-liquid-group className="glass tabbar fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 rounded-full p-1.5 flex gap-1 z-50">
      <motion.div aria-hidden className="glass-raised absolute top-1.5 bottom-1.5 left-0 rounded-full pointer-events-none" style={{ x: left, width, scaleY }} />
      {tabs.map(tab => (
        <button key={tab.id} ref={el => { btnRefs.current[tab.id] = el; }} onClick={() => onChange(tab.id)}
          className={clsx("tabbar-btn relative z-10 flex items-center gap-2 px-5 py-3 rounded-full text-sm font-medium transition-colors", view === tab.id ? 'text-white' : 'text-white/50 hover:text-white/80')}>
          <tab.icon size={18} /> <span className="tabbar-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

export default function App() {
  const {
    user, token, squad, leaderboard, weekBoard, bans, stats, sessions, isLoading, isRefreshing, error, syncError, lastSyncAt,
    registerByUsername, loginByUsername, createSquad, joinSquad, leaveSquad, syncTime,
    fetchLeaderboard, fetchWeekLeaderboard, fetchStats, fetchSessions, deleteSession, fetchBans, banMember, unbanMember, signOut
  } = useStore();

  useLiquidGlass();

  const [view, setView] = useState<View>('timer');
  const [squadTab, setSquadTab] = useState<'focus' | 'time'>('focus');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [squadCode, setSquadCode] = useState('');
  const [newSquadName, setNewSquadName] = useState('');
  const [showCopyTooltip, setShowCopyTooltip] = useState(false);
  const [snap, setSnap] = useState<T.TimerSnapshot>(T.getSnapshot());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => T.subscribe(setSnap), []);

  // Каждую секунду фиксируем ПОЛНОЕ время сессии в localStorage.
  // Перезагрузка восстанавливает тот же total — задвоения нет.
  useEffect(() => {
    const beat = () => { T.tick(); setNow(Date.now()); };
    beat();
    const id = window.setInterval(beat, 1000);
    const wake = () => beat();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, []);

  const seconds = Math.floor(T.elapsedSeconds(snap));
  const isRunning = snap.isRunning;
  const isAdmin = !!(user && squad && squad.created_by === user.id);
  const committed = snap.committedSeconds;
  const unsynced = user ? Math.max(0, seconds - committed) + pendingSecondsFor(user.id) : 0;

  const [peers, setPeers] = useState<Record<string, LivePresence>>({});
  useEffect(() => subscribeLive(setPeers), []);

  useEffect(() => {
    if (!user?.squad_id) { disconnectLive(); return; }
    connectLive(user.squad_id, isSupabaseConfigured ? supabase : null);
    return () => { disconnectLive(); };
  }, [user?.squad_id]);

  const broadcast = useCallback((finishedSeconds?: number) => {
    if (!user) return;
    const s = T.getSnapshot();
    const finished = typeof finishedSeconds === 'number';
    publishMe({
      userId: user.id,
      name: user.name,
      isRunning: s.isRunning,
      sessionSeconds: finished ? finishedSeconds! : Math.floor(T.elapsedSeconds(s)),
      startedAt: s.startedAt,
      justFinished: finished,
    });
  }, [user?.id, user?.name]);

  useEffect(() => { broadcast(); }, [snap.updatedAt, broadcast]);

  useEffect(() => {
    if (!user?.squad_id) return;
    const id = window.setInterval(() => broadcast(), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [user?.squad_id, broadcast]);

  // Фиксируем АБСОЛЮТНЫЙ total до отправки — переживает перезагрузку.
  const commitAndSend = useCallback((final = false) => {
    if (!user) return null;
    T.tick();
    const before = T.getSnapshot();
    const totalNow = T.elapsedSeconds(before);
    if (before.sessionKey) queuePendingChunk(user.id, before.sessionKey, totalNow, final);
    const c = T.commitChunk(final);
    if (!c) return null;
    // шлём ПОЛНЫЙ объём сессии — syncTime сам вычтет уже подтверждённое
    syncTime(c.sessionKey, totalNow, c.final);
    return c;
  }, [user?.id, syncTime]);

  useEffect(() => {
    if (user && isRunning && seconds - committed >= AUTOSAVE_EVERY) commitAndSend(false);
  }, [seconds, committed, isRunning, user?.id]);

  useEffect(() => {
    T.touchAlive();
    const id = window.setInterval(() => T.touchAlive(), 10_000);
    const onVis = () => { if (document.visibilityState === 'visible') T.reconcile(); else T.touchAlive(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  useEffect(() => {
    if (!user || !token) return;
    flushPendingChunks();
    if (user.squad_id) fetchLeaderboard();
    fetchStats();
  }, [user?.id, user?.squad_id, token]);

  useEffect(() => {
    if (!user) return;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (view === 'leaderboard') { fetchLeaderboard(); fetchWeekLeaderboard(); if (isAdmin) fetchBans(); }
      if (view === 'stats') { fetchStats(); fetchSessions(); }
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [view, user?.id, user?.squad_id, isAdmin, fetchLeaderboard, fetchWeekLeaderboard, fetchBans, fetchStats, fetchSessions]);

  // Уход со страницы: таймер не останавливаем, кладём абсолютный total в очередь
  // и пробуем дослать keepalive-запросом.
  useEffect(() => {
    if (!user || !token) return;
    const flush = () => {
      T.tick();
      const before = T.getSnapshot();
      const totalNow = T.elapsedSeconds(before);
      if (before.sessionKey) queuePendingChunk(user.id, before.sessionKey, totalNow, false);
      T.commitChunk(false);
      if (!SUPABASE_URL || !SUPABASE_KEY) return;
      for (const p of getPendingFor(user.id)) {
        const delta = Math.max(0, p.total - p.sent);
        if (delta < 1 && !p.final) continue;
        fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_study_time`, {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
          body: JSON.stringify({ p_token: token, p_session_key: p.sessionKey, p_delta_seconds: delta, p_final: p.final }),
        }).catch(() => {});
      }
    };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onVis); };
  }, [user?.id, token]);

  const handleToggle = () => {
    if (isRunning) { T.pause(); commitAndSend(false); }
    else T.start();
    broadcast();
  };

  const handleStop = () => {
    if (!user) return;
    const total = Math.floor(T.elapsedSeconds());
    const c = commitAndSend(true);
    broadcast(c ? total : 0);
  };

  const submitAuth = () => {
    if (authMode === 'register') registerByUsername(username, displayName, password);
    else loginByUsername(username, password);
  };

  const liveBoard = useMemo(() => {
    const rows = leaderboard.map((entry) => {
      const peer = peers[entry.id];
      const fresh = !!peer && isFresh(peer, now);
      const mine = entry.id === user?.id;
      const running = mine ? isRunning : fresh && !!peer!.isRunning;
      let extra = 0;
      if (mine) {
        extra = unsynced;
      } else if (running) {
        extra = Math.floor(liveSeconds(peer, now));
      } else if (peer && finishedVisible(peer, now)) {
        extra = Math.floor(liveSeconds(peer, now));
      }
      return { ...entry, live: running, shown: entry.total_seconds + extra, extra };
    });
    return rows.sort((a, b) => b.shown - a.shown);
  }, [leaderboard, peers, now, unsynced, isRunning, user?.id]);

  const focusingCount = liveBoard.filter(r => r.live).length;

  // Суммарное время сквада (серверные данные)
  const squadToday = useMemo(() => weekBoard.reduce((a, e) => a + e.today_seconds, 0), [weekBoard]);
  const squadWeek = useMemo(() => weekBoard.reduce((a, e) => a + e.week_seconds, 0), [weekBoard]);

  // --- ЭКРАН ВХОДА / РЕГИСТРАЦИИ ---
  if (!user || !token) {
    const canSubmit = authMode === 'register'
      ? username.trim().length >= 3 && displayName.trim().length >= 1 && password.length >= 6
      : username.trim().length >= 3 && password.length >= 1;
    return (
      <div className="app-shell min-h-dvh flex items-center justify-center p-6">
        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="glass w-full max-w-sm space-y-6 p-8 rounded-[2rem]">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-semibold">ЕГЭ Фокус</h1>
            <p className="text-white/55 text-sm flex items-center justify-center gap-1.5">
              <ShieldCheck size={14} className="text-emerald-300/80" />
              {authMode === 'register' ? 'Создай аккаунт с паролем' : 'Войди в свой аккаунт'}
            </p>
          </div>

          <div className="glass-inset rounded-full p-1 flex">
            {(['login', 'register'] as const).map(m => (
              <button key={m} onClick={() => { setAuthMode(m); }}
                className={clsx("flex-1 py-2 rounded-full text-sm font-medium transition-colors", authMode === m ? 'glass-raised text-white' : 'text-white/45 hover:text-white/70')}>
                {m === 'login' ? 'Вход' : 'Регистрация'}
              </button>
            ))}
          </div>

          <div className="space-y-3">
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="@durov"
              autoComplete="username" className="glass-input font-mono" />
            {authMode === 'register' && (
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Как тебя зовут?"
                autoComplete="name" className="glass-input" />
            )}
            <div className="relative">
              <input
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && canSubmit && !isLoading) submitAuth(); }}
                type={showPassword ? 'text' : 'password'}
                placeholder={authMode === 'register' ? 'Пароль (минимум 6 символов)' : 'Пароль'}
                autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                className="glass-input w-full pr-11"
              />
              <button type="button" onClick={() => setShowPassword(v => !v)} tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
                title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {authMode === 'register' && (
              <p className="text-[11px] text-white/40 leading-snug px-1">
                Пароль защищает твой ник и статистику: без него никто не сможет войти под твоим именем или испортить время. Запомни его — восстановления пока нет.
              </p>
            )}
            {error && <p className="msg-error">{error}</p>}
            <button onClick={submitAuth} disabled={isLoading || !canSubmit}
              className="btn-primary w-full py-3 rounded-2xl active:scale-[0.98] transition-transform disabled:opacity-50">
              {isLoading ? 'Секунду…' : authMode === 'register' ? 'Создать аккаунт' : 'Войти'}
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // --- ЭКРАН СКВАДА (если нет сквада) ---
  if (!squad) {
    return (
      <div className="app-shell min-h-dvh flex items-center justify-center p-6">
        <div className="glass w-full max-w-sm space-y-5 p-6 rounded-[2rem]">
          <div className="text-center space-y-2">
            <h2 className="text-xl font-semibold">Привет, {user.name}!</h2>
            <p className="text-white/55 text-sm">Создай свой сквад или вступи в чужой</p>
          </div>
          {error && <p className="msg-error">{error}</p>}
          <div className="glass-row p-4 space-y-3">
            <label className="text-xs font-medium text-white/50">Создать новый сквад</label>
            <div className="flex gap-2">
              <input value={newSquadName} onChange={e => setNewSquadName(e.target.value)} placeholder="Название (например, 11А)" className="glass-input flex-1 !py-2 text-sm" />
              <button onClick={() => createSquad(newSquadName)} className="btn-primary p-2.5 rounded-xl"><Plus size={20} /></button>
            </div>
          </div>
          <p className="text-center text-white/30 text-xs">или</p>
          <div className="glass-row p-4 space-y-3">
            <label className="text-xs font-medium text-white/50">Вступить по коду</label>
            <div className="flex gap-2">
              <input value={squadCode} onChange={e => setSquadCode(e.target.value.toUpperCase())} placeholder="X7K9" className="glass-input flex-1 !py-2 text-sm font-mono uppercase tracking-widest" />
              <button onClick={() => joinSquad(squadCode)} className="glass-raised p-2.5 rounded-xl"><LogIn size={20} /></button>
            </div>
          </div>
          <button onClick={signOut} className="w-full text-white/40 text-xs hover:text-white/70 py-1 transition-colors">Выйти из аккаунта</button>
        </div>
      </div>
    );
  }

  const tabs: TabItem[] = [
    { id: 'timer', icon: Clock, label: 'Таймер' },
    { id: 'leaderboard', icon: Trophy, label: 'Сквад' },
    { id: 'stats', icon: BarChart3, label: 'Профиль' },
  ];

  // --- ГЛАВНЫЙ ЭКРАН ---
  return (
    <div className="app-shell min-h-dvh text-white flex flex-col items-center p-4 sm:p-6 pb-32 selection:bg-indigo-100">
      <motion.header initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="app-header w-full max-w-md flex justify-between items-center gap-3 pt-2 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <div className={twMerge("w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-sm font-bold text-stone-800 ring-1 ring-white/40", user.avatar_color)}>
            {user.name.charAt(0)}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-semibold text-base leading-tight truncate">{user.name}</span>
            <span className="text-[11px] text-white/50 leading-tight truncate">@{user.username}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isRunning && (
            <span className="glass-raised hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs tabular-nums">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(110,220,170,0.9)]" />
              {fmt(seconds)}
            </span>
          )}
          <button onClick={signOut} className="glass-raised p-2.5 rounded-full active:scale-90 transition-transform" title="Выйти">
            <LogOut size={18} />
          </button>
        </div>
      </motion.header>

      <div className="w-full max-w-md mt-4 mb-2 shrink-0">
        <div className="glass rounded-3xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="glass-inset p-2.5 rounded-xl text-[#a9b8ff] shrink-0"><Users size={20} /></div>
            <div className="min-w-0">
              <p className="text-xs text-white/50">Твой сквад</p>
              <p className="font-semibold flex items-center gap-1 truncate">
                {squad.name}
                {isAdmin && <Crown size={14} className="text-amber-300 shrink-0" />}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 relative shrink-0">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(squad.invite_code);
                setShowCopyTooltip(true);
                setTimeout(() => setShowCopyTooltip(false), 2000);
              }}
              className="glass-raised flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-mono font-bold"
            >
              {squad.invite_code}
              <Copy size={12} />
            </button>
            {showCopyTooltip && (
              <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="glass-raised absolute -bottom-9 right-0 text-[11px] px-2.5 py-1 rounded-lg whitespace-nowrap z-20">
                Скопировано!
              </motion.div>
            )}
          </div>
        </div>
        <button
          onClick={() => { if (window.confirm('Ты точно хочешь покинуть этот сквад?')) leaveSquad(); }}
          className="mt-2 w-full py-2 text-xs text-rose-300/80 font-medium hover:bg-rose-400/10 rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <XCircle size={14} /> Покинуть сквад
        </button>
      </div>

      {syncError && (
        <div className="msg-note w-full max-w-md mb-2 flex items-center justify-between gap-3">
          <span>{syncError}</span>
          <button onClick={() => { flushPendingChunks(); fetchLeaderboard(); }} className="glass-raised px-2.5 py-1 rounded-lg text-[11px] shrink-0">Повторить</button>
        </div>
      )}

      <main className="app-main w-full max-w-md flex-1 flex flex-col">
        <AnimatePresence mode="wait">
          {view === 'timer' && (
            <motion.div key="timer" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="w-full flex-1 flex flex-col items-center justify-center py-4">
              <div className="glass timer-card w-full rounded-[2.5rem] px-5 sm:px-6 py-8 sm:py-10 flex flex-col items-center">
                <motion.div animate={{ scale: isRunning ? [1, 1.02, 1] : 1 }} transition={{ repeat: Infinity, duration: 2 }} className={clsx("digits timer-digits", isRunning && 'digits-live')}>
                  {fmt(seconds)}
                </motion.div>
                <p className="text-center text-white/45 mt-4 mb-8 text-sm">{isRunning ? 'Фокус активен' : seconds > 0 ? 'Пауза' : 'Нажми старт'}</p>
                <div className="glass-inset rounded-full p-2 flex items-center gap-3">
                  <motion.button whileTap={{ scale: 0.9 }} onClick={handleStop} className="glass-raised p-4 rounded-full text-white/60 hover:!text-rose-300" title="Стоп и сохранить"><RotateCcw size={22} /></motion.button>
                  <motion.button whileTap={{ scale: 0.92 }} onClick={handleToggle} className={clsx("p-7 rounded-full flex items-center justify-center", isRunning ? 'glass-raised' : 'btn-primary')} title={isRunning ? 'Пауза' : 'Старт'}>
                    <AnimatePresence mode="wait">
                      <motion.div key={isRunning ? 'pause' : 'play'} initial={{ opacity: 0, scale: 0.5, rotate: -90 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} exit={{ opacity: 0, scale: 0.5, rotate: 90 }} transition={{ duration: 0.2 }}>
                        {isRunning ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" className="ml-1" />}
                      </motion.div>
                    </AnimatePresence>
                  </motion.button>
                </div>
                {focusingCount > 0 && (
                  <button onClick={() => setView('leaderboard')} className="mt-6 text-xs text-white/45 hover:text-white/75 transition-colors">
                    Сейчас в фокусе: {focusingCount}
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {view === 'leaderboard' && (
            <motion.div key="leaderboard" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="w-full py-4">
              <h2 className="text-lg font-semibold mb-1 px-1 flex items-center gap-2"><Trophy size={20} className="text-amber-300 shrink-0" /> <span className="truncate">Сквад: {squad.name}</span></h2>
              <p className="text-xs text-white/45 px-1 mb-4">
                {lastSyncAt ? `обновлено ${new Date(lastSyncAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Загружаем…'}
              </p>

              {/* Общее время сквада */}
              <div className="glass rounded-3xl p-4 mb-3 flex items-stretch gap-3">
                <div className="flex-1 text-center min-w-0">
                  <p className="text-[11px] text-white/45 mb-1">Сквад сегодня</p>
                  <p className="text-base font-semibold tabular-nums">{fmtShort(squadToday)}</p>
                </div>
                <div className="w-px bg-white/10 shrink-0" />
                <div className="flex-1 text-center min-w-0">
                  <p className="text-[11px] text-white/45 mb-1">Сквад за 7 дней</p>
                  <p className="text-base font-semibold tabular-nums text-[#a9b8ff]">{fmtShort(squadWeek)}</p>
                </div>
              </div>

              {/* Переключатель рейтингов */}
              <div className="glass-inset rounded-full p-1 flex mb-4">
                {([['focus', 'Регулярность'], ['time', 'Время сегодня']] as const).map(([id, label]) => (
                  <button key={id} onClick={() => setSquadTab(id)}
                    className={clsx("flex-1 py-2 rounded-full text-sm font-medium transition-colors", squadTab === id ? 'glass-raised text-white' : 'text-white/45 hover:text-white/70')}>
                    {label}
                  </button>
                ))}
              </div>

              {isAdmin && (
                <p className="msg-note mb-4 flex items-center gap-2">
                  <Crown size={14} className="shrink-0" /> Ты админ сквада: нажми «Бан» рядом с участником, чтобы исключить его. Разбанить можно внизу.
                </p>
              )}
              {error && <p className="msg-error mb-3">{error}</p>}

              {squadTab === 'focus' ? (
                <>
                  <p className="text-[11px] text-white/40 px-1 mb-3 leading-snug">
                    Коэффициент успеваемости (0–100) за последние 7 дней: важнее заниматься понемногу каждый день, чем один раз много. День засчитывается от 20 минут.
                  </p>
                  {weekBoard.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-white/40">
                      <Users size={48} className="mb-4 opacity-30" />
                      <p className="text-sm">{isRefreshing ? 'Загружаем участников…' : 'Пока нет данных за неделю'}</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {weekBoard.map((entry, i) => {
                        const mine = entry.id === user.id;
                        const score = Math.max(0, Math.min(100, entry.focus_score));
                        return (
                          <motion.div layout key={entry.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i * 0.05, 0.3) }} className={clsx("glass-row p-4", mine && 'glass-row-me')}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-3 min-w-0">
                                <span className={clsx("text-sm w-5 shrink-0 tabular-nums", i < 3 ? 'text-amber-300 font-bold' : 'text-white/30')}>{i + 1}</span>
                                <div className={twMerge("w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-stone-800 ring-1 ring-white/40 shrink-0", entry.avatar_color)}>{entry.name.charAt(0)}</div>
                                <div className="min-w-0">
                                  <span className="font-medium text-sm truncate flex items-center gap-1">
                                    {entry.name}
                                    {entry.id === squad.created_by && <Crown size={12} className="text-amber-300 shrink-0" />}
                                  </span>
                                  <span className="block text-[10px] text-white/40 tabular-nums truncate">
                                    {fmtShort(entry.week_seconds)} · ср. сессия {entry.sessions_count > 0 ? fmtShort(Math.round(entry.week_seconds / entry.sessions_count)) : '—'}
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <div className="text-right">
                                  <span className={clsx("text-lg font-bold tabular-nums block leading-none", score >= 70 ? 'text-emerald-200' : score >= 35 ? 'text-amber-200' : 'text-white/60')}>{Math.round(score)}</span>
                                  <span className="text-[9px] text-white/35 uppercase tracking-wide">КУ</span>
                                </div>
                                {isAdmin && !mine && (
                                  <button
                                    onClick={() => { if (window.confirm(`Забанить ${entry.name} в скваде?`)) banMember(entry.id); }}
                                    className="btn-danger flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg"
                                  >
                                    <Ban size={14} /> Бан
                                  </button>
                                )}
                              </div>
                            </div>
                            {/* Неделя: точки активных дней + прогресс КУ */}
                            <div className="mt-3 flex items-center gap-3">
                              <div className="flex gap-1.5 shrink-0" title={`${entry.active_days} из 7 дней`}>
                                {Array.from({ length: 7 }).map((_, di) => (
                                  <span key={di} className={clsx("w-2 h-2 rounded-full transition-colors", di < entry.active_days ? 'bg-emerald-300 shadow-[0_0_6px_rgba(110,220,170,0.7)]' : 'bg-white/10')} />
                                ))}
                              </div>
                              <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                                <motion.div initial={{ width: 0 }} animate={{ width: `${score}%` }} transition={{ duration: 0.6, ease: 'easeOut' }}
                                  className={clsx("h-full rounded-full", score >= 70 ? 'bg-emerald-300/80' : score >= 35 ? 'bg-amber-300/70' : 'bg-white/25')} />
                              </div>
                              <span className="text-[10px] text-white/40 tabular-nums shrink-0">{entry.active_days}/7 дн.</span>
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : leaderboard.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-white/40">
                  <Users size={48} className="mb-4 opacity-30" />
                  <p className="text-sm">{isRefreshing ? 'Загружаем участников…' : 'В скваде пока никого нет'}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {liveBoard.map((entry, i) => (
                    <motion.div layout key={entry.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i * 0.05, 0.3) }} className={clsx("glass-row flex items-center justify-between gap-2 p-4", entry.id === user.id && 'glass-row-me')}>
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={clsx("text-sm w-5 shrink-0 tabular-nums", i < 3 ? 'text-amber-300 font-bold' : 'text-white/30')}>{i + 1}</span>
                        <div className="relative shrink-0">
                          <div className={twMerge("w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-stone-800 ring-1 ring-white/40", entry.avatar_color)}>{entry.name.charAt(0)}</div>
                          {entry.live && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-300 ring-2 ring-black/40 shadow-[0_0_10px_rgba(110,220,170,0.9)]" />}
                        </div>
                        <div className="min-w-0">
                          <span className="font-medium text-sm truncate flex items-center gap-1">
                            {entry.name}
                            {entry.id === squad.created_by && <Crown size={12} className="text-amber-300 shrink-0" />}
                          </span>
                          {entry.live && <span className="block text-[10px] text-emerald-200/80">в фокусе сейчас</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="text-right">
                          <span className={clsx("text-sm font-medium tabular-nums block", entry.live ? 'text-emerald-200' : 'text-white/75')}>{fmt(entry.shown)}</span>
                          {entry.extra > 0 && <span className="block text-[10px] text-white/40 tabular-nums">+{fmt(entry.extra)} сейчас</span>}
                        </div>
                        {isAdmin && entry.id !== user.id && (
                          <button
                            onClick={() => { if (window.confirm(`Забанить ${entry.name} в скваде?`)) banMember(entry.id); }}
                            className="btn-danger flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg"
                          >
                            <Ban size={14} /> Бан
                          </button>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
              {isAdmin && (
                <div className="mt-8">
                  <h3 className="text-sm font-medium text-white/50 mb-3 px-1">Забаненные</h3>
                  <div className="space-y-2">
                    {bans.length === 0 && <p className="text-xs text-white/40 px-1">Пока никого</p>}
                    {bans.map(b => (
                      <div key={b.id} className="glass-row flex items-center justify-between gap-2 p-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={twMerge("w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-stone-800 shrink-0 ring-1 ring-white/40", b.avatar_color)}>{b.name.charAt(0)}</div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{b.name}</p>
                            <p className="text-[11px] text-white/45 truncate">@{b.username}</p>
                          </div>
                        </div>
                        <button onClick={() => unbanMember(b.id)} className="btn-ok flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg shrink-0">
                          <UserCheck size={14} /> Разбанить
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {view === 'stats' && (
            <motion.div key="stats" variants={pageVariants} initial="initial" animate="animate" exit="exit" className="w-full py-4">
              <h2 className="text-lg font-semibold mb-1 px-1 flex items-center gap-2"><BarChart3 size={20} className="text-[#a9b8ff] shrink-0" /> Моя статистика</h2>
              <p className="text-xs text-white/45 px-1 mb-4">Не зависит от сквада: сохраняется, даже если ты выйдешь или сменишь сквад</p>
              <div className="glass rounded-3xl p-6 mb-3 text-center">
                <p className="text-sm text-white/50 mb-2">Сегодня</p>
                <p className="digits digits-live stats-digits">{fmt((stats?.today_seconds ?? 0) + unsynced)}</p>
                {isRunning && <p className="text-[11px] text-emerald-200/80 mt-2">+ текущая сессия в реальном времени</p>}
              </div>
              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {[
                  { label: 'За всё время', value: fmtShort((stats?.total_seconds ?? 0) + unsynced) },
                  { label: '7 дней', value: fmtShort((stats?.week_seconds ?? 0) + unsynced) },
                  { label: 'Сессий', value: String(stats?.sessions_count ?? 0) },
                ].map(c => (
                  <div key={c.label} className="glass-row p-3 sm:p-4 text-center min-w-0">
                    <p className="text-[11px] text-white/45 mb-1">{c.label}</p>
                    <p className="text-sm font-semibold break-words">{c.value}</p>
                  </div>
                ))}
              </div>
              <h3 className="text-sm font-medium text-white/50 mt-6 mb-3 px-1">Последние сессии</h3>
              {sessions.length === 0 ? (
                <p className="text-xs text-white/40 px-1">Пока нет сохранённых сессий</p>
              ) : (
                <div className="space-y-2">
                  {sessions.map(s => (
                    <div key={s.id} className="glass-row flex items-center justify-between gap-2 p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium tabular-nums">{fmt(s.duration_seconds)}</p>
                        <p className="text-[11px] text-white/45 truncate">
                          {new Date(s.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      <button
                        onClick={() => { if (window.confirm('Удалить эту сессию? Время вычтется из статистики.')) deleteSession(s.id); }}
                        className="p-2 shrink-0 text-white/35 hover:text-rose-300 hover:bg-rose-400/10 rounded-lg transition-colors"
                        title="Удалить сессию"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <TabBar tabs={tabs} view={view} onChange={setView} />
    </div>
  );
}