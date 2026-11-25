import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const env = (import.meta as any).env ?? {};

export const SUPABASE_URL: string | undefined = env.VITE_SUPABASE_URL;
export const SUPABASE_KEY: string | undefined = env.VITE_SUPABASE_ANON_KEY;
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

/** Чтения ждём до 30 с (Supabase может «просыпаться»), записи — тоже 30 с, с повторами. */
export const READ_TIMEOUT_MS = 30_000;
export const WRITE_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = WRITE_TIMEOUT_MS;

const fetchWithTimeout: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const isRead = (init?.method ?? 'GET').toUpperCase() === 'GET' || /\/rpc\/get_/.test(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), isRead ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  const outer = init?.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};

let client: SupabaseClient | null = null;
if (isSupabaseConfigured) {
  client = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout },
    realtime: { params: { eventsPerSecond: 2 } },
  });
}

export const supabase = client as SupabaseClient;

export function friendlyNetworkError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (/abort|timeout/i.test(msg)) return 'Медленное соединение — данные обновляются в фоне.';
  if (/fetch|network|load failed/i.test(msg)) return 'Нет связи с сервером. Данные обновятся автоматически.';
  return msg || 'Неизвестная ошибка сети';
}

export function withTimeout<T>(p: PromiseLike<T>, ms = REQUEST_TIMEOUT_MS + 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: сервер не ответил')), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String((e as any)?.message ?? e ?? '');
  return /abort|timeout|fetch|network|load failed|502|503|504|ECONN|socket/i.test(msg);
}

/** Повтор с экспоненциальной задержкой: 0.8с → 1.6с → 3.2с → 6с. */
export async function retry<T>(
  fn: () => PromiseLike<T>,
  { attempts = 4, baseDelay = 800 }: { attempts?: number; baseDelay?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn());
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || i === attempts - 1) throw e;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) await waitForOnline();
      else await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
}

export function waitForOnline(maxMs = 30_000): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('online', onOnline); };
    const onOnline = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, maxMs);
    window.addEventListener('online', onOnline, { once: true });
  });
}

/**
 * Повтор для supabase-запросов: supabase-js не бросает исключение при обрыве сети,
 * а возвращает { error }, поэтому обычный retry() ничего не ловил.
 */
export async function retryResult<T extends { error: any }>(
  fn: () => PromiseLike<T>,
  { attempts = 3, baseDelay = 700 }: { attempts?: number; baseDelay?: number } = {},
): Promise<T> {
  let last: T | undefined;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await withTimeout(fn());
      if (!res.error || !isRetryable(res.error)) return res;
      last = res;
    } catch (e) {
      if (!isRetryable(e)) throw e;
      lastErr = e;
    }
    if (i < attempts - 1) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) await waitForOnline();
      else await sleep(baseDelay * Math.pow(2, i));
    }
  }
  if (last) return last;
  throw lastErr;
}