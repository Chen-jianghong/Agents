import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'api.dart';
import 'views/runs_view.dart';
import 'views/run_detail_view.dart';
import 'views/vendors_view.dart';

const brandBlue = Color(0xFF1769D1);
const accent = Color(0xFFE35B24);
const canvas = Color(0xFFF7F9FC);
const side = Color(0xFFF0F4F9);
const line = Color(0xFFDCE3EC);
const ink = Color(0xFF172033);
const muted = Color(0xFF718096);

void main() => runApp(const ReasonixApp());

class ReasonixApp extends StatelessWidget {
  const ReasonixApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'ZaoHua Code - AI 多智能体开发',
        theme: ThemeData(
            useMaterial3: true,
            fontFamily: 'Segoe UI',
            scaffoldBackgroundColor: canvas,
            colorScheme: ColorScheme.fromSeed(seedColor: brandBlue)),
        home: const WorkbenchPage(),
      );
}

class WorkbenchPage extends StatefulWidget {
  const WorkbenchPage({super.key});
  @override
  State<WorkbenchPage> createState() => _WorkbenchPageState();
}

class _WorkbenchPageState extends State<WorkbenchPage> {
  final api = Api();
  String active = '欢迎会话';
  String view = 'chat'; // chat | runs | run-detail | vendors
  String? runId;
  bool connected = false;
  bool engineStarting = false;
  Process? engineProcess;
  Timer? healthTimer;
  final input = TextEditingController();
  final messages = <ChatMessage>[
    ChatMessage(false, '你好！我是 ZaoHua Code，你的 AI 多智能体开发工作台。\n\n在左侧「开发任务」中提交需求，多个 Agent 会并行拆解并执行；在「供应商管理」中配置模型 API。'),
  ];

  @override
  void initState() {
    super.initState();
    _checkHealth();
    healthTimer = Timer.periodic(const Duration(seconds: 4), (_) => _checkHealth());
  }

  @override
  void dispose() {
    healthTimer?.cancel();
    input.dispose();
    super.dispose();
  }

  Future<void> _checkHealth() async {
    final ok = await api.health();
    if (mounted) setState(() => connected = ok);
  }

  /// 启动本地引擎：优先使用安装目录捆绑的 node + backend，回退到开发模式。
  Future<void> _startEngine() async {
    setState(() => engineStarting = true);
    try {
      final exeDir = File(Platform.resolvedExecutable).parent.path;
      final sep = Platform.pathSeparator;
      final bundledNode = '$exeDir${sep}resources${sep}node.exe';
      final bundledBackend = '$exeDir${sep}resources${sep}backend.mjs';
      final useBundled =
          File(bundledNode).existsSync() && File(bundledBackend).existsSync();
      final node = useBundled ? bundledNode : 'node';
      final script = useBundled ? bundledBackend : 'examples/dev-server.mjs';
      // 数据目录固定放在 LOCALAPPDATA，保证安装后始终可写。
      final dataDir =
          '${Platform.environment['LOCALAPPDATA'] ?? exeDir}${sep}ZaoHua Code${sep}data';
      engineProcess = await Process.start(
        node,
        [script, '--port', '8787', '--data', dataDir],
        workingDirectory: useBundled ? exeDir : Directory.current.path,
      );
      engineProcess!.stdout.transform(SystemEncoding().decoder).listen((_) {});
      engineProcess!.stderr.transform(SystemEncoding().decoder).listen((_) {});
      for (var i = 0; i < 30; i++) {
        await Future.delayed(const Duration(milliseconds: 500));
        if (await api.health()) break;
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('启动本地引擎失败：$e\n请先手动运行 npm run dev-server')));
      }
    } finally {
      if (mounted) setState(() => engineStarting = false);
    }
  }

  void send() {
    final text = input.text.trim();
    if (text.isEmpty) return;
    setState(() {
      messages.add(ChatMessage(true, text));
      input.clear();
    });
  }

  void _go(String target, {String? id}) {
    setState(() {
      view = target;
      runId = id;
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Row(children: [
          Sidebar(
            selected: view,
            onSelect: (v) => _go(v),
            active: active,
            onSelectSession: (s) {
              setState(() => active = s);
              _go('chat');
            },
          ),
          Expanded(
              child: Column(children: [
            Topbar(connected: connected, onStartEngine: _startEngine, engineStarting: engineStarting),
            Expanded(
                child: Row(children: [
              Expanded(child: _body()),
              if (view == 'chat') Inspector(api: api),
            ])),
            const StatusBar()
          ]))
        ]),
      );

  Widget _body() {
    switch (view) {
      case 'runs':
        return RunsView(api: api, onOpenRun: (id) => _go('run-detail', id: id));
      case 'run-detail':
        return RunDetailView(api: api, runId: runId ?? '', onBack: () => _go('runs'));
      case 'vendors':
        return VendorsView(api: api);
      default:
        return _conversation();
    }
  }

  Widget _conversation() => Column(children: [
        Expanded(
            child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(44, 28, 44, 20),
                itemCount: messages.length,
                itemBuilder: (_, i) => MessageBubble(message: messages[i]))),
        Composer(controller: input, onSend: send)
      ]);
}

