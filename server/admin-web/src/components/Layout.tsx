import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/authStore';
import { Moon, Sun, LogOut, Smartphone, Shield, Box, FileText, Activity, QrCode, Users, KeyRound } from 'lucide-react';
import clsx from 'clsx';
import { useEffect } from 'react';
import { ToastRoot } from './toast';
import { can } from '../lib/rbac';

type NavItem = { to: string; label: string; Icon: typeof Activity; section: 'fleet' | 'ops'; perm?: string };
const nav: NavItem[] = [
  { to: '/',            label: 'Overview',   Icon: Activity,   section: 'fleet' },
  { to: '/devices',     label: 'Devices',    Icon: Smartphone, section: 'fleet' },
  { to: '/groups',      label: 'Groups',     Icon: Users,      section: 'fleet' },
  { to: '/policies',    label: 'Policies',   Icon: Shield,     section: 'fleet' },
  { to: '/apps',        label: 'Apps',       Icon: Box,        section: 'fleet' },
  { to: '/enrollment',  label: 'Enrollment', Icon: QrCode,     section: 'ops' },
  { to: '/audit',       label: 'Audit',      Icon: FileText,   section: 'ops' },
  { to: '/roles',       label: 'Access',     Icon: KeyRound,   section: 'ops', perm: 'role:read' }
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { dark, toggleDark, user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  return (
    <div className="flex h-full">
      <aside className="w-64 shrink-0 border-r border-slate-200 dark:border-slate-800 px-4 py-5 flex flex-col bg-slate-50/50 dark:bg-slate-950/40">
        <Link to="/" className="block mb-6">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded bg-brand-600 text-white flex items-center justify-center font-semibold text-sm">CS</div>
            <div>
              <div className="text-sm font-semibold leading-tight">CyberSentinel</div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Virtual Galaxy Infotech</div>
            </div>
          </div>
        </Link>
        <div className="text-[10px] uppercase tracking-wider text-slate-400 px-1 mb-1">Fleet</div>
        <nav className="space-y-0.5 mb-4">
          {nav.filter(n => n.section === 'fleet' && (!n.perm || can(n.perm))).map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'hover:bg-slate-200/70 dark:hover:bg-slate-800/70'
                )
              }
            >
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="text-[10px] uppercase tracking-wider text-slate-400 px-1 mb-1">Operations</div>
        <nav className="space-y-0.5 flex-1">
          {nav.filter(n => n.section === 'ops' && (!n.perm || can(n.perm))).map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'hover:bg-slate-200/70 dark:hover:bg-slate-800/70'
                )
              }
            >
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 dark:border-slate-800 pt-3 text-sm">
          <Link to="/profile" className="block mb-1 truncate font-medium hover:text-brand-600" title="Edit profile">
            {user?.email ?? 'signed in'}
          </Link>
          <div className="text-xs text-slate-500 mb-3">{user?.role}</div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleDark}
              className="rounded p-2 hover:bg-slate-200 dark:hover:bg-slate-800"
              aria-label="Toggle dark mode"
            >{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
            <button
              onClick={() => { logout(); navigate('/login'); }}
              className="rounded p-2 hover:bg-slate-200 dark:hover:bg-slate-800"
              aria-label="Sign out"
            ><LogOut size={16} /></button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-7xl mx-auto">{children}</div>
      </main>
      <ToastRoot />
    </div>
  );
}
