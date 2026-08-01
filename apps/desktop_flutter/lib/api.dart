import 'dart:convert';
import 'package:http/http.dart' as http;

/// Reasonix 桌面端 API 客户端，连接本地 Node.js Runtime REST API。
class Api {
  static const defaultBase = 'http://127.0.0.1:8787';
  String base = defaultBase;
  bool _probeOk = false;
  bool get probed => _probeOk;

  Future<bool> health() async {
    try {
      final r = await http
          .get(Uri.parse('$base/api/health'))
          .timeout(const Duration(seconds: 2));
      _probeOk = r.statusCode == 200;
    } catch (_) {
      _probeOk = false;
    }
    return _probeOk;
  }

  Future<dynamic> _json(String path,
      {String method = 'GET', Map<String, dynamic>? body}) async {
    final uri = Uri.parse('$base$path');
    final request = http.Request(method, uri);
    request.headers['Content-Type'] = 'application/json';
    if (body != null) request.body = jsonEncode(body);
    final streamed = await request.send().timeout(const Duration(seconds: 30));
    final text = await streamed.stream.bytesToString();
    dynamic data;
    try {
      data = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      data = text;
    }
    return {'status': streamed.statusCode, 'data': data};
  }

  Future<List<RunSnapshot>> listRuns() async {
    final r = await _json('/api/runs');
    if (r['status'] != 200) return [];
    return (r['data'] as List).map((e) => RunSnapshot.fromJson(e)).toList();
  }

  Future<RunSnapshot> createRun(String goal, int maxParallel) async {
    final r = await _json('/api/runs',
        method: 'POST',
        body: {'goal': goal, 'maxParallel': maxParallel});
    if (r['status'] != 200) {
      throw ApiException(errorMessage(r['data'], '创建失败'));
    }
    return RunSnapshot.fromJson(r['data']);
  }

  Future<RunSnapshot> startRun(String runId) async {
    final r = await _json('/api/runs/${Uri.encodeComponent(runId)}/start',
        method: 'POST');
    if (r['status'] != 200) {
      throw ApiException(errorMessage(r['data'], '启动失败'));
    }
    return RunSnapshot.fromJson(r['data']);
  }

  Future<RunSnapshot> getRun(String runId) async {
    final r = await _json('/api/runs/${Uri.encodeComponent(runId)}');
    if (r['status'] != 200) {
      throw ApiException(errorMessage(r['data'], '加载失败'));
    }
    return RunSnapshot.fromJson(r['data']);
  }

  Future<void> runAction(String runId, String action) async {
    final r = await _json('/api/runs/${Uri.encodeComponent(runId)}/$action',
        method: 'POST');
    if (r['status'] != 200) {
      throw ApiException(errorMessage(r['data'], '$action 失败'));
    }
  }

  Future<Map<String, dynamic>> integrate(String runId) async {
    final r = await _json('/api/runs/${Uri.encodeComponent(runId)}/integrate',
        method: 'POST');
    return {'status': r['status'], 'data': r['data']};
  }

  Future<Map<String, dynamic>> reviewRun(String runId) async {
    final r = await _json('/api/runs/${Uri.encodeComponent(runId)}/review',
        method: 'POST');
    return {'status': r['status'], 'data': r['data']};
  }

  Future<Map<String, dynamic>> mergeRun(String runId) async {
    final r = await _json('/api/runs/${Uri.encodeComponent(runId)}/merge',
        method: 'POST');
    return {'status': r['status'], 'data': r['data']};
  }

  Future<List<ProviderConfig>> listProviders() async {
    final r = await _json('/api/model/providers');
    if (r['status'] != 200) return [];
    return (r['data'] as List)
        .map((e) => ProviderConfig.fromJson(e))
        .toList();
  }

  Future<dynamic> addVendor(Map<String, dynamic> input) async {
    return _json('/api/model/vendors', method: 'POST', body: input);
  }

  Future<dynamic> removeProvider(String id) async {
    return _json('/api/model/providers/${Uri.encodeComponent(id)}',
        method: 'DELETE');
  }

  static String errorMessage(dynamic data, String fallback) {
    if (data is Map && data['error'] is Map) {
      final msg = (data['error'] as Map)['message'];
      if (msg is String && msg.isNotEmpty) return msg;
    }
    return fallback;
  }
}

class ApiException implements Exception {
  final String message;
  ApiException(this.message);
  @override
  String toString() => message;
}

class RunSnapshot {
  final String runId;
  final String status;
  final String goal;
  final String workspace;
  final int maxParallel;
  final bool paused;
  final List<RunTask> tasks;
  final String? error;
  final String createdAt;
  final String updatedAt;
  final Map<String, dynamic>? dag;

  RunSnapshot({
    required this.runId,
    required this.status,
    required this.goal,
    required this.workspace,
    required this.maxParallel,
    required this.paused,
    required this.tasks,
    required this.error,
    required this.createdAt,
    required this.updatedAt,
    required this.dag,
  });

  factory RunSnapshot.fromJson(Map<String, dynamic> json) => RunSnapshot(
        runId: json['runId'] as String? ?? '',
        status: json['status'] as String? ?? 'unknown',
        goal: json['goal'] as String? ?? '',
        workspace: json['workspace'] as String? ?? '',
        maxParallel: (json['maxParallel'] as num?)?.toInt() ?? 1,
        paused: json['paused'] as bool? ?? false,
        tasks: ((json['tasks'] as List?) ?? [])
            .map((e) => RunTask.fromJson(e as Map<String, dynamic>))
            .toList(),
        error: (json['error'] as Map?)?.values.firstOrNull?.toString(),
        createdAt: json['createdAt'] as String? ?? '',
        updatedAt: json['updatedAt'] as String? ?? '',
        dag: json['dag'] as Map<String, dynamic>?,
      );
}

class RunTask {
  final String taskId;
  final String title;
  final String role;
  final String status;
  final List<String> dependsOn;
  final String? error;
  final Map<String, dynamic>? result;

  RunTask({
    required this.taskId,
    required this.title,
    required this.role,
    required this.status,
    required this.dependsOn,
    required this.error,
    required this.result,
  });

  factory RunTask.fromJson(Map<String, dynamic> json) => RunTask(
        taskId: json['taskId'] as String? ?? '',
        title: json['title'] as String? ?? '',
        role: json['role'] as String? ?? '',
        status: json['status'] as String? ?? 'pending',
        dependsOn: ((json['dependsOn'] as List?) ?? []).cast<String>(),
        error: (json['error'] as Map?)?.values.firstOrNull?.toString(),
        result: json['result'] as Map<String, dynamic>?,
      );
}

class ProviderConfig {
  final String id;
  final String name;
  final String kind;
  final String? baseUrl;
  final String? apiKeySecretRef;
  final bool enabled;

  ProviderConfig({
    required this.id,
    required this.name,
    required this.kind,
    required this.baseUrl,
    required this.apiKeySecretRef,
    required this.enabled,
  });

  factory ProviderConfig.fromJson(Map<String, dynamic> json) =>
      ProviderConfig(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        kind: json['kind'] as String? ?? '',
        baseUrl: json['baseUrl'] as String?,
        apiKeySecretRef: json['apiKeySecretRef'] as String?,
        enabled: json['enabled'] as bool? ?? true,
      );
}
