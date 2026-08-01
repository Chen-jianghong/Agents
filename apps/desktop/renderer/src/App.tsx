import React, { useEffect, useState } from "react";
import { logout, me, type PublicUser } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { VendorsPage } from "./pages/VendorsPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";

type Page =
  | { name: "vendors" }
  | { name: "runs" }
  | { name: "run-detail"; runId: string };

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

  const navItem = (label: string, active: boolean, onClick: () => void) => (
    <div
      style={{ ...styles.navItem, ...(active ? styles.navItemActive : {}) }}
      onClick={onClick}
    >
      {label}
    </div>
  );

  return (
    <div style={styles.root}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>Multi-Agent Dev</div>
        <nav style={styles.nav}>
          {navItem("供应商管理", page.name === "vendors", () => setPage({ name: "vendors" }))}
          {navItem("开发任务", page.name === "runs" || page.name === "run-detail", () => setPage({ name: "runs" }))}
        </nav>
        <div style={styles.userBox}>
          <div style={styles.userName}>{user.username}（{user.role}）</div>
          <button style={styles.logoutButton} onClick={() => void onLogout()}>退出登录</button>
        </div>
        <div style={styles.status}>
          {backendReady ? "● 后端已连接" : "○ 连接后端中..."}
        </div>
      </aside>
      <main style={styles.main}>
        {page.name === "vendors" && <VendorsPage />}
        {page.name === "runs" && (
          <RunsPage
            onOpenRun={(runId) => setPage({ name: "run-detail", runId })}
          />
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
    fontFamily: "system-ui, sans-serif",
    color: "#52606d",
  },
  root: { display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif", color: "#1f2933" },
  sidebar: {
    width: 200,
    background: "#1c2333",
    color: "#d9e2ef",
    display: "flex",
    flexDirection: "column",
    padding: "16px 12px",
    boxSizing: "border-box",
  },
  logo: { fontSize: 16, fontWeight: 700, marginBottom: 20 },
  nav: { flex: 1 },
  navItem: { padding: "8px 10px", borderRadius: 6, fontSize: 14, cursor: "pointer" },
  navItemActive: { background: "#2a3550", color: "#fff" },
  userBox: { borderTop: "1px solid #2a3550", paddingTop: 10, marginTop: 8 },
  userName: { fontSize: 12, color: "#8fa0bd", marginBottom: 6 },
  logoutButton: {
    background: "none",
    border: "1px solid #3a4a6b",
    color: "#d9e2ef",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
  status: { fontSize: 12, color: "#8fa0bd", marginTop: 16 },
  main: { flex: 1, overflow: "auto", background: "#f5f7fa", padding: 24, boxSizing: "border-box" },
};