class ChatMessage {
  final bool mine;
  final String text;
  ChatMessage(this.mine, this.text);
}

class Sidebar extends StatelessWidget {
  final String selected;
  final ValueChanged<String> onSelect;
  final String active;
  final ValueChanged<String> onSelectSession;
  const Sidebar(
      {super.key,
      required this.selected,
      required this.onSelect,
      required this.active,
      required this.onSelectSession});

  @override
  Widget build(BuildContext context) => Container(
      width: 282,
      color: side,
      padding: const EdgeInsets.fromLTRB(12, 22, 12, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Padding(
            padding: EdgeInsets.symmetric(horizontal: 14),
            child: Text('ZaoHua Code',
                style: TextStyle(
                    color: brandBlue,
                    fontSize: 17,
                    fontWeight: FontWeight.w800))),
        const SizedBox(height: 22),
        TextButton.icon(
            onPressed: () => onSelectSession('欢迎会话'),
            icon: const Icon(Icons.add_box_outlined, size: 18),
            label: const Text('新建会话'),
            style: TextButton.styleFrom(
                foregroundColor: muted,
                padding: const EdgeInsets.symmetric(horizontal: 14))),
        const SizedBox(height: 18),
        const Padding(
            padding: EdgeInsets.symmetric(horizontal: 10),
            child: Text('工作台', style: TextStyle(color: muted, fontSize: 12))),
        _nav('▱  开发任务', 'runs'),
        _nav('▱  供应商管理', 'vendors'),
        const Padding(
            padding: EdgeInsets.fromLTRB(10, 20, 8, 8),
            child: Text('当前项目 · Ai-多智能体开发',
                style: TextStyle(color: muted, fontSize: 13))),
        _session('欢迎会话', '', true),
        _session('开发任务', '最近', false),
        const Spacer(),
        const Divider(color: line),
        const ListTile(
            contentPadding: EdgeInsets.symmetric(horizontal: 8),
            leading: CircleAvatar(
                backgroundColor: brandBlue,
                child: Text('本',
                    style: TextStyle(color: Colors.white))),
            title: Text('本地工作区',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            subtitle:
                Text('owner', style: TextStyle(fontSize: 11, color: muted))),
      ]));

  Widget _nav(String text, String key) {
    final activeNav = selected == key || (key == 'runs' && selected == 'run-detail');
    return TextButton(
        onPressed: () => onSelect(key),
        style: TextButton.styleFrom(
            alignment: Alignment.centerLeft,
            foregroundColor: activeNav ? ink : muted,
            backgroundColor: activeNav ? const Color(0xFFE7EDF6) : Colors.transparent,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9)),
        child: Text(text,
            style: TextStyle(fontWeight: activeNav ? FontWeight.w600 : FontWeight.normal)));
  }

  Widget _session(String title, String time, bool selectedSession) => Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 2),
      decoration: BoxDecoration(
          color: selectedSession ? const Color(0xFFEADBD7) : Colors.transparent,
          borderRadius: BorderRadius.circular(6)),
      child: ListTile(
          dense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 30),
          onTap: () => onSelectSession(title),
          title: Text(title,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: 13,
                  fontWeight:
                      selectedSession ? FontWeight.w600 : FontWeight.normal)),
          trailing: Text(time,
              style: const TextStyle(fontSize: 11, color: muted))));
}

