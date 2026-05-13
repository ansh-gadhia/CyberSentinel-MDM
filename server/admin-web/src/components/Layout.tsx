import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/authStore';
import { Moon, Sun, LogOut, Smartphone, Shield, Box, FileText, Activity, QrCode } from 'lucide-react';
import clsx from 'clsx';
import { useEffect } from 'react';

const nav = [
  { to: '/',            label: 'Overview',   Icon: Activity },
  { to: '/devices',     label: 'Devices',    Icon: Smartphone },
  { to: '/policies',    label: 'Policies',   Icon: Shield },
  { to: '/apps',        label: 'Apps',       Icon: Box },
  { to: '/enrollment',  label: 'Enrollment', Icon: QrCode },
  { to: '/audit',       label: 'Audit',      Icon: FileText }
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { dark, toggleDark, user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 border-r border-slate-200 dark:border-slate-800 px-4 py-6 flex flex-col">
        <Link to="/" className="block mb-6">
          <div className="text-lg font-semibold leading-tight">CyberSentinel MDM</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Virtual Galaxy Infotech Ltd</div>
        </Link>
        <nav className="space-y-1 flex-1">
          {nav.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2 rounded px-3 py-2 text-sm',
                  isActive
                    ? 'bg-brand-600 text-white'
                    : 'hover:bg-slate-200 dark:hover:bg-slate-800'
                )
              }
            >
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 dark:border-slate-800 pt-4 text-sm">
          <div className="mb-2 truncate" title={user?.email}>{user?.email ?? 'signed in'}</div>
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
        {children}
      </main>
    </div>
  );
}
