import React, { useState } from "react";
import { login } from "../api";
import { theme } from "../theme";

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
      <div style={styles.glow} />
      <form style={styles.card} onSubmit={onSubmit}>
        <svg width="44" height="44" viewBox="0 0 26 26" style={styles.logo} aria-hidden="true">
          <line x1="13" y1="13" x2="4" y2="6" stroke={theme.borderStrong} strokeWidth="1.4" />
          <line x1="13" y1="13" x2="21" y2="6" stroke={theme.borderStrong} strokeWidth="1.4" />
          <circle cx="4" cy="6" r="3" fill="none" stroke={theme.primary} strokeWidth="1.4" />
          <circle cx="21" cy="6" r="3" fill="none" stroke={theme.primary} strokeWidth="1.4" />
          <circle cx="13" cy="13" r="4.5" fill={theme.primary} />
        </svg>
        <div style={styles.title}>Multi-Agent Dev</div>
        <div style={styles.subtitle}>多智能体并行开发平台</div>
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
    background: `radial-gradient(900px 500px at 50% 0%, rgba(34,211,238,.07), transparent), ${theme.bg}`,
    fontFamily: theme.font,
    position: "relative",
    overflow: "hidden",
  },
  glow: {
    position: "absolute",
    width: 420,
    height: 420,
    borderRadius: 999,
    background: "rgba(34,211,238,.06)",
    filter: "blur(60px)",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
  },
  card: {
    position: "relative",
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: 16,
    padding: "36px 40px",
    width: 360,
    boxShadow: theme.shadow,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  logo: { alignSelf: "center", marginBottom: 2 },
  title: { fontSize: 20, fontWeight: 700, textAlign: "center", letterSpacing: ".02em" },
  subtitle: { fontSize: 13, color: theme.textDim, textAlign: "center", marginBottom: 8 },
  field: { display: "block" },
  label: { display: "block", fontSize: 12, color: theme.textDim, marginBottom: 5 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "9px 12px",
    background: theme.surfaceAlt,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    fontSize: 14,
    color: theme.text,
    outline: "none",
    transition: "border-color .15s ease",
  },
  error: { fontSize: 13, color: theme.danger },
  button: {
    padding: "11px 0",
    background: theme.primary,
    color: theme.primaryText,
    border: 0,
    borderRadius: theme.radiusSm,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
    transition: "opacity .15s ease",
  },
  hint: { fontSize: 11, color: theme.textFaint, textAlign: "center", marginTop: 4 },
};
