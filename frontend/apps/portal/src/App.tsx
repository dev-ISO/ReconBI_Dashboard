import { useEffect } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { LayoutDashboard, Database, Network, FlaskConical, Moon, Sun } from 'lucide-react';
import { DashboardsProvider } from '@recon/dashboards-ui';
import { useTheme } from './theme/useTheme';
import { DEMO_USERS, loginAs, portalFetcher, useCurrentUser } from './auth/demoAuth';
import { DashboardListPage } from './pages/DashboardListPage';
import { DashboardPage } from './pages/DashboardPage';
import { ModelListPage } from './pages/ModelListPage';
import { ModelEditorPage } from './pages/ModelEditorPage';
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
  const currentUser = useCurrentUser();

  // Default to carol so the portal works immediately after `docker compose up`.
  useEffect(() => {
    if (!currentUser) {
      loginAs('carol').catch(() => {
        // demo API not up yet; the pages show their own error states
      });
    }
  }, [currentUser]);

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-black/10 bg-[var(--color-surface)] dark:border-white/10">
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
        <header className="flex items-center justify-end gap-3 border-b border-black/10 px-4 py-2 dark:border-white/10">
          <label className="flex items-center gap-2 text-sm opacity-80">
            User
            <select
              className="rounded-md border border-black/15 bg-[var(--color-surface)] px-2 py-1 text-sm dark:border-white/15"
              value={currentUser ?? ''}
              onChange={(event) => void loginAs(event.target.value)}
            >
              {!currentUser && <option value="">signed out</option>}
              {DEMO_USERS.map((user) => (
                <option key={user.username} value={user.username}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </label>
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
          <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={portalFetcher}>
            <Routes>
              <Route path="/" element={<DashboardListPage />} />
              <Route path="/dashboards/:id" element={<DashboardPage />} />
              <Route path="/models" element={<ModelListPage />} />
              <Route path="/models/:id" element={<ModelEditorPage />} />
              <Route path="/connections" element={<ConnectionsPage />} />
              <Route path="/spike" element={<SpikePage />} />
            </Routes>
          </DashboardsProvider>
        </main>
      </div>
    </div>
  );
}
