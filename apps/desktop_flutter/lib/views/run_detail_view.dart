import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import '../api.dart';

const accent = Color(0xFFE35B24);
const line = Color(0xFFDCE3EC);
const muted = Color(0xFF718096);
const ink = Color(0xFF172033);
const brandBlue = Color(0xFF1769D1);

class AgentEvent {
  final String eventId;
  final String type;
  final String timestamp;
  final Map<String, dynamic> payload;
  AgentEvent({required this.eventId, required this.type, required this.timestamp, required this.payload});

  factory AgentEvent.fromJson(Map<String, dynamic> json) => AgentEvent(
        eventId: json['eventId']?.toString() ?? '',
        type: json['type']?.toString() ?? '',
        timestamp: json['timestamp']?.toString() ?? '',
        payload: (json['payload'] as Map<String, dynamic>?) ?? {},
      );
}

/// Run 详情页：轮询快照 + SSE 实时事件日志，展示任务状态与操作按钮。
class RunDetailView extends StatefulWidget {
  final Api api;
  final String runId;
  final VoidCallback onBack;
  const RunDetailView({super.key, required this.api, required this.runId, required this.onBack});

  @override
  State<RunDetailView> createState() => _RunDetailViewState();
}

class _RunDetailViewState extends State<RunDetailView> {
  RunSnapshot? run;
  String? error;
  Timer? timer;
  final List<AgentEvent> events = [];
  final ScrollController logScroll = ScrollController();
  HttpClient? _sseClient;
  bool _sseDone = false;
  Map<String, dynamic>? integration;
  Map<String, dynamic>? review;
  Map<String, dynamic>? merge;
  final Set<String> expandedTasks = {};

  @override
  void initState() {
    super.initState();
    _load();
    timer = Timer.periodic(const Duration(seconds: 3), (_) => _load());
    _subscribe();
  }

  @override
  void dispose() {
    timer?.cancel();
    _sseClient?.close(force: true);
    logScroll.dispose();
    super.dispose();
  }

