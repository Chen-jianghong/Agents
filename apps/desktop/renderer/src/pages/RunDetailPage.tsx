import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelRun,
  getRun,
  listRunHistory,
  openRunEvents,
  type AgentEvent,
  type PlanTask,
  type RunSnapshot,
} from "../api";

const STATUS_COLORS: Record<string, string> = {
  pending: "#9aa4b2",
  ready: "#2563eb",
  running: "#2563eb",
  testing: "#d97706",
  succeeded: "#0a7d33",
  failed: "#b91c1c",
  cancelled: "#6b7280",
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

interface DagNode {
  task: PlanTask;
  level: number;
  index: number;
}

/** 计算每个任务的最长依赖层级（用于 DAG 列布局）。 */
function layoutDag(tasks: PlanTask[]): DagNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levelOf = new Map<string, number>();
  const visit = (taskId: string): number => {
    const cached = levelOf.get(taskId);
    if (cached !== undefined) return cached;
    const task = byId.get(taskId);
    if (!task) {
      levelOf.set(taskId, 0);
      return 0;
    }
    const level = task.dependsOn.length === 0
      ? 0
      : Math.max(...task.dependsOn.map((dep) => visit(dep) + 1));
    levelOf.set(taskId, level);
    return level;
  };
  for (const task of tasks) visit(task.id);

  const perLevel = new Map<number, DagNode[]>();
  for (const task of tasks) {
    const level = levelOf.get(task.id) ?? 0;
    const list = perLevel.get(level) ?? [];
    list.push({ task, level, index: list.length });
    perLevel.set(level, list);
  }
  return [...perLevel.values()].flat();
}

