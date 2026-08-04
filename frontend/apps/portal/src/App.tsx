import { NavLink, Route, Routes } from 'react-router-dom';
import { LayoutDashboard, Database, Network, FlaskConical, Moon, Sun } from 'lucide-react';
import { useTheme } from './theme/useTheme';
import { DashboardListPage } from './pages/DashboardListPage';
import { ModelListPage } from './pages/ModelListPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { SpikePage } from './pages/SpikePage';

const navItems = [
  { to: '/', label: 'Dashboards', icon: LayoutDashboard, end: true },
  { to: '/models', label: 'Models', icon: Network, end: false },
  { to: '/connections', label: 'Connections', icon: Database, end: false },
  { to: '/spike', label: 'Spike', icon: FlaskConical, end: false },
];

export function App() {
  const { theme, toggle } = useTheme();

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-rcd-border bg-[var(--color-surface)]">
        <div className="px-4 py-5 text-lg font-semibold">Recon Dashboards</div>
        <nav className="flex flex-col gap-1 px-2">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'hover:bg-black/5 dark:hover:bg-white/10'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end border-b border-black/10 px-4 py-2 dark:border-white/10">
          <button
            type="button"
            onClick={toggle}
            aria-label="Toggle theme"
            className="rounded-md p-2 hover:bg-black/5 dark:hover:bg-white/10"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<DashboardListPage />} />
            <Route path="/models" element={<ModelListPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/spike" element={<SpikePage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
