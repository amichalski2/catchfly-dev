import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const url = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

const REMEMBER_KEY = 'catchfly.remember';

let unavailable = false;

function guard<T>(read: () => T, fallback: T): T {
  if (unavailable) return fallback;
  try {
    return read();
  } catch {
    unavailable = true;
    return fallback;
  }
}

function target(): Storage | null {
  return guard(
    () => (localStorage.getItem(REMEMBER_KEY) === 'session' ? sessionStorage : localStorage),
    null,
  );
}

const storage = {
  getItem(key: string): string | null {
    return guard(() => target()?.getItem(key) ?? null, null);
  },
  setItem(key: string, value: string): void {
    guard(() => target()?.setItem(key, value), undefined);
  },
  removeItem(key: string): void {
    guard(() => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    }, undefined);
  },
};

export function rememberSession(remember: boolean): void {
  guard(() => localStorage.setItem(REMEMBER_KEY, remember ? 'local' : 'session'), undefined);
}

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey, { auth: { storage } }) : null;

export async function accessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
