import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorNote } from '../components/ui';
import { ApiError, auth } from '../lib/api';

export function AuthPage({ mode }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await auth.login(form.email, form.password);
      else await auth.register(form.name, form.email, form.password);
      navigate(next.startsWith('/') ? next : '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const fieldErrors = error instanceof ApiError && Array.isArray(error.details) ? error.details : [];
  const fieldError = (name) => fieldErrors.find((d) => d.path === name)?.message;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <main className="page page--auth">
      <h1 className="page-title">{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
      <form className="auth-form" onSubmit={submit} noValidate>
        {mode === 'register' && (
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={set('name')} autoComplete="name" required />
            {fieldError('name') && <small className="field-error">{fieldError('name')}</small>}
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
          {fieldError('email') && <small className="field-error">{fieldError('email')}</small>}
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
          {mode === 'register' && <small className="muted">At least 8 characters.</small>}
          {fieldError('password') && <small className="field-error">{fieldError('password')}</small>}
        </label>
        {error && !fieldErrors.length ? <ErrorNote error={error} /> : null}
        <button className="button button--primary button--block" disabled={busy}>
          {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {mode === 'login' ? (
          <p className="auth-form__switch">
            New here? <Link to={`/register?next=${encodeURIComponent(next)}`}>Create an account</Link>
            <br />
            <span className="muted">Demo login: demo@showtime.dev / demo1234</span>
          </p>
        ) : (
          <p className="auth-form__switch">
            Already have an account? <Link to={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
          </p>
        )}
      </form>
    </main>
  );
}
