import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import {
  BarChart3,
  Database,
  FlaskConical,
  LayoutDashboard,
  Moon,
  Network,
  Sun,
  UserRound,
} from 'lucide-react';
import { DashboardsProvider } from '@recon/dashboards-ui';
import { useTheme } from './theme/useTheme';
import { DEMO_USERS, loginAs, portalFetcher, useCurrentUser } from './auth/demoAuth';
import { DashboardListPage } from './pages/DashboardListPage';
import { DashboardPage } from './pages/DashboardPage';
import { ModelListPage } from './pages/ModelListPage';
import { ModelEditorPage } from './pages/ModelEditorPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { SpikePage } from './pages/SpikePage';

const navGroups = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Dashboards', icon: LayoutDashboard, end: true },
      { to: '/models', label: 'Models', icon: Network, end: false },
      { to: '/connections', label: 'Connections', icon: Database, end: false },
    ],
  },
  {
    label: 'Developer',
    items: [{ to: '/spike', label: 'Spike', icon: FlaskConical, end: false }],
  },
];

/** Product mark: primary square + wordmark, reused in the sidebar and splash. */
function ProductMark({ large = false }: { large?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-zinc-50 shadow-sm dark:bg-zinc-50 dark:text-zinc-900 ${
          large ? 'h-10 w-10' : 'h-7 w-7'
        }`}
      >
        <BarChart3 size={large ? 22 : 16} />
      </span>
      <span className={`font-semibold leading-tight tracking-[-0.01em] ${large ? 'text-lg' : 'text-[15px]'}`}>
        Recon Dashboards
      </span>
    </div>
  );
}

export function App() {
  const { theme, toggle } = useTheme();
  const currentUser = useCurrentUser();
  // Gate routed content until the auto-login settles so first fetches never
  // fire tokenless 401s. 'idle' also gates (covers the pre-effect first paint).
  const [autoLogin, setAutoLogin] = useState<'idle' | 'pending' | 'done'>('idle');

  // Default to carol so the portal works immediately after `docker compose up`.
  useEffect(() => {
    if (currentUser) return;
    setAutoLogin('pending');
    loginAs('carol')
      .catch(() => {
        // demo API not up yet; the pages show their own error states
      })
      .finally(() => setAutoLogin('done'));
  }, [currentUser]);

  const signingIn = !currentUser && autoLogin !== 'done';

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-[var(--color-surface)] dark:border-zinc-800">
        <div className="px-4 pb-4 pt-5">
          <ProductMark />
        </div>

        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3">
          {navGroups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {group.label}
              </p>
              {group.items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50'
                        : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-50'
                    }`
                  }
                >
                  <Icon size={16} />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* User picker + theme toggle, pinned to the sidebar foot. */}
        <div className="flex items-center gap-2 border-t border-zinc-200 px-3 py-3 dark:border-zinc-800">
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800"
          >
            <UserRound size={15} className="text-zinc-500 dark:text-zinc-400" />
          </span>
          <select
            aria-label="Switch demo user"
            className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-[var(--color-surface)] px-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20 dark:border-zinc-800 dark:focus:border-blue-500 dark:focus:ring-blue-500/25"
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
          <button
            type="button"
            onClick={toggle}
            aria-label="Toggle theme"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="shrink-0 rounded-lg p-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-50"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-auto">
        <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={portalFetcher}>
          {signingIn ? (
            // Sign-in splash: centered card with the product mark.
            <div className="flex h-full items-center justify-center p-6">
              <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-xl border border-zinc-200 bg-[var(--color-surface)] px-8 py-10 shadow-sm dark:border-zinc-800">
                <ProductMark large />
                <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
                  Build models, compose dashboards, and explore your data.
                </p>
                <div
                  className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400"
                  role="status"
                >
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-200 border-t-zinc-900 dark:border-zinc-700 dark:border-t-zinc-50" />
                  Signing in…
                </div>
              </div>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<DashboardListPage />} />
              <Route path="/dashboards/:id" element={<DashboardPage />} />
              <Route path="/models" element={<ModelListPage />} />
              <Route path="/models/:id" element={<ModelEditorPage />} />
              <Route path="/connections" element={<ConnectionsPage />} />
              <Route path="/spike" element={<SpikePage />} />
            </Routes>
          )}
        </DashboardsProvider>
      </main>
    </div>
  );
}
