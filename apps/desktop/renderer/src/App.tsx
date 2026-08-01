import React, { useEffect, useState } from "react";
import { logout, me, type PublicUser } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { VendorsPage } from "./pages/VendorsPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { theme } from "./theme";

type Page =
  | { name: "vendors" }
  | { name: "runs" }
  | { name: "run-detail"; runId: string };

/** 签名元素：Agent 节点 Logo（主节点 + 两个子节点 + 连线）。 */
function AgentLogo() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <line x1="13" y1="13" x2="4" y2="6" stroke={theme.borderStrong} strokeWidth="1.4" />
      <line x1="13" y1="13" x2="21" y2="6" stroke={theme.borderStrong} strokeWidth="1.4" />
      <circle cx="4" cy="6" r="3" fill="none" stroke={theme.primary} strokeWidth="1.4" />
      <circle cx="21" cy="6" r="3" fill="none" stroke={theme.primary} strokeWidth="1.4" />
      <circle cx="13" cy="13" r="4.5" fill={theme.primary} />
    </svg>
  );
}

export function App() {
  const [page, setPage] = useState<Page>({ name: "runs" });
  const [backendReady, setBackendReady] = useState(false);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const api = await import("./api");
        const base = await api.apiBase();
        const response = await fetch(`${base}/api/health`);
        setBackendReady(response.ok);
      } catch {
        setBackendReady(false);
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const checkAuth = async () => {
      const current = await me();
      setUser(current ?? null);
      setAuthChecked(true);
    };
    void checkAuth();
  }, []);

  const onLoggedIn = async () => {
    setUser((await me()) ?? null);
  };

  const onLogout = async () => {
    await logout();
    setUser(null);
    setPage({ name: "runs" });
  };

  if (!authChecked) {
    return <div style={styles.loading}>加载中...</div>;
  }

  if (!user) {
    return <LoginPage onLoggedIn={() => void onLoggedIn()} />;
  }

  const navItem = (label: string, icon: string, active: boolean, onClick: () => void) => (
    <button
      style={{ ...styles.navItem, ...(active ? styles.navItemActive : {}) }}
      onClick={onClick}
    >
      <span style={styles.navIcon}>{icon}</span>
      {label}
    </button>
  );

  return (
    <div style={styles.root}>
      <aside style={styles.sidebar}>
        <div style={styles.logoRow}>
          <AgentLogo />
          <span style={styles.logoText}>Multi-Agent Dev</span>
        </div>
        <nav style={styles.nav}>
          {navItem("供应商管理", "▤", page.name === "vendors", () => setPage({ name: "vendors" }))}
          {navItem("开发任务", "▶", page.name === "runs" || page.name === "run-detail", () => setPage({ name: "runs" }))}
        </nav>
        <div style={styles.sidebarFooter}>
          <div style={styles.userBox}>
            <div style={styles.userAvatar}>{user.username.slice(0, 1).toUpperCase()}</div>
            <div style={styles.userInfo}>
              <div style={styles.userName}>{user.username}</div>
              <div style={styles.userRole}>{user.role}</div>
            </div>
          </div>
          <button style={styles.logoutButton} onClick={() => void onLogout()}>退出</button>
          <div style={styles.status}>
            <span style={{ ...styles.statusDot, background: backendReady ? theme.success : theme.textFaint }} />
            {backendReady ? "后端已连接" : "连接后端中..."}
          </div>
        </div>
      </aside>
      <main style={styles.main}>
        {page.name === "vendors" && <VendorsPage />}
        {page.name === "runs" && (
          <RunsPage onOpenRun={(runId) => setPage({ name: "run-detail", runId })} />
        )}
        {page.name === "run-detail" && (
          <RunDetailPage
            runId={page.runId}
            onBack={() => setPage({ name: "runs" })}
            onRefreshList={() => {
              // 返回列表后由 RunsPage 的轮询自动刷新。
            }}
          />
        )}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    height: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: theme.font,
    color: theme.textDim,
    background: theme.bg,
  },
  root: {
    display: "flex",
    height: "100vh",
    fontFamily: theme.font,
    color: theme.text,
    background: theme.bg,
  },
  sidebar: {
    width: 216,
    background: theme.surface,
    borderRight: `1px solid ${theme.border}`,
    color: theme.text,
    display: "flex",
    flexDirection: "column",
    padding: "18px 14px",
    boxSizing: "border-box",
  },
  logoRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 26, padding: "0 4px" },
  logoText: { fontSize: 15, fontWeight: 700, letterSpacing: ".02em" },
  nav: { flex: 1, display: "flex", flexDirection: "column", gap: 2 },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 12px",
    borderRadius: theme.radiusSm,
    fontSize: 14,
    color: theme.textDim,
    background: "transparent",
    border: 0,
    cursor: "pointer",
    textAlign: "left",
    transition: "background .15s ease, color .15s ease",
  },
  navItemActive: { background: theme.surfaceAlt, color: theme.primary, fontWeight: 600 },
  navIcon: { fontSize: 13, opacity: 0.9 },
  sidebarFooter: { borderTop: `1px solid ${theme.border}`, paddingTop: 14, marginTop: 8 },
  userBox: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  userAvatar: {
    width: 30,
    height: 30,
    borderRadius: 999,
    background: `linear-gradient(135deg, ${theme.primary}, ${theme.indigo})`,
    color: "#0B1220",
    fontWeight: 700,
    fontSize: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  userInfo: { flex: 1, minWidth: 0 },
  userName: { fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  userRole: { fontSize: 11, color: theme.textDim, textTransform: "capitalize" },
  logoutButton: {
    width: "100%",
    padding: "7px 0",
    background: "transparent",
    border: `1px solid ${theme.border}`,
    color: theme.textDim,
    borderRadius: theme.radiusSm,
    fontSize: 12,
    cursor: "pointer",
    marginBottom: 12,
    transition: "border-color .15s ease, color .15s ease",
  },
  status: { display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: theme.textFaint },
  statusDot: { width: 7, height: 7, borderRadius: 999 },
  main: {
    flex: 1,
    overflow: "auto",
    padding: 28,
    boxSizing: "border-box",
    background: `radial-gradient(1200px 600px at 80% -10%, rgba(34,211,238,.05), transparent), ${theme.bg}`,
  },
};
