import React, { useCallback, useEffect, useRef, useState } from "react";
import { cancelRun, createRun, listRuns, startRun, type RunSnapshot } from "../api";

const STATUS_COLORS: Record<string, string> = {
  created: "#6b7280",
  planning: "#2563eb",
  ready: "#2563eb",
  running: "#2563eb",
  succeeded: "#0a7d33",
  failed: "#b91c1c",
  cancelled: "#6b7280",
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function RunsPage({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [goal, setGoal] = useState("");
  const [maxParallel, setMaxParallel] = useState("2");
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const result = await listRuns();
      if (result.status === 200) {
        setRuns(result.data);
      }
    } catch {
      // 后端可能尚未就绪，静默重试
    }
  }, []);

  useEffect(() => {
    void refresh();
    refreshTimer.current = setInterval(() => void refresh(), 3000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [refresh]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim()) {
      setMessage({ ok: false, text: "请输入开发需求" });
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const created = await createRun({
        goal: goal.trim(),
        ...(maxParallel.trim() ? { maxParallel: Number(maxParallel) } : {}),
      });
      if (created.status !== 200) {
        const error = (created.data as { error?: { message?: string } }).error;
        setMessage({ ok: false, text: `创建失败：${error?.message ?? created.status}` });
        return;
      }
      const run = created.data as RunSnapshot;
      const started = await startRun(run.runId);
      if (started.status !== 200) {
        setMessage({ ok: false, text: `Run 已创建但启动失败：${started.status}` });
        return;
      }
      setMessage({ ok: true, text: `已创建并启动 Run：${run.runId}（Planner 正在规划...）` });
      setGoal("");
      onOpenRun(run.runId);
      await refresh();
    } catch (error) {
      setMessage({ ok: false, text: `请求失败：${String(error)}` });
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = async (event: React.MouseEvent, runId: string) => {
    event.stopPropagation();
    await cancelRun(runId);
    await refresh();
  };

  return (
    <div>
      <h2 style={styles.title}>开发任务</h2>

      <section style={styles.card}>
        <h3 style={styles.cardTitle}>提交开发需求</h3>
        <form onSubmit={onSubmit}>
          <textarea
            style={styles.textarea}
            rows={4}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="用自然语言描述需求，例如：为后台增加团队成员管理功能，包含成员列表、新增、删除，并补充测试"
          />
          <div style={styles.submitRow}>
            <label style={styles.parallelLabel}>
              最大并行数
              <input
                style={styles.parallelInput}
                type="number"
                min={1}
                max={8}
                value={maxParallel}
                onChange={(event) => setMaxParallel(event.target.value)}
              />
            </label>
            <button style={styles.button} type="submit" disabled={submitting}>
              {submitting ? "提交中..." : "创建并启动 Run"}
            </button>
          </div>
          {message && (
            <div style={message.ok ? styles.msgOk : styles.msgErr}>{message.text}</div>
          )}
        </form>
      </section>

      <section style={styles.card}>
        <h3 style={styles.cardTitle}>Run 列表</h3>
        {runs.length === 0 ? (
          <div style={styles.empty}>还没有 Run，先在上方提交一个需求。</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th>Run ID</th>
                <th>需求</th>
                <th>状态</th>
                <th>并行数</th>
                <th>更新时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId} style={styles.row} onClick={() => onOpenRun(run.runId)}>
                  <td style={styles.mono}>{run.runId.slice(0, 12)}…</td>
                  <td style={styles.goalCell}>{run.goal}</td>
                  <td>
                    <span style={{ ...styles.badge, background: STATUS_COLORS[run.status] ?? "#6b7280" }}>
                      {run.status}
                    </span>
                  </td>
                  <td>{run.maxParallel}</td>
                  <td style={styles.mono}>{new Date(run.updatedAt).toLocaleTimeString()}</td>
                  <td>
                    {!TERMINAL.has(run.status) && run.status !== "created" && (
                      <button style={styles.linkButton} onClick={(event) => void onCancel(event, run.runId)}>
                        取消
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  title: { margin: "0 0 16px", fontSize: 20 },
  card: { background: "#fff", borderRadius: 10, padding: 20, marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,.08)" },
  cardTitle: { margin: "0 0 16px", fontSize: 15 },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    border: "1px solid #cbd2d9",
    borderRadius: 6,
    fontSize: 14,
    fontFamily: "inherit",
    resize: "vertical",
  },
  submitRow: { display: "flex", alignItems: "center", gap: 16, marginTop: 12 },
  parallelLabel: { fontSize: 13, color: "#52606d", display: "flex", alignItems: "center", gap: 8 },
  parallelInput: {
    width: 64,
    padding: "6px 8px",
    border: "1px solid #cbd2d9",
    borderRadius: 6,
    fontSize: 14,
  },
  button: {
    marginLeft: "auto",
    padding: "10px 18px",
    background: "#2563eb",
    color: "#fff",
    border: 0,
    borderRadius: 6,
    fontSize: 14,
    cursor: "pointer",
  },
  msgOk: { marginTop: 12, fontSize: 13, color: "#0a7d33" },
  msgErr: { marginTop: 12, fontSize: 13, color: "#b91c1c" },
  empty: { fontSize: 13, color: "#8a94a6" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  row: { cursor: "pointer" },
  goalCell: { maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  badge: {
    display: "inline-block",
    color: "#fff",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 12,
  },
  mono: { fontFamily: "Consolas, monospace", fontSize: 12, color: "#52606d" },
  linkButton: {
    background: "none",
    border: "none",
    color: "#b91c1c",
    cursor: "pointer",
    fontSize: 13,
    padding: 0,
  },
};