  /// 订阅 Run 的 SSE 实时事件流（text/event-stream）。
  Future<void> _subscribe() async {
    try {
      final client = HttpClient();
      _sseClient = client;
      final request = await client
          .getUrl(Uri.parse(
              '${Api.defaultBase}/api/runs/${Uri.encodeComponent(widget.runId)}/events'))
          .timeout(const Duration(seconds: 5));
      final response = await request.close();
      if (response.statusCode != 200) {
        _sseDone = true;
        return;
      }
      await for (final line
          in response.transform(utf8.decoder).transform(const LineSplitter())) {
        if (!line.startsWith('data: ')) continue;
        try {
          final event =
              AgentEvent.fromJson(jsonDecode(line.substring(6)) as Map<String, dynamic>);
          if (mounted) {
            setState(() {
              events.add(event);
              if (events.length > 300) events.removeRange(0, events.length - 300);
            });
            _load();
            if (logScroll.hasClients) {
              logScroll.jumpTo(logScroll.position.maxScrollExtent);
            }
          }
        } catch (_) {
          // 忽略无法解析的帧
        }
      }
    } catch (_) {
      // SSE 断开（Run 结束或后端未就绪），保留轮询作为兜底。
    } finally {
      _sseDone = true;
    }
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.getRun(widget.runId);
      if (mounted) setState(() {
        run = r;
        error = null;
      });
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _action(String action) async {
    try {
      await widget.api.runAction(widget.runId, action);
      await _load();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _integrate() async {
    final r = await widget.api.integrate(widget.runId);
    if (mounted) setState(() => integration = {'status': r['status'], 'data': r['data']});
  }

  Future<void> _review() async {
    final r = await widget.api.reviewRun(widget.runId);
    if (mounted) setState(() => review = {'status': r['status'], 'data': r['data']});
  }

  Future<void> _merge() async {
    final r = await widget.api.mergeRun(widget.runId);
    if (mounted) setState(() => merge = {'status': r['status'], 'data': r['data']});
  }

  @override
  Widget build(BuildContext context) {
    final r = run;
    return ListView(padding: const EdgeInsets.all(28), children: [
      Row(children: [
        TextButton(onPressed: widget.onBack, child: const Text('← 返回')),
        const Text('Run 详情', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
        const Spacer(),
        if (r != null) ..._actions(r),
      ]),
      const SizedBox(height: 14),
      if (error != null)
        _card(Text(error!, style: const TextStyle(color: Color(0xFFD94B3D), fontSize: 13)))
      else if (r == null)
        _card(const Text('加载中...', style: TextStyle(color: muted)))
      else ...[
        _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text(r.runId, style: const TextStyle(fontFamily: 'Consolas', fontSize: 12, color: muted)),
            const SizedBox(width: 12),
            _statusChip(r.paused ? 'paused' : r.status),
          ]),
          const SizedBox(height: 10),
          Text(r.goal, style: const TextStyle(fontSize: 14, height: 1.6)),
          const SizedBox(height: 8),
          Text('工作区：${r.workspace}   并行上限：${r.maxParallel}   创建于：${_time(r.createdAt)}', style: const TextStyle(fontSize: 12, color: muted)),
          if (r.error != null) ...[
            const SizedBox(height: 8),
            Text('Run 错误：${r.error}', style: const TextStyle(color: Color(0xFFD94B3D), fontSize: 13)),
          ],
        ])),
        const SizedBox(height: 16),
        if (run?.dag != null) ...[
          _card(_dagView(run!.dag!)),
          const SizedBox(height: 16),
        ],
        _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('任务状态', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 10),
          if (r.tasks.isEmpty)
            const Text('Planner 尚未输出任务（或规划失败）。', style: TextStyle(fontSize: 13, color: muted))
          else
            for (final task in r.tasks) ...[
              _taskRow(task),
              if (expandedTasks.contains(task.taskId) && task.result != null)
                _taskResult(task.result!),
            ],
        ])),
        const SizedBox(height: 16),
        if (integration != null) ...[
          _card(_integrationView()),
          const SizedBox(height: 16),
        ],
        if (review != null) ...[
          _card(_reviewView()),
          const SizedBox(height: 16),
        ],
        if (merge != null) ...[
          _card(_mergeView()),
          const SizedBox(height: 16),
        ],
        _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Text('实时事件', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const Spacer(),
            Text(_sseDone && events.isEmpty ? '事件流已结束' : (events.isNotEmpty ? '${events.length} 条' : '连接中...'),
                style: const TextStyle(fontSize: 11, color: muted)),
          ]),
          const SizedBox(height: 8),
          if (events.isEmpty)
            const Text('等待事件...', style: TextStyle(fontSize: 12, color: muted))
          else
            SizedBox(
              height: 220,
              child: ListView.builder(
                controller: logScroll,
                itemCount: events.length,
                itemBuilder: (_, i) => _eventRow(events[i]),
              ),
            ),
        ])),
      ],
    ]);
  }

  Widget _eventRow(AgentEvent event) {
    final summary = event.payload['message'] ??
        event.payload['taskId'] ??
        event.payload['status'] ??
        '';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(_clock(event.timestamp), style: const TextStyle(fontFamily: 'Consolas', fontSize: 11, color: muted)),
        const SizedBox(width: 10),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          decoration: BoxDecoration(color: brandBlue.withValues(alpha: .08), borderRadius: BorderRadius.circular(4)),
          child: Text(event.type, style: const TextStyle(fontFamily: 'Consolas', fontSize: 11, color: brandBlue)),
        ),
        const SizedBox(width: 10),
        Expanded(child: Text(summary.toString(), overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: ink))),
      ]),
    );
  }

  String _clock(String iso) {
    final t = DateTime.tryParse(iso);
    if (t == null) return '';
    final l = t.toLocal();
    return '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}:${l.second.toString().padLeft(2, '0')}';
  }

  List<Widget> _actions(RunSnapshot r) {
    final terminal = r.status == 'succeeded' || r.status == 'failed' || r.status == 'cancelled';
    final merged = integration != null &&
        integration!['data'] is Map &&
        (integration!['data'] as Map)['status'] == 'merged';
    final list = <Widget>[];
    if (!terminal && r.status != 'created' && !r.paused) {
      list.add(TextButton(onPressed: () => _action('pause'), child: const Text('暂停', style: TextStyle(color: Color(0xFFD97706)))));
    }
    if (r.paused) {
      list.add(TextButton(onPressed: () => _action('resume'), child: const Text('继续', style: TextStyle(color: Color(0xFF159A70)))));
    }
    if (r.status == 'failed' || r.status == 'cancelled') {
      list.add(TextButton(onPressed: () => _action('retry'), child: const Text('重试 Run', style: TextStyle(color: brandBlue))));
    }
    if (r.status == 'succeeded' || r.status == 'failed') {
      list.add(TextButton(onPressed: _integrate, child: const Text('集成', style: TextStyle(color: Color(0xFF8B5CF6)))));
      list.add(TextButton(onPressed: _review, child: const Text('审查', style: TextStyle(color: Color(0xFF0891B2)))));
    }
    if (merged) {
      list.add(TextButton(onPressed: _merge, child: const Text('合并到 main', style: TextStyle(color: Color(0xFF159A70)))));
    }
    if (!terminal && r.status != 'created') {
      list.add(TextButton(onPressed: () => _action('cancel'), child: const Text('取消 Run', style: TextStyle(color: Color(0xFFD94B3D)))));
    }
    return list;
  }

  Widget _taskRow(RunTask task) {
    final expanded = expandedTasks.contains(task.taskId);
    return InkWell(
      onTap: task.result != null
          ? () => setState(() {
                if (expanded) {
                  expandedTasks.remove(task.taskId);
                } else {
                  expandedTasks.add(task.taskId);
                }
              })
          : null,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: line))),
        child: Row(children: [
          SizedBox(width: 150, child: Text(task.taskId, overflow: TextOverflow.ellipsis, style: const TextStyle(fontFamily: 'Consolas', fontSize: 12, color: muted))),
          SizedBox(width: 90, child: Text(task.role, style: const TextStyle(fontSize: 13))),
          _statusChip(task.status),
          const SizedBox(width: 12),
          Expanded(child: Text(task.error ?? task.title, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: ink))),
          if (task.result != null)
            Text(expanded ? '收起' : '结果', style: const TextStyle(fontSize: 12, color: brandBlue, fontWeight: FontWeight.w600)),
        ]),
      ),
    );
  }

  Widget _taskResult(Map<String, dynamic> result) {
    final output = result['output']?.toString();
    final changedFiles = ((result['changedFiles'] as List?) ?? []).cast<String>();
    final tests = ((result['tests'] as List?) ?? []);
    final risks = ((result['risks'] as List?) ?? []).cast<String>();
    final usage = result['usage'] as Map?;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F9FC),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: line),
      ),
      margin: const EdgeInsets.only(bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (changedFiles.isNotEmpty) ...[
          const Text('修改文件', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          for (final f in changedFiles)
            Text('• $f', style: const TextStyle(fontFamily: 'Consolas', fontSize: 11, color: muted)),
          const SizedBox(height: 8),
        ],
        if (tests.isNotEmpty) ...[
          const Text('测试', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          for (final t in tests)
            Row(children: [
              Text((t as Map)['passed'] == true ? '✓' : '✗',
                  style: TextStyle(color: t['passed'] == true ? const Color(0xFF159A70) : const Color(0xFFD94B3D), fontSize: 12)),
              const SizedBox(width: 6),
              Expanded(child: Text(t['command']?.toString() ?? '', overflow: TextOverflow.ellipsis, style: const TextStyle(fontFamily: 'Consolas', fontSize: 11, color: muted))),
            ]),
          const SizedBox(height: 8),
        ],
        if (risks.isNotEmpty) ...[
          const Text('风险', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          for (final r in risks) Text('⚠ $r', style: const TextStyle(fontSize: 11, color: Color(0xFFD97706))),
          const SizedBox(height: 8),
        ],
        if (usage != null) ...[
          const Text('用量', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          Text('tokens: ${usage['totalTokens']}   成本: \$${usage['costUsd']}',
              style: const TextStyle(fontFamily: 'Consolas', fontSize: 11, color: muted)),
          const SizedBox(height: 8),
        ],
        if (output != null && output.isNotEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(6), border: Border.all(color: line)),
            child: Text(output, style: const TextStyle(fontFamily: 'Consolas', fontSize: 11, height: 1.5, color: ink)),
          ),
      ]),
    );
  }

  Widget _statusChip(String status) {
    final color = switch (status) {
      'succeeded' => const Color(0xFF159A70),
      'failed' => const Color(0xFFD94B3D),
      'running' || 'planning' => const Color(0xFF3B82F6),
      'paused' || 'cancelled' || 'pending' => const Color(0xFF94A3B8),
      _ => const Color(0xFF94A3B8),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: .1), border: Border.all(color: color.withValues(alpha: .4)), borderRadius: BorderRadius.circular(999)),
      child: Text(status, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
    );
  }

  Widget _card(Widget child) => Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: line),
          borderRadius: BorderRadius.circular(12)),
      child: child);

  /// 任务 DAG 可视化：按依赖层级分列，CustomPaint 画节点与连线。
  Widget _dagView(Map<String, dynamic> dag) {
    final tasks = ((dag['tasks'] as List?) ?? [])
        .map((e) => e as Map<String, dynamic>)
        .toList();
    if (tasks.isEmpty) {
      return const Text('无 DAG 数据', style: TextStyle(fontSize: 13, color: muted));
    }
    final idOf = (Map<String, dynamic> t) => t['id']?.toString() ?? '';
    final depOf = (Map<String, dynamic> t) =>
        ((t['dependsOn'] as List?) ?? []).cast<String>();
    // 计算每层
    final levelOf = <String, int>{};
    int level(String id) {
      if (levelOf.containsKey(id)) return levelOf[id]!;
      final t = tasks.firstWhere((e) => idOf(e) == id, orElse: () => {});
      final deps = depOf(t);
      final l = deps.isEmpty
          ? 0
          : deps.map((d) => level(d) + 1).reduce((a, b) => a > b ? a : b);
      levelOf[id] = l;
      return l;
    }

    final nodes = <Map<String, dynamic>>[];
    for (final t in tasks) {
      nodes.add({'task': t, 'level': level(idOf(t))});
    }
    final maxLevel = nodes.isEmpty
        ? 0
        : nodes.map((n) => n['level'] as int).reduce((a, b) => a > b ? a : b);
    const colW = 180.0, rowH = 60.0;
    final width = 60.0 + (maxLevel + 1) * colW;
    final height = 40.0 + nodes.length * rowH;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('任务 DAG', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
      const SizedBox(height: 12),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SizedBox(
          width: width,
          height: height,
          child: CustomPaint(
            painter: _DagPainter(nodes: nodes, idOf: idOf, depOf: depOf, statusOf: (id) {
              for (final t in run?.tasks ?? <RunTask>[]) {
                if (t.taskId == id) return t.status;
              }
              return 'pending';
            }),
          ),
        ),
      ),
    ]);
  }

  Map<String, dynamic>? _dataOf(Map<String, dynamic>? holder) =>
      holder?['data'] is Map ? holder!['data'] as Map<String, dynamic> : null;

  Widget _integrationView() {
    final d = _dataOf(integration);
    if (d == null) {
      return Text('集成失败：${Api.errorMessage(integration?['data'], '请求失败')}',
          style: const TextStyle(color: Color(0xFFD94B3D), fontSize: 13));
    }
    final status = d['status']?.toString() ?? '';
    final applied = (d['appliedTasks'] as List?) ?? [];
    final conflicts = (d['conflicts'] as List?) ?? [];
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('集成结果', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
      Row(children: [
        _statusChip(status == 'merged' ? 'succeeded' : (status == 'conflict' ? 'failed' : 'cancelled')),
        const SizedBox(width: 10),
        Expanded(child: Text(d['message']?.toString() ?? '', style: const TextStyle(fontSize: 12, color: muted))),
      ]),
      if (d['branch'] != null) ...[
        const SizedBox(height: 8),
        Text('分支：${d['branch']}', style: const TextStyle(fontSize: 12, color: muted)),
      ],
      if (applied.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text('已集成任务：${applied.join(', ')}', style: const TextStyle(fontSize: 12, color: muted)),
      ],
      if (conflicts.isNotEmpty) ...[
        const SizedBox(height: 8),
        for (final c in conflicts)
          Text('⚠ ${(c as Map)['taskId']}：${c['detail']}',
              style: const TextStyle(fontSize: 12, color: Color(0xFFD97706))),
      ],
    ]);
  }

  Widget _reviewView() {
    final d = _dataOf(review);
    if (d == null) {
      return Text('审查失败：${Api.errorMessage(review?['data'], '请求失败')}',
          style: const TextStyle(color: Color(0xFFD94B3D), fontSize: 13));
    }
    final status = d['status']?.toString() ?? '';
    if (status == 'review_failed') {
      final reason = (d['reason'] as Map?)?['message']?.toString() ?? '未知错误';
      return Text('审查失败：$reason', style: const TextStyle(color: Color(0xFFD94B3D), fontSize: 13));
    }
    final report = (d['report'] as Map?) ?? {};
    final findings = (report['findings'] as List?) ?? [];
    final recommendations = (report['recommendations'] as List?) ?? [];
    final risks = (report['risks'] as List?) ?? [];
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('代码审查结果', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
      if (findings.isNotEmpty) ...[
        Text('问题（${findings.length}）', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
        for (final f in findings) Text('• $f', style: const TextStyle(fontSize: 12, height: 1.6)),
        const SizedBox(height: 8),
      ],
      if (recommendations.isNotEmpty) ...[
        Text('建议', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
        for (final r in recommendations) Text('→ $r', style: const TextStyle(fontSize: 12, height: 1.6)),
        const SizedBox(height: 8),
      ],
      if (risks.isNotEmpty) ...[
        Text('风险', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
        for (final r in risks) Text('⚠ $r', style: const TextStyle(fontSize: 12, color: Color(0xFFD97706))),
      ],
    ]);
  }

  Widget _mergeView() {
    final d = _dataOf(merge);
    if (d == null) {
      return Text('合并失败：${Api.errorMessage(merge?['data'], '请求失败')}',
          style: const TextStyle(color: Color(0xFFD94B3D), fontSize: 13));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('合并结果', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
      Row(children: [
        _statusChip(d['status'] == 'merged' ? 'succeeded' : 'failed'),
        const SizedBox(width: 10),
        Expanded(child: Text(d['message']?.toString() ?? '', style: const TextStyle(fontSize: 12, color: muted))),
      ]),
    ]);
  }

  String _time(String iso) {
    final t = DateTime.tryParse(iso);
    if (t == null) return iso;
    return t.toLocal().toString().substring(0, 19);
  }
}

/// DAG 绘制器：按层绘制节点矩形 + 依赖连线（带箭头）。
class _DagPainter extends CustomPainter {
  final List<Map<String, dynamic>> nodes;
  final String Function(Map<String, dynamic>) idOf;
  final List<String> Function(Map<String, dynamic>) depOf;
  final String Function(String) statusOf;
  static const colW = 180.0, rowH = 60.0, boxW = 130.0, boxH = 44.0;

  _DagPainter({
    required this.nodes,
    required this.idOf,
    required this.depOf,
    required this.statusOf,
  });

  Color _statusColor(String status) => switch (status) {
        'succeeded' => const Color(0xFF159A70),
        'failed' => const Color(0xFFD94B3D),
        'running' || 'planning' => const Color(0xFF3B82F6),
        _ => const Color(0xFF94A3B8),
      };

  @override
  void paint(Canvas canvas, Size size) {
    final byId = {for (final n in nodes) idOf(n['task'] as Map<String, dynamic>): n};
    final linePaint = Paint()
      ..color = const Color(0xFFC5D0DE)
      ..strokeWidth = 1.5;

    // 连线
    for (final n in nodes) {
      final task = n['task'] as Map<String, dynamic>;
      final level = n['level'] as int;
      final index = nodes.indexOf(n);
      final x = 30.0 + level * colW + boxW;
      final y = 20.0 + index * rowH + boxH / 2;
      for (final dep in depOf(task)) {
        final depNode = byId[dep];
        if (depNode == null) continue;
        final dLevel = depNode['level'] as int;
        final dIndex = nodes.indexOf(depNode);
        final dx = 30.0 + dLevel * colW + boxW;
        final dy = 20.0 + dIndex * rowH + boxH / 2;
        canvas.drawLine(Offset(dx, dy), Offset(x, y), linePaint);
        // 箭头
        final arrow = Paint()..color = const Color(0xFFC5D0DE);
        final path = Path()
          ..moveTo(x - 8, y - 4)
          ..lineTo(x, y)
          ..lineTo(x - 8, y + 4)
          ..close();
        canvas.drawPath(path, arrow);
      }
    }

    // 节点
    for (final n in nodes) {
      final task = n['task'] as Map<String, dynamic>;
      final level = n['level'] as int;
      final index = nodes.indexOf(n);
      final x = 30.0 + level * colW;
      final y = 20.0 + index * rowH;
      final color = _statusColor(statusOf(idOf(task)));
      final rect = RRect.fromRectAndRadius(
        Rect.fromLTWH(x, y, boxW, boxH),
        const Radius.circular(8),
      );
      canvas.drawRRect(rect, Paint()..color = const Color(0xFFF0F3F8));
      canvas.drawRRect(rect, Paint()..color = color..style = PaintingStyle.stroke..strokeWidth = 1.5);
      final tp = TextPainter(
        text: TextSpan(
          text: task['role']?.toString() ?? '',
          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Color(0xFF172033)),
        ),
        textDirection: TextDirection.ltr,
      )..layout(maxWidth: boxW - 12);
      tp.paint(canvas, Offset(x + (boxW - tp.width) / 2, y + 5));
      final idp = TextPainter(
        text: TextSpan(
          text: idOf(task),
          style: const TextStyle(fontSize: 9, color: Color(0xFF718096)),
        ),
        textDirection: TextDirection.ltr,
      )..layout(maxWidth: boxW - 12);
      idp.paint(canvas, Offset(x + (boxW - idp.width) / 2, y + 23));
    }
  }

  @override
  bool shouldRepaint(covariant _DagPainter oldDelegate) => true;
}
