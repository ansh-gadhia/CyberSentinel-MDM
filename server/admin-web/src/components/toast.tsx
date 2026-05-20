import { create } from 'zustand';
import { useEffect } from 'react';

export type Toast = {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
  ttlMs: number;
};

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast['kind'], message: string, ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

let _idSeq = 0;
const newId = () => ++_idSeq;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, ttlMs = 4000) =>
    set(s => ({ toasts: [...s.toasts, { id: newId(), kind, message, ttlMs }] })),
  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));

export const toast = {
  success: (m: string, ttl?: number) => useToasts.getState().push('success', m, ttl),
  error:   (m: string, ttl?: number) => useToasts.getState().push('error',   m, ttl ?? 6000),
  info:    (m: string, ttl?: number) => useToasts.getState().push('info',    m, ttl),
};

export function ToastRoot() {
  const toasts = useToasts(s => s.toasts);
  const dismiss = useToasts(s => s.dismiss);
  return (
    <div className="fixed top-3 right-3 z-50 space-y-2 max-w-md pointer-events-none">
      {toasts.map(t => <ToastItem key={t.id} t={t} onDismiss={() => dismiss(t.id)} />)}
    </div>
  );
}

function ToastItem({ t, onDismiss }: { t: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const h = setTimeout(onDismiss, t.ttlMs);
    return () => clearTimeout(h);
  }, [t.ttlMs, onDismiss]);
  const tone =
    t.kind === 'success' ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200' :
    t.kind === 'error'   ? 'border-rose-300    bg-rose-50    dark:bg-rose-950/60    dark:border-rose-800    text-rose-900    dark:text-rose-200' :
                           'border-sky-300     bg-sky-50     dark:bg-sky-950/60     dark:border-sky-800     text-sky-900     dark:text-sky-200';
  return (
    <div className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg ${tone} animate-[fadein_120ms_ease-out]`}>
      <div className="flex items-start gap-2">
        <span className="flex-1">{t.message}</span>
        <button onClick={onDismiss} className="text-xs opacity-50 hover:opacity-100">✕</button>
      </div>
    </div>
  );
}
