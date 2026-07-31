import React, { useEffect, useState } from "react";
import { VendorsPage } from "./pages/VendorsPage";

type Page = "vendors";

export function App() {
  const [page] = useState<Page>("vendors");
  const [backendReady, setBackendReady] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const { default: api } = await import("./api");
        const base = await api.apiBase();
        const response = await fetch(`${base}/api/health`);
        setBackendReady(response.ok);
      } catch {
        setBackendReady(false);
      }
    };
    void check();
  }, []);

  return (
    <div style={styles.root}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>Multi-Agent Dev</div>
        <nav style={styles.nav}>
          <div
            style={{ ...styles.navItem, ...(page === "vendors" ? styles.navItemActive : {}) }}
          >
            供应商管理
          </div>
        </nav>
        <div style={styles.status}>
          {backendReady ? "● 后端已连接" : "○ 连接后端中..."}
        </div>
      </aside>
      <main style={styles.main}>
        <VendorsPage />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
  status: { fontSize: 12, color: "#8fa0bd", marginTop: 16 },
  main: { flex: 1, overflow: "auto", background: "#f5f7fa", padding: 24, boxSizing: "border-box" },
};
