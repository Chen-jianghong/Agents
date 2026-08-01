import 'package:flutter/material.dart';
import '../api.dart';

const accent = Color(0xFFE35B24);
const line = Color(0xFFDCE3EC);
const muted = Color(0xFF718096);

/// 供应商管理页：添加供应商（Provider + Model Profile），列出已配置项。
class VendorsView extends StatefulWidget {
  final Api api;
  const VendorsView({super.key, required this.api});

  @override
  State<VendorsView> createState() => _VendorsViewState();
}

class _VendorsViewState extends State<VendorsView> {
  final name = TextEditingController();
  final baseUrl = TextEditingController();
  final apiKey = TextEditingController();
  final modelName = TextEditingController();
  final contextWindow = TextEditingController();
  List<ProviderConfig> providers = [];
  String? message;
  bool ok = false;
  bool submitting = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    name.dispose();
    baseUrl.dispose();
    apiKey.dispose();
    modelName.dispose();
    contextWindow.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final list = await widget.api.listProviders();
    if (mounted) setState(() => providers = list);
  }

  Future<void> _submit() async {
    if (name.text.trim().isEmpty || modelName.text.trim().isEmpty) {
      setState(() {
        message = '供应商名称和模型名称不能为空';
        ok = false;
      });
      return;
    }
    setState(() {
      submitting = true;
      message = null;
    });
    final input = <String, dynamic>{
      'name': name.text.trim(),
      'modelName': modelName.text.trim(),
    };
    if (baseUrl.text.trim().isNotEmpty) input['baseUrl'] = baseUrl.text.trim();
    if (apiKey.text.trim().isNotEmpty) input['apiKey'] = apiKey.text.trim();
    final ctx = int.tryParse(contextWindow.text.trim());
    if (ctx != null) input['contextWindow'] = ctx;
    final r = await widget.api.addVendor(input);
    setState(() {
      submitting = false;
      ok = r['status'] == 200;
      message = r['status'] == 200
          ? '添加成功（Provider + Model Profile 已创建）'
          : Api.errorMessage(r['data'], '添加失败');
    });
    if (ok) {
      name.clear();
      apiKey.clear();
      modelName.clear();
      contextWindow.clear();
      await _refresh();
    }
  }

  Future<void> _remove(String id) async {
    final r = await widget.api.removeProvider(id);
    if (r['status'] == 200) {
      setState(() {
        message = '已删除 $id';
        ok = true;
      });
      await _refresh();
    }
  }

  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(28), children: [
        const Text('供应商管理', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
        const SizedBox(height: 18),
        _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('添加供应商', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 14),
          Wrap(spacing: 16, runSpacing: 14, children: [
            _field(name, '供应商名称 *', 200),
            _field(baseUrl, 'API 地址', 260),
            _field(apiKey, 'API Key', 260, obscure: true),
            _field(modelName, '模型名称 *', 220),
            _field(contextWindow, '上下文（tokens）', 160, number: true),
          ]),
          const SizedBox(height: 14),
          FilledButton(onPressed: submitting ? null : _submit, style: FilledButton.styleFrom(backgroundColor: accent), child: Text(submitting ? '添加中...' : '添加供应商')),
          if (message != null) ...[
            const SizedBox(height: 10),
            Text(message!, style: TextStyle(color: ok ? const Color(0xFF159A70) : const Color(0xFFD94B3D), fontSize: 13)),
          ],
        ])),
        const SizedBox(height: 18),
        _card(Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('已配置的供应商', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          if (providers.isEmpty)
            const Text('还没有供应商，先用上面的表单添加一个。', style: TextStyle(fontSize: 13, color: muted))
          else
            for (final p in providers)
              Container(
                padding: const EdgeInsets.symmetric(vertical: 10),
                decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: line))),
                child: Row(children: [
                  Expanded(flex: 2, child: Text(p.id, overflow: TextOverflow.ellipsis, style: const TextStyle(fontFamily: 'Consolas', fontSize: 12, color: muted))),
                  Expanded(flex: 2, child: Text(p.name, style: const TextStyle(fontSize: 13))),
                  Expanded(flex: 3, child: Text(p.baseUrl ?? '-', overflow: TextOverflow.ellipsis, style: const TextStyle(fontFamily: 'Consolas', fontSize: 12, color: muted))),
                  Expanded(flex: 2, child: Text(p.apiKeySecretRef ?? '-', overflow: TextOverflow.ellipsis, style: const TextStyle(fontFamily: 'Consolas', fontSize: 12, color: muted))),
                  TextButton(onPressed: () => _remove(p.id), child: const Text('删除', style: TextStyle(color: Color(0xFFD94B3D), fontSize: 12))),
                ]),
              ),
        ])),
      ]);

  Widget _field(TextEditingController controller, String label, double width, {bool obscure = false, bool number = false}) =>
      SizedBox(width: width, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(fontSize: 12, color: muted)),
        const SizedBox(height: 5),
        TextField(controller: controller, obscureText: obscure, keyboardType: number ? TextInputType.number : null, decoration: const InputDecoration(filled: true, fillColor: Colors.white, isDense: true, border: OutlineInputBorder(borderSide: BorderSide(color: line)))),
      ]));

  Widget _card(Widget child) => Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: Colors.white, border: Border.all(color: line), borderRadius: BorderRadius.circular(12)),
      child: child);
}