class Topbar extends StatelessWidget {
  final bool connected;
  final VoidCallback onStartEngine;
  final bool engineStarting;
  const Topbar(
      {super.key,
      required this.connected,
      required this.onStartEngine,
      required this.engineStarting});

  @override
  Widget build(BuildContext context) => Container(
      height: 57,
      padding: const EdgeInsets.symmetric(horizontal: 22),
      decoration: const BoxDecoration(
          color: Colors.white,
          border: Border(bottom: BorderSide(color: line))),
      child: Row(children: [
        const Icon(Icons.view_sidebar_outlined, size: 18, color: muted),
        const SizedBox(width: 16),
        const Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('ZaoHua Code',
                  style:
                      TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
              Text('AI 多智能体开发',
                  style: TextStyle(color: muted, fontSize: 11))
            ]),
        const SizedBox(width: 8),
        const Icon(Icons.edit_outlined, size: 16, color: muted),
        const Spacer(),
        if (!connected)
          TextButton.icon(
              onPressed: engineStarting ? null : onStartEngine,
              icon: const Icon(Icons.power_settings_new, size: 15),
              label: Text(engineStarting ? '引擎启动中...' : '启动本地引擎'),
              style: TextButton.styleFrom(foregroundColor: accent))
        else
          Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                  color: const Color(0xFF159A70).withValues(alpha: .1),
                  borderRadius: BorderRadius.circular(999)),
              child: const Text('● 引擎已连接',
                  style:
                      TextStyle(color: Color(0xFF159A70), fontSize: 11))),
        ...[Icons.view_agenda_outlined, Icons.copy_outlined, Icons.download_outlined]
            .map((i) => IconButton(
                onPressed: () {},
                icon: Icon(i, size: 17, color: muted))),
        Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
                border: Border.all(color: line),
                borderRadius: BorderRadius.circular(8)),
            child: const Text('主模型　⌄', style: TextStyle(fontSize: 12))),
        IconButton(
            onPressed: () {},
            icon: const Icon(Icons.help_outline, size: 17, color: muted)),
        const SizedBox(width: 4),
      ]));
}

class MessageBubble extends StatelessWidget {
  final ChatMessage message;
  const MessageBubble({super.key, required this.message});
  @override
  Widget build(BuildContext context) => Align(
      alignment: message.mine
          ? Alignment.centerRight
          : Alignment.centerLeft,
      child: Container(
          constraints: const BoxConstraints(maxWidth: 720),
          margin: const EdgeInsets.only(bottom: 22),
          padding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          decoration: BoxDecoration(
              color: message.mine
                  ? const Color(0xFFFFF8F5)
                  : Colors.transparent,
              border: message.mine
                  ? Border.all(color: const Color(0xFFF0CDBE))
                  : null,
              borderRadius: BorderRadius.circular(10)),
          child: SelectableText(message.text,
              style: const TextStyle(fontSize: 14, height: 1.7, color: ink))));
}

class Composer extends StatelessWidget {
  final TextEditingController controller;
  final VoidCallback onSend;
  const Composer(
      {super.key, required this.controller, required this.onSend});
  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(18, 0, 18, 14),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: const Color(0xFFF0B79E), width: 1.5),
          borderRadius: BorderRadius.circular(13),
          boxShadow: const [
            BoxShadow(color: Color(0x18000000), blurRadius: 10)
          ]),
      child: Column(children: [
        Row(children: [
          const Icon(Icons.add, color: muted),
          const SizedBox(width: 8),
          Expanded(
              child: TextField(
                  controller: controller,
                  onSubmitted: (_) => onSend(),
                  maxLines: 3,
                  minLines: 1,
                  decoration: const InputDecoration(
                      hintText: '给 ZaoHua Code 发消息…（/ 命令 · @ 文件 · ! 终端）',
                      border: InputBorder.none,
                      hintStyle: TextStyle(color: muted, fontSize: 13)))),
          FloatingActionButton.small(
              onPressed: onSend,
              backgroundColor: accent,
              foregroundColor: Colors.white,
              child: const Icon(Icons.arrow_upward)),
        ]),
        const Divider(color: line),
        Row(children: [
          const Chip(label: Text('→ 常规', style: TextStyle(fontSize: 11))),
          const SizedBox(width: 6),
          const Chip(label: Text('◌ 轻量', style: TextStyle(fontSize: 11))),
          const Spacer(),
          const Text('模型由供应商配置决定',
              style: TextStyle(color: muted, fontSize: 12))
        ]),
      ]),
    );
  }
}

