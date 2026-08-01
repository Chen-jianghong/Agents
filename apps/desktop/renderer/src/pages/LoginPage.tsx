import React, { useState } from "react";
import { login } from "../api";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await login(username.trim(), password);
      if (result.status === 200) {
        onLoggedIn();
        return;
      }
      const message = (result.data as { error?: { message?: string } }).error?.message;
      setError(message ?? `登录失败：${result.status}`);
    } catch (caught) {
      setError(`请求失败：${String(caught)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.wrap}>
      <form style={styles.card} onSubmit={onSubmit}>
        <div style={styles.logo}>Multi-Agent Dev</div>
        <h2 style={styles.title}>登录</h2>
        <label style={styles.field}>
          <span style={styles.label}>用户名</span>
          <input style={styles.input} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>密码</span>
          <input style={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div style={styles.error}>{error}</div>}
        <button style={styles.button} type="submit" disabled={submitting || !password}>
          {submitting ? "登录中..." : "登录"}
        </button>
        <div style={styles.hint}>默认账号 admin（初始密码 admin，请在部署后修改）</div>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    height: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#f5f7fa",
    fontFamily: "system-ui, sans-serif",
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "32px 36px",
    width: 340,
    boxShadow: "0 4px 16px rgba(0,0,0,.08)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  logo: { fontSize: 18, fontWeight: 700, color: "#1c2333", textAlign: "center" },
  title: { margin: 0, fontSize: 16, textAlign: "center", color: "#52606d" },
  field: { display: "block" },
  label: { display: "block", fontSize: 13, color: "#52606d", marginBottom: 4 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    border: "1px solid #cbd2d9",
    borderRadius: 6,
    fontSize: 14,
  },
  error: { fontSize: 13, color: "#b91c1c" },
  button: {
    padding: "10px 0",
    background: "#2563eb",
    color: "#fff",
    border: 0,
    borderRadius: 6,
    fontSize: 14,
    cursor: "pointer",
  },
  hint: { fontSize: 12, color: "#8a94a6", textAlign: "center" },
};
