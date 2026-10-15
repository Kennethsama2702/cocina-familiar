import { FormEvent, useState } from 'react';
import { signIn } from '../data/repository';

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await signIn(email.trim(), password); onDone(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={(e) => void submit(e)}>
        <div>
          <h1 style={{ fontSize: '1.4rem' }}>Administrar la cocina</h1>
          <p className="muted small">Acceso solo para el administrador. Si solo quieres ver el calendario, usa el enlace que te compartieron.</p>
        </div>
        <label className="field">Correo<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus /></label>
        <label className="field">Contraseña<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <p className="error-text" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}
