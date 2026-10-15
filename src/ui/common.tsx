import { CSSProperties, ReactNode, useEffect, useRef } from 'react';
import { Participant } from '../domain';

export type People = Record<string, Participant>;

export const cssVar = (c: string): CSSProperties => ({ ['--c' as string]: c });

export function Icon({ name, size = 16 }: { name: 'chev-l' | 'chev-r' | 'x' | 'plane' | 'swap' | 'heart' | 'check' | 'lock' | 'plus' | 'copy' | 'logout' | 'undo'; size?: number }) {
  const p: Record<string, string> = {
    'chev-l': 'M15 18l-6-6 6-6', 'chev-r': 'M9 18l6-6-6-6', x: 'M18 6L6 18M6 6l12 12',
    plane: 'M2 16l20-8-8 14-2-6-6-2zM12 16l10-8', swap: 'M7 7h13l-3-3M17 17H4l3 3', heart: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 5.5-7 10-7 10z',
    check: 'M5 12l5 5 9-10', lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3', plus: 'M12 5v14M5 12h14',
    copy: 'M9 9h10v10H9zM5 15V5h10', logout: 'M15 17l5-5-5-5M20 12H9M12 4H5v16h7', undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={p[name]} />
    </svg>
  );
}

export function Avatar({ person, small }: { person?: Participant; small?: boolean }) {
  return (
    <span className={`avatar${small ? ' sm' : ''}`} style={cssVar(person?.color ?? '#999')} aria-hidden="true">
      {(person?.name ?? '?').charAt(0)}
    </span>
  );
}

export function Who({ person }: { person?: Participant }) {
  return (
    <span className="who" style={cssVar(person?.color ?? '#999')}>
      <span className="dot" />
      <span className="name">{person?.name ?? '—'}</span>
      <span className="ini" aria-hidden="true">{(person?.name ?? '?').charAt(0)}</span>
    </span>
  );
}

export function Dialog({ title, onClose, children, side = false, wide = false, labelId = 'dlg-title' }: {
  title: ReactNode; onClose: () => void; children: ReactNode; side?: boolean; wide?: boolean; labelId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<Element | null>(null);
  useEffect(() => {
    prev.current = document.activeElement;
    const el = ref.current;
    el?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      (prev.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);
  return (
    <div className={`overlay${side ? '' : ' center'}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={side ? 'sheet' : `dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId}>
        <div className="sheet-head">
          <h2 id={labelId} className="grow">{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Cerrar"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Dialog title={title} onClose={onCancel} labelId="confirm-title">
      <div className="muted">{body}</div>
      <div className="row between wrap">
        <button className="btn" onClick={onCancel} disabled={busy}>Volver</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy} data-autofocus>{busy ? 'Guardando…' : confirmLabel}</button>
      </div>
    </Dialog>
  );
}

export function Toast({ toast }: { toast: { kind: 'ok' | 'err'; text: string; id: number } | null }) {
  return toast ? <div key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === 'err' ? 'alert' : 'status'}>{toast.text}</div> : null;
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return <div className="row" role="status" aria-live="polite"><span className="spinner" /><span className="muted">{label}</span></div>;
}
