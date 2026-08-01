import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelRun,
  getRun,
  integrateRun,
  listRunHistory,
  openRunEvents,
  pauseRun,
  resumeRun,
  retryRun,
  type AgentEvent,
  type IntegrationReport,
  type PlanTask,
  type RunSnapshot,
  type RunTaskSnapshot,
} from "../api";

interface TaskResult {
  status: string;
  output?: string;
  changedFiles?: string[];
  tests?: Array<{ command: string; passed: boolean; output?: string }>;
  risks?: string[];
  diff?: string;
  usage?: { totalTokens: number; costUsd: number; inputTokens: number; outputTokens: number };
  error?: { code: string; message: string };
}

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
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [integration, setIntegration] = useState<IntegrationReport | null>(null);
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

  const onPause = async () => {
    await pauseRun(runId);
    await load();
  };

  const onResume = async () => {
    await resumeRun(runId);
    await load();
  };

  const onRetry = async () => {
    await retryRun(runId);
    await load();
  };

  const onIntegrate = async () => {
    const result = await integrateRun(runId);
    if (result.status === 200) {
      setIntegration(result.data as IntegrationReport);
    } else {
      const error = (result.data as { error?: { message?: string } }).error;
      setIntegration({
        runId,
        status: "failed",
        appliedTasks: [],
        conflicts: [],
        message: error?.message ?? `集成失败：${result.status}`,
      });
    }
  };

  const nodes = run?.dag ? layoutDag(run.dag.tasks) : [];
  const levels = nodes.length > 0 ? Math.max(...nodes.map((node) => node.level)) + 1 : 0;

  return (
    <div>
      <div style={styles.header}>
        <button style={styles.backButton} onClick={onBack}>← 返回</button>
        <h2 style={styles.title}>Run 详情</h2>
        {run && !TERMINAL.has(run.status) && run.status !== "created" && !run.paused && (
          <button style={styles.pauseButton} onClick={() => void onPause()}>暂停</button>
        )}
        {run && run.paused && (
          <button style={styles.resumeButton} onClick={() => void onResume()}>继续</button>
        )}
        {run && (run.status === "failed" || run.status === "cancelled") && (
          <button style={styles.retryButton} onClick={() => void onRetry()}>重试 Run</button>
        )}
        {run && (run.status === "succeeded" || run.status === "failed") && (
          <button style={styles.integrateButton} onClick={() => void onIntegrate()}>集成</button>
        )}
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
                {run.paused ? "paused" : run.status}
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

          {integration && (
            <section style={styles.card}>
              <h3 style={styles.cardTitle}>集成结果</h3>
              <div style={styles.runMeta}>
                <span style={{ ...styles.badge, background: integration.status === "merged" ? "#0a7d33" : integration.status === "conflict" ? "#b91c1c" : "#6b7280" }}>
                  {integration.status}
                </span>
                <span>{integration.message}</span>
              </div>
              {integration.branch && (
                <div style={styles.metaLine}>
                  分支：<span style={styles.mono}>{integration.branch}</span>
                  {" · base "}<span style={styles.mono}>{integration.baseCommit?.slice(0, 8)}</span>
                </div>
              )}
              {integration.appliedTasks.length > 0 && (
                <div style={styles.metaLine}>已集成任务：{integration.appliedTasks.join(", ")}</div>
              )}
              {integration.conflicts.length > 0 && (
                <div style={styles.resultSection}>
                  <div style={styles.resultLabel}>冲突（需人工处理）</div>
                  {integration.conflicts.map((conflict) => (
                    <div key={conflict.taskId} style={styles.riskItem}>
                      ⚠ {conflict.taskId}：{conflict.detail}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

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
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {run.tasks.map((task) => (
                    <React.Fragment key={task.taskId}>
                      <tr>
                        <td style={styles.mono}>{task.taskId}</td>
                        <td>{task.role}</td>
                        <td>
                          <span style={{ ...styles.badge, background: STATUS_COLORS[task.status] ?? "#9aa4b2" }}>
                            {task.status}
                          </span>
                        </td>
                        <td style={styles.mono}>{task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "-"}</td>
                        <td style={styles.errCell}>{task.error?.message ?? task.title}</td>
                        <td>
                          {task.result ? (
                            <button
                              style={styles.detailButton}
                              onClick={() => setExpandedTask(expandedTask === task.taskId ? null : task.taskId)}
                            >
                              {expandedTask === task.taskId ? "收起" : "结果"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {expandedTask === task.taskId && task.result ? (
                        <tr>
                          <td colSpan={6}>
                            <TaskResultPanel result={task.result as unknown as TaskResult} />
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
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

function TaskResultPanel({ result }: { result: TaskResult }) {
  return (
    <div style={styles.resultPanel}>
      <div style={styles.resultHeader}>
        <span>状态：<b style={{ color: result.status === "completed" ? "#0a7d33" : "#b91c1c" }}>{result.status}</b></span>
        {result.usage && (
          <span style={styles.usage}>
            tokens {result.usage.totalTokens}（in {result.usage.inputTokens} / out {result.usage.outputTokens}）
            {" · "}成本 ${result.usage.costUsd.toFixed(6)}
          </span>
        )}
      </div>

      {result.error && <div style={styles.msgErr}>错误：{result.error.message}</div>}

      {(result.changedFiles?.length ?? 0) > 0 && (
        <div style={styles.resultSection}>
          <div style={styles.resultLabel}>修改文件（{result.changedFiles!.length}）</div>
          <div style={styles.fileList}>
            {result.changedFiles!.map((file) => (
              <div key={file} style={styles.fileItem}>📄 {file}</div>
            ))}
          </div>
        </div>
      )}

      {result.diff && (
        <div style={styles.resultSection}>
          <div style={styles.resultLabel}>代码变更（Diff）</div>
          <pre style={styles.diffBlock}>{result.diff}</pre>
        </div>
      )}

      {(result.tests?.length ?? 0) > 0 && (
        <div style={styles.resultSection}>
          <div style={styles.resultLabel}>测试结果</div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th>命令</th>
                <th>结果</th>
                <th>输出</th>
              </tr>
            </thead>
            <tbody>
              {result.tests!.map((test, index) => (
                <tr key={`${test.command}-${index}`}>
                  <td style={styles.mono}>{test.command}</td>
                  <td>
                    <span style={test.passed ? styles.testPass : styles.testFail}>
                      {test.passed ? "通过" : "失败"}
                    </span>
                  </td>
                  <td style={styles.testOutput}>{test.output ? String(test.output).slice(0, 200) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(result.risks?.length ?? 0) > 0 && (
        <div style={styles.resultSection}>
          <div style={styles.resultLabel}>风险</div>
          {result.risks!.map((risk, index) => (
            <div key={index} style={styles.riskItem}>⚠ {risk}</div>
          ))}
        </div>
      )}

      {result.output && (
        <div style={styles.resultSection}>
          <div style={styles.resultLabel}>Agent 输出</div>
          <pre style={styles.outputBlock}>{result.output.slice(0, 2000)}</pre>
        </div>
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
  pauseButton: {
    padding: "8px 14px",
    background: "#d97706",
    color: "#fff",
    border: 0,
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
  },
  resumeButton: {
    padding: "8px 14px",
    background: "#0a7d33",
    color: "#fff",
    border: 0,
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
  },
  retryButton: {
    padding: "8px 14px",
    background: "#2563eb",
    color: "#fff",
    border: 0,
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
  },
  integrateButton: {
    padding: "8px 14px",
    background: "#7c3aed",
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
  detailButton: {
    padding: "4px 10px",
    border: "1px solid #cbd2d9",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
  },
  resultPanel: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 14 },
  resultHeader: { display: "flex", alignItems: "center", gap: 16, marginBottom: 10, fontSize: 13 },
  usage: { fontSize: 12, color: "#52606d" },
  resultSection: { marginTop: 10 },
  resultLabel: { fontSize: 13, fontWeight: 600, marginBottom: 6 },
  fileList: { display: "flex", flexWrap: "wrap", gap: 8 },
  fileItem: {
    fontSize: 12,
    fontFamily: "Consolas, monospace",
    background: "#eef2f7",
    borderRadius: 4,
    padding: "3px 8px",
  },
  testPass: { color: "#0a7d33", fontWeight: 600 },
  testFail: { color: "#b91c1c", fontWeight: 600 },
  testOutput: { fontSize: 12, color: "#52606d", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  riskItem: { fontSize: 12, color: "#b45309", marginBottom: 4 },
  diffBlock: {
    background: "#0f172a",
    color: "#dbeafe",
    borderRadius: 6,
    padding: 10,
    fontSize: 12,
    fontFamily: "Consolas, monospace",
    maxHeight: 320,
    overflowY: "auto",
    whiteSpace: "pre",
    overflowX: "auto",
  },
  outputBlock: {
    background: "#10151f",
    color: "#c9d4e4",
    borderRadius: 6,
    padding: 10,
    fontSize: 12,
    maxHeight: 200,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
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
