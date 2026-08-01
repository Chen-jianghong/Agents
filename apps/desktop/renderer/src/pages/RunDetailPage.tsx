import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelRun,
  getRun,
  integrateRun,
  listRunHistory,
  mergeRun,
  openRunEvents,
  pauseRun,
  resumeRun,
  retryRun,
  reviewRun,
  type AgentEvent,
  type IntegrationReport,
  type MergeReport,
  type PlanTask,
  type ReviewOutcome,
  type RunSnapshot,
  type RunTaskSnapshot,
} from "../api";
import { statusBadge, statusDot, theme } from "../theme";

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
  const [merge, setMerge] = useState<MergeReport | null>(null);
  const [review, setReview] = useState<ReviewOutcome | null>(null);
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

  const onMerge = async () => {
    const result = await mergeRun(runId);
    setMerge(result.data as MergeReport);
  };

  const onReview = async () => {
    const result = await reviewRun(runId);
    if (result.status === 200) {
      setReview(result.data as ReviewOutcome);
    } else {
      const error = (result.data as { error?: { message?: string } }).error;
      setReview({
        status: "review_failed",
        reason: { code: "request_failed", message: error?.message ?? `审查失败：${result.status}` },
      });
    }
  };

  const nodes = run?.dag ? layoutDag(run.dag.tasks) : [];

  return (
    <div>
      <div style={styles.header}>
        <button style={styles.backButton} onClick={onBack}>← 返回</button>
        <h2 style={styles.title}>Run 详情</h2>
        {run && !TERMINAL.has(run.status) && run.status !== "created" && !run.paused && (
          <button style={actionButton(theme.warning)} onClick={() => void onPause()}>暂停</button>
        )}
        {run && run.paused && (
          <button style={actionButton(theme.success)} onClick={() => void onResume()}>继续</button>
        )}
        {run && (run.status === "failed" || run.status === "cancelled") && (
          <button style={actionButton(theme.indigo)} onClick={() => void onRetry()}>重试 Run</button>
        )}
        {run && (run.status === "succeeded" || run.status === "failed") && (
          <button style={actionButton(theme.violet)} onClick={() => void onIntegrate()}>集成</button>
        )}
        {run && (run.status === "succeeded" || run.status === "failed") && (
          <button style={actionButton("#0891b2")} onClick={() => void onReview()}>审查</button>
        )}
        {run && integration?.status === "merged" && (
          <button style={actionButton(theme.success)} onClick={() => void onMerge()}>合并到 main</button>
        )}
        {run && !TERMINAL.has(run.status) && run.status !== "created" && (
          <button style={actionButton(theme.danger)} onClick={() => void onCancel()}>取消 Run</button>
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
              <span style={statusBadge(run.status)}>
                <span style={statusDot(run.status)} />
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
                <span style={statusBadge(integration.status === "merged" ? "succeeded" : integration.status === "conflict" ? "failed" : "cancelled")}>
                  <span style={statusDot(integration.status === "merged" ? "succeeded" : "failed")} />
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

          {merge && (
            <section style={styles.card}>
              <h3 style={styles.cardTitle}>合并结果</h3>
              <div style={styles.runMeta}>
                <span style={statusBadge(merge.status === "merged" ? "succeeded" : "failed")}>
                  <span style={statusDot(merge.status === "merged" ? "succeeded" : "failed")} />
                  {merge.status}
                </span>
                <span>{merge.message}</span>
              </div>
            </section>
          )}

          {review && (
            <section style={styles.card}>
              <h3 style={styles.cardTitle}>代码审查结果</h3>
              {review.status === "review_failed" ? (
                <div style={styles.msgErr}>审查失败：{review.reason.message}</div>
              ) : (
                <>
                  <div style={styles.resultSection}>
                    <div style={styles.resultLabel}>问题（{review.report.findings.length}）</div>
                    {review.report.findings.map((finding, index) => (
                      <div key={index} style={styles.findings}>• {finding}</div>
                    ))}
                  </div>
                  <div style={styles.resultSection}>
                    <div style={styles.resultLabel}>建议</div>
                    {review.report.recommendations.map((item, index) => (
                      <div key={index} style={styles.recommendations}>→ {item}</div>
                    ))}
                  </div>
                  {(review.report.risks.length > 0) && (
                    <div style={styles.resultSection}>
                      <div style={styles.resultLabel}>风险</div>
                      {review.report.risks.map((risk, index) => (
                        <div key={index} style={styles.riskItem}>⚠ {risk}</div>
                      ))}
                    </div>
                  )}
                  {(review.report.evidence.length > 0) && (
                    <div style={styles.resultSection}>
                      <div style={styles.resultLabel}>证据</div>
                      {review.report.evidence.map((item, index) => (
                        <div key={index} style={styles.mono}>{item}</div>
                      ))}
                    </div>
                  )}
                </>
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
                  const status = run.tasks.find((t) => t.taskId === task.id)?.status ?? "pending";
                  const color = theme.status[status] ?? theme.textFaint;
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
                            stroke={theme.borderStrong}
                            strokeWidth={1.5}
                            markerEnd="url(#arrowhead)"
                          />
                        );
                      })}
                      <rect x={x} y={y} width={120} height={48} rx={8} fill={theme.surfaceAlt} stroke={color} strokeWidth={1.5} />
                      <text x={x + 60} y={y + 22} textAnchor="middle" fontSize={12} fontWeight={600} fill={theme.text}>
                        {task.role}
                      </text>
                      <text x={x + 60} y={y + 38} textAnchor="middle" fontSize={10} fill={theme.textDim}>
                        {task.id}
                      </text>
                    </g>
                  );
                })}
                <defs>
                  <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill={theme.borderStrong} />
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
                    <th style={styles.th}>任务</th>
                    <th style={styles.th}>角色</th>
                    <th style={styles.th}>状态</th>
                    <th style={styles.th}>依赖</th>
                    <th style={styles.th}>说明</th>
                    <th style={styles.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {run.tasks.map((task) => (
                    <React.Fragment key={task.taskId}>
                      <tr>
                        <td style={{ ...styles.mono, ...styles.td }}>{task.taskId}</td>
                        <td style={styles.td}>{task.role}</td>
                        <td style={styles.td}>
                          <span style={statusBadge(task.status)}>
                            <span style={statusDot(task.status)} />
                            {task.status}
                          </span>
                        </td>
                        <td style={{ ...styles.mono, ...styles.td }}>{task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "-"}</td>
                        <td style={styles.errCell}>{task.error?.message ?? task.title}</td>
                        <td style={styles.td}>
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
                          <td colSpan={6} style={styles.td}>
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
        <span style={statusBadge(result.status === "completed" ? "succeeded" : "failed")}>
          <span style={statusDot(result.status === "completed" ? "succeeded" : "failed")} />
          {result.status}
        </span>
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
              <div key={file} style={styles.fileItem}>{file}</div>
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
                <th style={styles.th}>命令</th>
                <th style={styles.th}>结果</th>
                <th style={styles.th}>输出</th>
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

function actionButton(bg: string): React.CSSProperties {
  return {
    padding: "8px 16px",
    background: bg,
    color: "#0B1220",
    border: 0,
    borderRadius: theme.radiusSm,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity .15s ease",
  };
}

const styles: Record<string, React.CSSProperties> = {
  header: { display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" },
  backButton: {
    padding: "7px 14px",
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    background: theme.surface,
    color: theme.textDim,
    cursor: "pointer",
    fontSize: 13,
    transition: "border-color .15s ease, color .15s ease",
  },
  title: { margin: 0, fontSize: 22, fontWeight: 700, flex: 1 },
  card: {
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius + 4,
    padding: 22,
    marginBottom: 20,
    boxShadow: theme.shadowSm,
  },
  cardTitle: { margin: "0 0 16px", fontSize: 15, fontWeight: 600 },
  runMeta: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" },
  goal: { fontSize: 16, fontWeight: 600, marginBottom: 8 },
  metaLine: { fontSize: 12, color: theme.textDim, marginBottom: 4 },
  mono: { fontFamily: theme.mono, fontSize: 12, color: theme.textDim },
  msgErr: { marginTop: 8, fontSize: 13, color: theme.danger },
  empty: { fontSize: 13, color: theme.textFaint },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", fontSize: 11, color: theme.textFaint, padding: "0 12px 10px 0", fontWeight: 600 },
  td: { padding: "10px 12px 10px 0", borderTop: `1px solid ${theme.border}` },
  errCell: {
    fontSize: 12,
    color: theme.textDim,
    maxWidth: 280,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    padding: "10px 12px 10px 0",
    borderTop: `1px solid ${theme.border}`,
  },
  detailButton: {
    padding: "4px 12px",
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    background: theme.surfaceAlt,
    color: theme.textDim,
    cursor: "pointer",
    fontSize: 12,
    transition: "color .15s ease, border-color .15s ease",
  },
  resultPanel: {
    background: theme.surfaceAlt,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    padding: 16,
    marginTop: 4,
  },
  resultHeader: { display: "flex", alignItems: "center", gap: 16, marginBottom: 12, flexWrap: "wrap" },
  usage: { fontSize: 12, color: theme.textDim, fontFamily: theme.mono },
  resultSection: { marginTop: 12 },
  resultLabel: { fontSize: 13, fontWeight: 600, marginBottom: 6 },
  fileList: { display: "flex", flexWrap: "wrap", gap: 8 },
  fileItem: {
    fontSize: 12,
    fontFamily: theme.mono,
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: 4,
    padding: "3px 8px",
    color: theme.textDim,
  },
  testPass: { color: theme.success, fontWeight: 600 },
  testFail: { color: theme.danger, fontWeight: 600 },
  testOutput: {
    fontSize: 12,
    color: theme.textDim,
    maxWidth: 280,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  riskItem: { fontSize: 12, color: theme.warning, marginBottom: 4 },
  findings: { fontSize: 12, color: theme.text, marginBottom: 4 },
  recommendations: { fontSize: 12, color: theme.success, marginBottom: 4 },
  diffBlock: {
    background: "#0A0F1C",
    color: "#BBD3F0",
    borderRadius: theme.radiusSm,
    padding: 12,
    fontSize: 12,
    fontFamily: theme.mono,
    maxHeight: 320,
    overflowY: "auto",
    whiteSpace: "pre",
    overflowX: "auto",
    border: `1px solid ${theme.border}`,
  },
  outputBlock: {
    background: "#0A0F1C",
    color: "#C6D4E8",
    borderRadius: theme.radiusSm,
    padding: 12,
    fontSize: 12,
    fontFamily: theme.mono,
    maxHeight: 200,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    border: `1px solid ${theme.border}`,
  },
  log: {
    background: "#0A0F1C",
    color: "#C6D4E8",
    borderRadius: theme.radiusSm,
    padding: 12,
    maxHeight: 260,
    overflowY: "auto",
    fontFamily: theme.mono,
    fontSize: 12,
    border: `1px solid ${theme.border}`,
  },
  logLine: { padding: "2px 0", display: "flex", gap: 10 },
  logTime: { color: theme.textFaint, flexShrink: 0 },
  logType: { color: theme.primary, flexShrink: 0 },
  logTask: { color: theme.textDim },
};
