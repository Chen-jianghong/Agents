import 'dart:async';
import 'package:flutter/material.dart';
import '../api.dart';

const accent = Color(0xFFE35B24);
const line = Color(0xFFDCE3EC);
const muted = Color(0xFF718096);
const ink = Color(0xFF172033);

/// 开发任务页：提交需求 → 创建并启动 Run，列表实时轮询。
class RunsView extends StatefulWidget {
  final Api api;
  final void Function(String runId) onOpenRun;
  const RunsView({super.key, required this.api, required this.onOpenRun});

  @override
  State<RunsView> createState() => _RunsViewState();
}

class _RunsViewState extends State<RunsView> {
  final goal = TextEditingController();
  final maxParallel = TextEditingController(text: '2');
  List<RunSnapshot> runs = [];
  String? message;
  bool ok = false;
  bool submitting = false;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    _refresh();
    timer = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
  }

  @override
  void dispose() {
    timer?.cancel();
    goal.dispose();
    maxParallel.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final list = await widget.api.listRuns();
    if (mounted) setState(() => runs = list);
  }

  Future<void> _submit() async {
    final text = goal.text.trim();
    if (text.isEmpty) {
      setState(() {
        message = '请输入开发需求';
        ok = false;
      });
      return;
    }
    setState(() {
      submitting = true;
      message = null;
    });
    try {
      final parallel = int.tryParse(maxParallel.text.trim()) ?? 2;
      final run = await widget.api.createRun(text, parallel);
      await widget.api.startRun(run.runId);
      goal.clear();
      widget.onOpenRun(run.runId);
      await _refresh();
    } catch (e) {
      setState(() {
        message = e.toString();
        ok = false;
      });
    } finally {
      if (mounted) setState(() => submitting = false);
    }
  }

  Future<void> _cancel(String runId) async {
    await widget.api.runAction(runId, 'cancel');
    await _refresh();
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(28), children: [
        const Text('开发任务', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
        const SizedBox(height: 18),
        _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('提交开发需求', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          TextField(
            controller: goal,
            maxLines: 4,
            minLines: 3,
            decoration: const InputDecoration(
              hintText: '用自然语言描述需求，例如：为后台增加团队成员管理功能，包含成员列表、新增、删除，并补充测试',
              filled: true,
              fillColor: Colors.white,
              border: OutlineInputBorder(borderSide: BorderSide(color: line)),
            ),
          ),
          const SizedBox(height: 12),
          Row(children: [
            const Text('最大并行数', style: TextStyle(fontSize: 13, color: muted)),
            const SizedBox(width: 8),
            SizedBox(width: 72, child: TextField(controller: maxParallel, keyboardType: TextInputType.number, decoration: const InputDecoration(filled: true, fillColor: Colors.white, isDense: true, border: OutlineInputBorder(borderSide: BorderSide(color: line))))),
            const Spacer(),
            FilledButton(onPressed: submitting ? null : _submit, style: FilledButton.styleFrom(backgroundColor: accent), child: Text(submitting ? '提交中...' : '创建并启动 Run')),
          ]),
          if (message != null) ...[
            const SizedBox(height: 10),
            Text(message!, style: TextStyle(color: ok ? const Color(0xFF159A70) : const Color(0xFFD94B3D), fontSize: 13)),
          ],
        ])),
        const SizedBox(height: 18),
        _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Run 列表', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          if (runs.isEmpty)
            const Text('还没有 Run，先在上方提交一个需求。', style: TextStyle(fontSize: 13, color: muted))
          else
            for (final run in runs) _runRow(run),
        ])),
      ]);

  Widget _card(Widget child) => Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: Colors.white, border: Border.all(color: line), borderRadius: BorderRadius.circular(12)),
      child: child);

  Widget _runRow(RunSnapshot run) {
    final terminal = run.status == 'succeeded' ||
        run.status == 'failed' ||
        run.status == 'cancelled';
    return InkWell(
      onTap: () => widget.onOpenRun(run.runId),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: line))),
        child: Row(children: [
          Expanded(flex: 2, child: Text(run.goal, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
          Expanded(child: _statusChip(run.paused ? 'paused' : run.status)),
          SizedBox(width: 80, child: Text('${run.maxParallel}', textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, color: muted))),
          SizedBox(width: 90, child: Text(_shortTime(run.updatedAt), textAlign: TextAlign.right, style: const TextStyle(fontSize: 11, color: muted, fontFamily: 'Consolas'))),
          if (!terminal && run.status != 'created')
            TextButton(onPressed: () => _cancel(run.runId), child: const Text('取消', style: TextStyle(color: Color(0xFFD94B3D), fontSize: 12)))
          else
            const SizedBox(width: 56),
        ]),
      ),
    );
  }

  Widget _statusChip(String status) {
    final color = switch (status) {
      'succeeded' => const Color(0xFF159A70),
      'failed' => const Color(0xFFD94B3D),
      'running' || 'planning' => const Color(0xFF3B82F6),
      'paused' || 'cancelled' => const Color(0xFF94A3B8),
      _ => const Color(0xFF94A3B8),
    };
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(color: color.withValues(alpha: .1), border: Border.all(color: color.withValues(alpha: .4)), borderRadius: BorderRadius.circular(999)),
        child: Text(status, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
      ),
    );
  }

  String _shortTime(String iso) {
    final t = DateTime.tryParse(iso);
    if (t == null) return iso;
    final l = t.toLocal();
    return '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}:${l.second.toString().padLeft(2, '0')}';
  }
}
