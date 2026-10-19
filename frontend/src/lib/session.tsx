import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onSessionChange, refreshSession } from './api';
import type { User } from './types';

interface SessionState {
  user: User | null;
  ready: boolean;
  city: string;
  setCity: (c: string) => void;
}

const Ctx = createContext<SessionState | null>(null);
const CITY_KEY = 'showtime.city';

function readCity(): string {
  try {
    return localStorage.getItem(CITY_KEY) ?? 'Bengaluru';
  } catch {
    return 'Bengaluru';
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [city, setCityState] = useState(readCity);

  useEffect(() => {
    const off = onSessionChange(setUser);
    // Restore the session from the refresh cookie on page load.
    void refreshSession().finally(() => setReady(true));
    return () => {
      off();
    };
  }, []);

  const setCity = (c: string) => {
    setCityState(c);
    try {
      localStorage.setItem(CITY_KEY, c);
    } catch {
      /* private mode */
    }
  };

  return <Ctx.Provider value={{ user, ready, city, setCity }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