export function RunDetailPage({
  runId,
  onBack,
  onRefreshList,
}: {
  runId: string;
  onBack: () => void;
  onRefreshList: () => void;
}) {
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const result = await getRun(runId);
    if (result.status === 200) {
      setRun(result.data as RunSnapshot);
      setError(null);
    } else {
      setError((result.data as { error?: { message?: string } }).error?.message ?? `加载失败：${result.status}`);
    }
  }, [runId]);

  useEffect(() => {
    void load();
    void listRunHistory(runId).then((result) => {
      if (result.status === 200) setEvents(result.data);
    });
    const close = openRunEvents(runId, (event) => {
      setEvents((prev) => [...prev.slice(-200), event]);
      void load();
    });
    const timer = setInterval(() => void load(), 3000);
    return () => {
      close();
      clearInterval(timer);
    };
  }, [runId, load]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events]);

  const onCancel = async () => {
    await cancelRun(runId);
    await load();
  };

  const nodes = run?.dag ? layoutDag(run.dag.tasks) : [];
  const levels = nodes.length > 0 ? Math.max(...nodes.map((node) => node.level)) + 1 : 0;

  return (
    <div>
      <div style={styles.header}>
        <button style={styles.backButton} onClick={onBack}>← 返回</button>
        <h2 style={styles.title}>Run 详情</h2>
        {run && !TERMINAL.has(run.status) && run.status !== "created" && (
          <button style={styles.cancelButton} onClick={() => void onCancel()}>取消 Run</button>
        )}
      </div>

      {error ? (
        <div style={styles.card}><div style={styles.msgErr}>{error}</div></div>
      ) : !run ? (
        <div style={styles.card}><div style={styles.empty}>加载中...</div></div>
      ) : (
        <>
          <section style={styles.card}>
            <div style={styles.runMeta}>
              <span style={styles.mono}>{run.runId}</span>
              <span style={{ ...styles.badge, background: STATUS_COLORS[run.status] ?? "#6b7280" }}>
                {run.status}
              </span>
            </div>
            <div style={styles.goal}>{run.goal}</div>
            <div style={styles.metaLine}>
              工作区：<span style={styles.mono}>{run.workspace}</span>
              {"  "}并行上限：{run.maxParallel}
              {"  "}创建于：{new Date(run.createdAt).toLocaleString()}
            </div>
            {run.error && <div style={styles.msgErr}>Run 错误：{run.error.message}</div>}
          </section>

          {run.dag && nodes.length > 0 && (
            <section style={styles.card}>
              <h3 style={styles.cardTitle}>任务 DAG</h3>
              <svg width="100%" height={Math.max(90, nodes.length * 56)} viewBox={`0 0 720 ${Math.max(90, nodes.length * 56)}`}>
                {nodes.map(({ task, level, index }) => {
                  const x = 30 + level * 180;
                  const y = 24 + index * 56;
                  const color = STATUS_COLORS[run.tasks.find((t) => t.taskId === task.id)?.status ?? "pending"] ?? "#9aa4b2";
                  return (
                    <g key={task.id}>
                      {task.dependsOn.map((dep) => {
                        const depNode = nodes.find((node) => node.task.id === dep);
                        if (!depNode) return null;
                        return (
                          <line
                            key={`${dep}-${task.id}`}
                            x1={30 + depNode.level * 180 + 120}
                            y1={24 + depNode.index * 56 + 24}
                            x2={x}
                            y2={y + 24}
                            stroke="#9aa4b2"
                            strokeWidth={1.5}
                            markerEnd="url(#arrowhead)"
                          />
                        );
                      })}
                      <rect x={x} y={y} width={120} height={48} rx={8} fill={color} opacity={0.12} stroke={color} strokeWidth={1.5} />
                      <text x={x + 60} y={y + 22} textAnchor="middle" fontSize={12} fontWeight={600} fill="#1f2933">
                        {task.role}
                      </text>
                      <text x={x + 60} y={y + 38} textAnchor="middle" fontSize={10} fill="#52606d">
                        {task.id}
                      </text>
                    </g>
                  );
                })}
                <defs>
                  <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill="#9aa4b2" />
                  </marker>
                </defs>
              </svg>
            </section>
          )}

          <section style={styles.card}>
            <h3 style={styles.cardTitle}>任务状态</h3>
            {run.tasks.length === 0 ? (
              <div style={styles.empty}>Planner 尚未输出任务（或规划失败）。</div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>依赖</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {run.tasks.map((task) => (
                    <tr key={task.taskId}>
                      <td style={styles.mono}>{task.taskId}</td>
                      <td>{task.role}</td>
                      <td>
                        <span style={{ ...styles.badge, background: STATUS_COLORS[task.status] ?? "#9aa4b2" }}>
                          {task.status}
                        </span>
                      </td>
                      <td style={styles.mono}>{task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "-"}</td>
                      <td style={styles.errCell}>{task.error?.message ?? task.title}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section style={styles.card}>
            <h3 style={styles.cardTitle}>事件日志（实时）</h3>
            <div ref={logRef} style={styles.log}>
              {events.length === 0 ? (
                <div style={styles.empty}>暂无事件。</div>
              ) : (
                events.map((event) => (
                  <div key={event.eventId} style={styles.logLine}>
                    <span style={styles.logTime}>{new Date(event.timestamp).toLocaleTimeString()}</span>
                    <span style={styles.logType}>{event.type}</span>
                    {event.agentTaskId && <span style={styles.logTask}>{event.agentTaskId}</span>}
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 },
  backButton: {
    padding: "6px 12px",
    border: "1px solid #cbd2d9",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 13,
  },
  title: { margin: 0, fontSize: 20, flex: 1 },
  cancelButton: {
    padding: "8px 14px",
    background: "#b91c1c",
    color: "#fff",
    border: 0,
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
  },
  card: { background: "#fff", borderRadius: 10, padding: 20, marginBottom: 20, boxShadow: "0 1px 3px rgba(0,0,0,.08)" },
  cardTitle: { margin: "0 0 16px", fontSize: 15 },
  runMeta: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  goal: { fontSize: 15, fontWeight: 600, marginBottom: 8 },
  metaLine: { fontSize: 12, color: "#52606d" },
  badge: { display: "inline-block", color: "#fff", padding: "2px 8px", borderRadius: 999, fontSize: 12 },
  msgErr: { marginTop: 8, fontSize: 13, color: "#b91c1c" },
  empty: { fontSize: 13, color: "#8a94a6" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  mono: { fontFamily: "Consolas, monospace", fontSize: 12 },
  errCell: { fontSize: 12, color: "#52606d", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  log: {
    background: "#10151f",
    color: "#c9d4e4",
    borderRadius: 8,
    padding: 12,
    maxHeight: 260,
    overflowY: "auto",
    fontFamily: "Consolas, monospace",
    fontSize: 12,
  },
  logLine: { padding: "2px 0", display: "flex", gap: 10 },
  logTime: { color: "#6b7a90", flexShrink: 0 },
  logType: { color: "#7dd3fc", flexShrink: 0 },
  logTask: { color: "#a5b4c8" },
};