class Inspector extends StatefulWidget {
  final Api api;
  const Inspector({super.key, required this.api});
  @override
  State<Inspector> createState() => _InspectorState();
}

class _InspectorState extends State<Inspector> {
  int providerCount = 0;
  int runCount = 0;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    _load();
    timer = Timer.periodic(const Duration(seconds: 5), (_) => _load());
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final providers = await widget.api.listProviders();
      final runs = await widget.api.listRuns();
      if (mounted) {
        setState(() {
          providerCount = providers.length;
          runCount = runs.length;
        });
      }
    } catch (_) {
      // 引擎未启动时静默忽略，保留上一次数据。
    }
  }

  @override
  Widget build(BuildContext context) => Container(
      width: 330,
      color: Colors.white,
      padding: const EdgeInsets.all(10),
      child: ListView(children: [
        const SizedBox(height: 8),
        const Text('工作区概览',
            style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
        const Divider(color: line),
        _panel('本地引擎',
            _engine()),
        _panel('当前项目', _project()),
        _panel('用量与配置', _usage()),
      ]));

  Widget _engine() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: const Color(0xFFF0F3F8),
          borderRadius: BorderRadius.circular(8)),
      child: Row(children: [
        Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
                color: widget.api.probed
                    ? const Color(0xFF159A70)
                    : const Color(0xFF94A3B8),
                shape: BoxShape.circle)),
        const SizedBox(width: 10),
        Text(widget.api.probed ? '引擎已连接' : '引擎未连接',
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        const Spacer(),
        Text('${Api.defaultBase}',
            style: const TextStyle(fontSize: 10, color: muted)),
      ]),
    );
  }

  Widget _project() => Wrap(children: [
        Metric('已配置供应商', '$providerCount'),
        Metric('开发任务（Run）', '$runCount'),
        Metric('工作区', 'D:/Ai-多智能体开发'),
        Metric('分支', 'main'),
      ]);

  Widget _usage() => Column(children: [
        Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
                color: const Color(0xFFF0F3F8),
                borderRadius: BorderRadius.circular(8)),
            child: const Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('供应商', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                  SizedBox(height: 8),
                  Text('在「供应商管理」中添加模型 API 后，即可提交开发任务。', style: TextStyle(color: muted, fontSize: 11, height: 1.5)),
                ])),
      ]);

  Widget _panel(String title, Widget child) => Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
          border: Border.all(color: line),
          borderRadius: BorderRadius.circular(10)),
      child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title,
                style: const TextStyle(
                    fontWeight: FontWeight.w700, fontSize: 14)),
            const SizedBox(height: 10),
            child
          ]));
}

class Metric extends StatelessWidget {
  final String title, value;
  final bool accent;
  const Metric(this.title, this.value, [this.accent = false]);
  @override
  Widget build(BuildContext context) => SizedBox(
      width: 145,
      child: Padding(
          padding: const EdgeInsets.all(8),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: const TextStyle(fontSize: 11, color: muted)),
                Text(value,
                    style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: accent
                            ? const Color(0xFFD56500)
                            : ink))
              ])));
}

class StatusBar extends StatelessWidget {
  const StatusBar({super.key});
  @override
  Widget build(BuildContext context) => Container(
      height: 28,
      padding: const EdgeInsets.symmetric(horizontal: 15),
      decoration: const BoxDecoration(
          color: Colors.white,
          border: Border(top: BorderSide(color: line))),
      child: const Row(children: [
        Text('⌂  D:/Ai-多智能体开发',
            style: TextStyle(fontSize: 11, color: muted)),
        SizedBox(width: 18),
        Text('⌁ main',
            style: TextStyle(
                fontSize: 11,
                color: brandBlue,
                fontWeight: FontWeight.bold)),
        SizedBox(width: 18),
        Text('ZaoHua Code 多智能体开发工作台 v0.1.0',
            style: TextStyle(fontSize: 11, color: muted)),
        Spacer(),
        Text('● 本地引擎',
            style: TextStyle(fontSize: 11, color: Colors.green))
      ]));
}
