import { createContext, useContext, useEffect, useState } from 'react';
import { onSessionChange, refreshSession } from './api';

const Ctx = createContext(null);
const CITY_KEY = 'showtime.city';

function readCity() {
  try {
    return localStorage.getItem(CITY_KEY) ?? 'Bengaluru';
  } catch {
    return 'Bengaluru';
  }
}

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null);
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

  const setCity = (c) => {
    setCityState(c);
    try {
      localStorage.setItem(CITY_KEY, c);
    } catch {
      /* private mode */
    }
  };

  return <Ctx.Provider value={{ user, ready, city, setCity }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
