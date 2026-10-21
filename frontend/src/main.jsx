import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { Loading } from './components/ui';
import { ApiError } from './lib/api';
import { SessionProvider, useSession } from './lib/session';
import { AdminPage } from './pages/AdminPage';
import { AuthPage } from './pages/AuthPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { Home } from './pages/Home';
import { MoviePage } from './pages/MoviePage';
import { MyBookings } from './pages/MyBookings';
import { ShowPage } from './pages/ShowPage';
import { TicketPage } from './pages/TicketPage';
// Self-hosted fonts: no request to a third-party font CDN, works offline.
import '@fontsource/big-shoulders-display/500';
import '@fontsource/big-shoulders-display/700';
import '@fontsource/big-shoulders-display/800';
import '@fontsource-variable/figtree';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

function RequireUser({ children }) {
  const { user, ready } = useSession();
  const location = useLocation();
  if (!ready)
    return (
      <main className="page">
        <Loading />
      </main>
    );
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <>{children}</>;
}

function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <div id="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/movies/:id" element={<MoviePage />} />
          <Route path="/shows/:id" element={<ShowPage />} />
          <Route
            path="/checkout/:id"
            element={
              <RequireUser>
                <CheckoutPage />
              </RequireUser>
            }
          />
          <Route
            path="/bookings"
            element={
              <RequireUser>
                <MyBookings />
              </RequireUser>
            }
          />
          <Route
            path="/bookings/:id"
            element={
              <RequireUser>
                <TicketPage />
              </RequireUser>
            }
          />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route
            path="*"
            element={
              <main className="page">
                <h1 className="page-title">This page does not exist</h1>
              </main>
            }
          />
        </Routes>
      </div>
      <footer className="footer">Showtime is a portfolio project. Films, venues and payments are simulated.</footer>
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
