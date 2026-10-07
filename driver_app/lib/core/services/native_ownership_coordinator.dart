import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';

/// Single unified durable ownership record model.
class DurableDutyOwnerRecord {
  final String sessionId;
  final String uid;
  final int generation;
  final int lifecycleSeq;
  final String state;
  final String? notificationTitle;
  final String? notificationText;
  final String? locale;
  final DateTime startedAt;

  const DurableDutyOwnerRecord({
    required this.sessionId,
    required this.uid,
    required this.generation,
    required this.lifecycleSeq,
    this.state = 'ACTIVE',
    this.notificationTitle,
    this.notificationText,
    this.locale,
    required this.startedAt,
  });

  Map<String, dynamic> toMap() => {
    'sessionId': sessionId,
    'uid': uid,
    'generation': generation,
    'lifecycleSeq': lifecycleSeq,
    'state': state,
    'notificationTitle': notificationTitle,
    'notificationText': notificationText,
    'locale': locale,
    'startedAt': startedAt.toIso8601String(),
  };

  String encode() => jsonEncode(toMap());

  factory DurableDutyOwnerRecord.fromJson(String rawJson) {
    final dynamic map;
    try {
      map = jsonDecode(rawJson);
    } catch (e) {
      throw FormatException('Failed to parse DurableDutyOwnerRecord JSON: $e');
    }

    if (map is! Map) {
      throw const FormatException(
        'DurableDutyOwnerRecord JSON must be an object',
      );
    }
    final sessionId = map['sessionId'];
    final uid = map['uid'];
    final generation = map['generation'];
    final lifecycleSeq = map['lifecycleSeq'];
    final state = map['state'];
    final startedAtRaw = map['startedAt'];

    if (sessionId is! String ||
        sessionId.trim().isEmpty ||
        sessionId != sessionId.trim()) {
      throw const FormatException(
        'Invalid or missing sessionId in DurableDutyOwnerRecord',
      );
    }
    if (uid is! String || uid.trim().isEmpty || uid != uid.trim()) {
      throw const FormatException(
        'Invalid or missing uid in DurableDutyOwnerRecord',
      );
    }
    if (generation is! int || generation < 0) {
      throw const FormatException(
        'Invalid or missing generation in DurableDutyOwnerRecord',
      );
    }
    if (lifecycleSeq is! int || lifecycleSeq <= 0) {
      throw const FormatException(
        'Invalid or missing lifecycleSeq in DurableDutyOwnerRecord',
      );
    }
    if (state is! String || state.trim().isEmpty || state != state.trim()) {
      throw const FormatException(
        'Invalid or missing state in DurableDutyOwnerRecord',
      );
    }
    if (startedAtRaw is! String || startedAtRaw.trim().isEmpty) {
      throw const FormatException(
        'Invalid or missing startedAt in DurableDutyOwnerRecord',
      );
    }

    final parsedDate = DateTime.tryParse(startedAtRaw);
    if (parsedDate == null) {
      throw const FormatException(
        'Invalid date format for startedAt in DurableDutyOwnerRecord',
      );
    }

    return DurableDutyOwnerRecord(
      sessionId: sessionId,
      uid: uid,
      generation: generation,
      lifecycleSeq: lifecycleSeq,
      state: state,
      notificationTitle: map['notificationTitle'] as String?,
      notificationText: map['notificationText'] as String?,
      locale: map['locale'] as String?,
      startedAt: parsedDate,
    );
  }
}

/// Immutable native cleanup authority, scoped to one logout operation.
class NativeCleanupAcquisition {
  final String token;
  final String operationId;
  final DurableDutyOwnerRecord? owner;
  final int epoch;
  const NativeCleanupAcquisition(
    this.token,
    this.operationId,
    this.owner, {
    this.epoch = 0,
  });
}

/// Exception surfaced in Dart when worker bootstrap aborts and native cleanup
/// has not been confirmed successful or threw an error.
class BootstrapCleanupException implements Exception {
  final String message;
  final String? code;
  final bool? cleanupRequired;
  final bool? retryable;
  final Map<String, dynamic>? nativeBoundToken;

  BootstrapCleanupException({
    required this.message,
    this.code,
    this.cleanupRequired,
    this.retryable,
    this.nativeBoundToken,
  });

  @override
  String toString() =>
      'BootstrapCleanupException: $message (code: $code, cleanupRequired: $cleanupRequired, retryable: $retryable, nativeBoundToken: $nativeBoundToken)';
}

/// Interface and platform-channel client for atomic native ownership operations.
/// Strictly fails closed in production when the native channel is unavailable.
class NativeOwnershipCoordinator {
  static const MethodChannel channel = MethodChannel(
    'com.towingapp.driver_app/native_ownership_coordinator',
  );
  static const String durableOwnerKey = 'durable_duty_owner_record';

  /// Injected interceptor for testing race conditions and boundaries.
  static Future<void> Function(String action)? testHook;

  // In-memory test simulator for headless unit test environments ONLY
  static bool useTestSimulation = false;
  static bool simulateDelayedStartExecution = false;
  static String? _simulatedOwnerJson;
  static String? _simulatedWorkerPayload;
  static String _simulatedOwnerState = 'STOPPED';
  static int _simulatedMonotonicSeq = 0;
  static bool Function(String op)? simulatedCommitFailure;
  static Object Function()? simulatedNativeStartException;
  static Object Function()? simulatedNativeStopException;
  static Object Function()? simulatedDurableOwnerException;
  static Object Function()? simulatedServiceRunningException;
  static bool simulatedIsRunningService = false;
  static Map<String, dynamic>? simulatedAcquisitionToken;

  static Future<Map<String, dynamic>> Function()?
  simulatedWorkerBootstrapFailedHandler;

  static int _simulatedExecutionEpoch = 0;
  static int _executionEpoch = 0;
  static int _startsInFlight = 0;

  static bool get hasStartInFlight => _startsInFlight > 0;

  static int get currentEpoch =>
      useTestSimulation ? _simulatedExecutionEpoch : _executionEpoch;

  static void resetTestSimulation() {
    _cleanupAcquisitions.clear();
    _pendingCleanupUids.clear();
    _simulatedOwnerJson = null;
    _simulatedWorkerPayload = null;
    _simulatedOwnerState = 'STOPPED';
    _simulatedMonotonicSeq = 0;
    _simulatedExecutionEpoch = 0;
    _executionEpoch = 0;
    _startsInFlight = 0;
    simulatedCommitFailure = null;
    simulatedNativeStartException = null;
    simulatedNativeStopException = null;
    simulatedDurableOwnerException = null;
    simulatedServiceRunningException = null;
    simulatedIsRunningService = false;
    simulateDelayedStartExecution = false;
    simulatedAcquisitionToken = null;
    simulatedWorkerBootstrapFailedHandler = null;
    testHook = null;
    useTestSimulation = false;
  }

  static final Map<String, NativeCleanupAcquisition> _cleanupAcquisitions = {};
  static final Map<String, int> _pendingCleanupUids = {};
  static final Object _cleanupZoneKey = Object();
  static int _cleanupSerial = 0;

  /// Synchronously fences new Dart START requests until native acquisition has
  /// linearized. Already-dispatched native STARTs race under ownershipLock.
  static Future<NativeCleanupAcquisition> beginCleanupAcquisition(
    String operationId,
    String uid,
  ) async {
    _pendingCleanupUids.update(uid, (count) => count + 1, ifAbsent: () => 1);
    try {
      if (useTestSimulation) {
        final raw = _simulatedOwnerJson;
        final owner = raw == null ? null : DurableDutyOwnerRecord.fromJson(raw);
        if (owner != null && owner.uid != uid) {
          throw StateError('Cleanup acquisition UID conflict');
        }
        final lease = NativeCleanupAcquisition(
          'cleanup-${++_cleanupSerial}',
          operationId,
          owner,
          epoch: _simulatedExecutionEpoch,
        );
        _cleanupAcquisitions[lease.token] = lease;
        return lease;
      }
      final result = await channel.invokeMapMethod<String, dynamic>(
        'beginCleanupAcquisition',
        {'operationId': operationId, 'expectedUid': uid},
      );
      if (result == null ||
          result['token'] is! String ||
          result['operationId'] != operationId ||
          result['captured'] is! bool ||
          (result['captured'] == true && result['owner'] is! String)) {
        throw StateError('Invalid native cleanup acquisition');
      }
      final acquiredEpoch = (result['epoch'] as num?)?.toInt() ?? 0;
      if (_executionEpoch == 0 || acquiredEpoch > _executionEpoch) {
        _executionEpoch = acquiredEpoch;
      }
      return NativeCleanupAcquisition(
        result['token'] as String,
        operationId,
        result['captured'] == true
            ? DurableDutyOwnerRecord.fromJson(result['owner'] as String)
            : null,
        epoch: acquiredEpoch,
      );
    } finally {
      final count = _pendingCleanupUids[uid] ?? 1;
      if (count <= 1) {
        _pendingCleanupUids.remove(uid);
      } else {
        _pendingCleanupUids[uid] = count - 1;
      }
    }
  }

  /// Propagates the immutable lease through adapter overrides to native STOP.
  /// Zone-local scope prevents concurrent cleanup operations sharing a token.
  static Future<void> withCleanupAcquisition(
    NativeCleanupAcquisition lease,
    Future<void> Function() stop,
  ) => runZoned(stop, zoneValues: {_cleanupZoneKey: lease});

  static Future<bool> validateCleanupAcquisition(
    NativeCleanupAcquisition lease,
  ) async {
    if (useTestSimulation) {
      return identical(_cleanupAcquisitions[lease.token], lease) &&
          lease.epoch == _simulatedExecutionEpoch;
    }
    if (_executionEpoch != 0 && lease.epoch != _executionEpoch) {
      return false;
    }
    return await channel.invokeMethod<bool>('validateCleanupAcquisition', {
          'token': lease.token,
          'operationId': lease.operationId,
        }) ==
        true;
  }

  static Future<void> releaseCleanupAcquisition(
    NativeCleanupAcquisition lease,
  ) async {
    if (useTestSimulation) {
      if (identical(_cleanupAcquisitions[lease.token], lease)) {
        _cleanupAcquisitions.remove(lease.token);
      }
      return;
    }
    final released = await channel.invokeMethod<bool>(
      'releaseCleanupAcquisition',
      {'token': lease.token, 'operationId': lease.operationId},
    );
    if (released != true) {
      throw StateError('Cleanup acquisition release rejected');
    }
  }

  /// Reports a worker bootstrap failure to native creator to execute epoch-bound cleanup
  /// when the worker cannot obtain or initialize its immutable acquisition token.
  static Future<Map<String, dynamic>> reportWorkerBootstrapFailed({
    String? uid,
    String? sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    final Map<String, dynamic> args = {
      'uid': ?uid,
      'sessionId': ?sessionId,
      'generation': ?generation,
      'lifecycleSeq': ?lifecycleSeq,
    };
    if (useTestSimulation) {
      if (simulatedWorkerBootstrapFailedHandler != null) {
        return simulatedWorkerBootstrapFailedHandler!();
      }
      return {'success': true, 'cleaned': true};
    }
    try {
      final res = await channel.invokeMapMethod<String, dynamic>(
        'reportWorkerBootstrapFailed',
        args,
      );
      return res ??
          {
            'success': false,
            'cleaned': false,
            'cleanupRequired': false,
            'reason': 'null_response',
          };
    } catch (e) {
      return {
        'success': false,
        'cleaned': false,
        'cleanupRequired': true,
        'reason': 'cleanup_thrown',
        'error': e.toString(),
      };
    }
  }

  /// Confirms that worker has successfully initialized all dependencies and reached readiness.
  /// Generates the positive restart readiness grant on native side.
  static Future<Map<String, dynamic>> confirmWorkerBootstrapReadiness({
    String? uid,
    String? sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    final Map<String, dynamic> args = {
      'uid': ?uid,
      'sessionId': ?sessionId,
      'generation': ?generation,
      'lifecycleSeq': ?lifecycleSeq,
    };
    if (useTestSimulation) {
      return {'success': true, 'granted': true};
    }
    try {
      final res = await channel.invokeMapMethod<String, dynamic>(
        'confirmWorkerBootstrapReadiness',
        args,
      );
      return res ?? {'success': false, 'granted': false};
    } catch (e) {
      return {'success': false, 'granted': false, 'error': e.toString()};
    }
  }

  /// Retrieves the immutable acquisition token bound to this background isolate.
  /// Prevents delayed/stale workers from reading current global ownership.
  static Future<Map<String, dynamic>?> getAcquisitionToken() async {
    if (useTestSimulation) {
      if (simulatedAcquisitionToken != null) {
        return Map<String, dynamic>.from(simulatedAcquisitionToken!);
      }
      return null;
    }
    try {
      final res = await channel.invokeMapMethod<String, dynamic>(
        'getAcquisitionToken',
      );
      return res;
    } catch (_) {
      return null;
    }
  }

  /// Retrieves the current durable owner record directly from atomic native storage.
  /// Throws [FormatException] if the stored record is corrupt (fails closed).
  /// Throws [StateError] in production if native channel is missing.
  static Future<DurableDutyOwnerRecord?> getDurableOwner() async {
    if (testHook != null) {
      await testHook!('before_get_owner');
    }

    if (useTestSimulation && simulatedDurableOwnerException != null) {
      throw simulatedDurableOwnerException!();
    }

    String? rawJson;
    try {
      if (useTestSimulation) {
        rawJson = _simulatedOwnerJson;
      } else {
        rawJson = await channel.invokeMethod<String>('getDurableOwner');
      }
    } on MissingPluginException {
      if (useTestSimulation) {
        rawJson = _simulatedOwnerJson;
      } else {
        throw StateError(
          'NativeOwnershipCoordinator platform channel unavailable in production: fail-closed',
        );
      }
    } on PlatformException catch (e) {
      if (e.code == 'CORRUPT_RECORD') {
        throw FormatException('Corrupt durable owner record: ${e.message}');
      }
      rethrow;
    }

    if (rawJson == null || rawJson.trim().isEmpty) {
      return null;
    }

    return DurableDutyOwnerRecord.fromJson(rawJson);
  }

  /// Retrieves the worker payload from atomic native storage.
  static Future<String?> getWorkerPayload() async {
    try {
      if (useTestSimulation) {
        return _simulatedWorkerPayload;
      }
      return await channel.invokeMethod<String>('getWorkerPayload');
    } on MissingPluginException {
      if (useTestSimulation) {
        return _simulatedWorkerPayload;
      }
      throw StateError(
        'NativeOwnershipCoordinator platform channel unavailable in production: fail-closed',
      );
    }
  }

  /// Retrieves the current monotonic lifecycle sequence counter.
  static Future<int> getMonotonicSequence() async {
    try {
      if (useTestSimulation) {
        return _simulatedMonotonicSeq;
      }
      final seq = await channel.invokeMethod<int>('getMonotonicSequence');
      return seq ?? 0;
    } on MissingPluginException {
      if (useTestSimulation) {
        return _simulatedMonotonicSeq;
      }
      throw StateError(
        'NativeOwnershipCoordinator platform channel unavailable in production: fail-closed',
      );
    }
  }

  /// Returns the native service's definitive running state.
  /// Null is unknown, not proof of absence; preserve it as a read failure.
  static Future<bool> isServiceRunning() async {
    if (useTestSimulation && simulatedServiceRunningException != null) {
      throw simulatedServiceRunningException!();
    }
    try {
      if (useTestSimulation) {
        return simulatedIsRunningService;
      }
      final running = await channel.invokeMethod<bool>('isServiceRunning');
      if (running == null) {
        throw StateError(
          'Native service running state is unknown: fail-closed',
        );
      }
      return running;
    } on MissingPluginException {
      if (useTestSimulation) {
        return simulatedIsRunningService;
      }
      throw StateError(
        'NativeOwnershipCoordinator platform channel unavailable in production: fail-closed',
      );
    }
  }

  /// Atomically persists owner record, worker payload, and starts the native foreground service.
  /// Strictly checks monotonic lifecycle sequence; fails closed on persistence failure or sequence regression.
  static Future<Map<String, dynamic>> atomicStartService({
    required DurableDutyOwnerRecord record,
    Map<String, dynamic>? foregroundTaskOptionsMap,
  }) async {
    if (_pendingCleanupUids.containsKey(record.uid)) {
      return {'success': false, 'reason': 'cleanup_acquisition_pending'};
    }
    if (testHook != null) {
      await testHook!('before_atomic_start');
    }

    final rawJson = record.encode();

    _startsInFlight++;
    try {
      if (useTestSimulation) {
        return _simulatedAtomicStart(record, rawJson, foregroundTaskOptionsMap);
      }

      final res = await channel
          .invokeMapMethod<String, dynamic>('atomicStartService', {
            'sessionId': record.sessionId,
            'uid': record.uid,
            'dutyGeneration': record.generation,
            'lifecycleSeq': record.lifecycleSeq,
            'sessionPayloadJson': rawJson,
            'notificationTitle': record.notificationTitle,
            'notificationText': record.notificationText,
            'foregroundTaskOptionsMap': foregroundTaskOptionsMap,
          });
      if (res != null) {
        final resMap = Map<String, dynamic>.from(res);
        if (resMap['success'] == true) {
          _executionEpoch = (resMap['executionEpoch'] as num?)?.toInt() ?? (_executionEpoch + 1);
        }
        return resMap;
      }
    } on MissingPluginException {
      if (useTestSimulation) {
        return _simulatedAtomicStart(record, rawJson, foregroundTaskOptionsMap);
      }
      throw StateError(
        'NativeOwnershipCoordinator platform channel unavailable in production: fail-closed',
      );
    } catch (e) {
      return {'success': false, 'error': e.toString()};
    } finally {
      _startsInFlight--;
    }

    return {'success': false, 'reason': 'null_response'};
  }

  /// Atomically stops the foreground service and clears ownership ONLY IF
  /// the expected UID, session ID, sequence, and generation match current ownership.
  /// Returns a map with 'success' and 'stopped'. Propagates failure cleanly.
  static Future<Map<String, dynamic>> atomicStopService({
    required String expectedUid,
    required String expectedSessionId,
    required int expectedLifecycleSeq,
    required int expectedGeneration,
  }) async {
    if (expectedUid.trim().isEmpty) {
      throw ArgumentError('expectedUid is required');
    }
    if (expectedSessionId.trim().isEmpty) {
      throw ArgumentError('expectedSessionId is required');
    }
    if (expectedLifecycleSeq <= 0) {
      throw ArgumentError('expectedLifecycleSeq must be positive');
    }
    if (expectedGeneration < 0) {
      throw ArgumentError('expectedGeneration must be non-negative');
    }

    if (testHook != null) {
      await testHook!('before_atomic_stop');
    }

    final lease = Zone.current[_cleanupZoneKey] as NativeCleanupAcquisition?;
    if (lease != null) {
      final owner = lease.owner;
      if (!await validateCleanupAcquisition(lease) ||
          owner == null ||
          owner.uid != expectedUid ||
          owner.sessionId != expectedSessionId ||
          owner.generation != expectedGeneration ||
          owner.lifecycleSeq != expectedLifecycleSeq) {
        return {
          'success': false,
          'stopped': false,
          'reason': 'invalid_cleanup_acquisition',
        };
      }
    }
    try {
      if (useTestSimulation) {
        return _simulatedAtomicStop(
          expectedUid,
          expectedSessionId,
          expectedLifecycleSeq,
          expectedGeneration,
        );
      }

      final args = <String, dynamic>{
        'expectedUid': expectedUid,
        'expectedSessionId': expectedSessionId,
        'expectedLifecycleSeq': expectedLifecycleSeq,
        'expectedGeneration': expectedGeneration,
        if (lease != null) 'cleanupToken': lease.token,
        if (lease != null) 'cleanupOperationId': lease.operationId,
      };

      final res = await channel.invokeMapMethod<String, dynamic>(
        'atomicStopService',
        args,
      );
      if (res != null) {
        return Map<String, dynamic>.from(res);
      }
    } on MissingPluginException {
      if (useTestSimulation) {
        return _simulatedAtomicStop(
          expectedUid,
          expectedSessionId,
          expectedLifecycleSeq,
          expectedGeneration,
        );
      }
      throw StateError(
        'NativeOwnershipCoordinator platform channel unavailable in production: fail-closed',
      );
    } catch (e) {
      return {'success': false, 'stopped': false, 'error': e.toString()};
    }

    return {'success': false, 'stopped': false, 'reason': 'null_response'};
  }

  /// Atomically removes the owner record without stopping service if uid, session, generation and sequence match.
  static Future<Map<String, dynamic>> atomicRemoveOwner({
    required String expectedUid,
    required String expectedSessionId,
    required int expectedLifecycleSeq,
    required int expectedGeneration,
  }) async {
    if (expectedUid.trim().isEmpty) {
      throw ArgumentError('expectedUid is required');
    }
    if (expectedSessionId.trim().isEmpty) {
      throw ArgumentError('expectedSessionId is required');
    }
    if (expectedLifecycleSeq <= 0) {
      throw ArgumentError('expectedLifecycleSeq must be positive');
    }
    if (expectedGeneration < 0) {
      throw ArgumentError('expectedGeneration must be non-negative');
    }

    if (testHook != null) {
      await testHook!('before_atomic_remove');
    }

    try {
      if (useTestSimulation) {
        return _simulatedAtomicRemove(
          expectedUid,
          expectedSessionId,
          expectedLifecycleSeq,
          expectedGeneration,
        );
      }

      final args = <String, dynamic>{
        'expectedUid': expectedUid,
        'expectedSessionId': expectedSessionId,
        'expectedLifecycleSeq': expectedLifecycleSeq,
        'expectedGeneration': expectedGeneration,
      };

      final res = await channel.invokeMapMethod<String, dynamic>(
        'atomicRemoveOwner',
        args,
      );
      if (res != null) {
        return Map<String, dynamic>.from(res);
      }
    } on MissingPluginException {
      if (useTestSimulation) {
        return _simulatedAtomicRemove(
          expectedUid,
          expectedSessionId,
          expectedLifecycleSeq,
          expectedGeneration,
        );
      }
      throw StateError(
        'NativeOwnershipCoordinator platform channel unavailable in production: fail-closed',
      );
    } catch (e) {
      return {'success': false, 'removed': false, 'error': e.toString()};
    }

    return {'success': false, 'removed': false};
  }

  /// Simulates execution boundary validation (mirroring validateServiceExecutionBoundary in Kotlin).
  static bool simulateServiceExecutionBoundary() {
    if (_simulatedOwnerJson == null) {
      return false;
    }
    if (_simulatedOwnerState != 'PENDING_START' &&
        _simulatedOwnerState != 'ACTIVE') {
      return false;
    }
    if (_simulatedOwnerState == 'PENDING_START') {
      _simulatedOwnerState = 'ACTIVE';
      simulatedIsRunningService = true;
      try {
        final cur = DurableDutyOwnerRecord.fromJson(_simulatedOwnerJson!);
        final activeRecord = DurableDutyOwnerRecord(
          sessionId: cur.sessionId,
          uid: cur.uid,
          generation: cur.generation,
          lifecycleSeq: cur.lifecycleSeq,
          state: 'ACTIVE',
          notificationTitle: cur.notificationTitle,
          notificationText: cur.notificationText,
          locale: cur.locale,
          startedAt: cur.startedAt,
        );
        _simulatedOwnerJson = activeRecord.encode();
      } catch (_) {}
    }
    return true;
  }

  // --- Test Simulation Handlers mirroring Kotlin native coordinator ---

  static Map<String, dynamic> _simulatedAtomicStart(
    DurableDutyOwnerRecord record,
    String rawJson,
    Map<String, dynamic>? foregroundTaskOptionsMap,
  ) {
    // Validate real callback handle
    final callbackHandle = foregroundTaskOptionsMap?['callbackHandle'];
    if (callbackHandle == null ||
        (callbackHandle is num && callbackHandle == 0)) {
      return {
        'success': false,
        'error':
            'INVALID_ARGUMENT: Valid callbackHandle is required in foregroundTaskOptionsMap',
      };
    }

    if (simulatedCommitFailure?.call('start_payload') == true) {
      return {'success': false, 'reason': 'commit_failed'};
    }

    int existingSeq = _simulatedMonotonicSeq;
    if (_simulatedOwnerJson != null) {
      try {
        final existing = DurableDutyOwnerRecord.fromJson(_simulatedOwnerJson!);
        if (existing.lifecycleSeq > existingSeq) {
          existingSeq = existing.lifecycleSeq;
        }
      } catch (_) {}
    }

    if (record.lifecycleSeq <= existingSeq) {
      return {
        'success': false,
        'reason': 'superseded_sequence',
        'currentSeq': existingSeq,
      };
    }

    final enrichedRecord = DurableDutyOwnerRecord(
      sessionId: record.sessionId,
      uid: record.uid,
      generation: record.generation,
      lifecycleSeq: record.lifecycleSeq,
      state: 'PENDING_START',
      notificationTitle: record.notificationTitle,
      notificationText: record.notificationText,
      locale: record.locale,
      startedAt: record.startedAt,
    );
    final enrichedJson = enrichedRecord.encode();

    if (simulatedNativeStartException != null) {
      final ex = simulatedNativeStartException!();
      // Safe rollback: only remove if current owner matches this exact epoch
      if (_simulatedMonotonicSeq == record.lifecycleSeq &&
          _simulatedOwnerJson != null) {
        try {
          final cur = DurableDutyOwnerRecord.fromJson(_simulatedOwnerJson!);
          if (cur.sessionId == record.sessionId &&
              cur.generation == record.generation) {
            _simulatedOwnerJson = null;
            _simulatedWorkerPayload = null;
            _simulatedOwnerState = 'STOPPED';
          }
        } catch (_) {}
      }
      simulatedIsRunningService = false;
      return {'success': false, 'error': ex.toString()};
    }

    _simulatedOwnerJson = enrichedJson;
    _simulatedWorkerPayload = rawJson;
    _simulatedMonotonicSeq = record.lifecycleSeq;
    _simulatedOwnerState = 'PENDING_START';
    _simulatedExecutionEpoch++;
    _executionEpoch = _simulatedExecutionEpoch;

    if (!simulateDelayedStartExecution) {
      _simulatedOwnerState = 'ACTIVE';
      simulatedIsRunningService = true;
      final activeRecord = DurableDutyOwnerRecord(
        sessionId: record.sessionId,
        uid: record.uid,
        generation: record.generation,
        lifecycleSeq: record.lifecycleSeq,
        state: 'ACTIVE',
        notificationTitle: record.notificationTitle,
        notificationText: record.notificationText,
        locale: record.locale,
        startedAt: record.startedAt,
      );
      _simulatedOwnerJson = activeRecord.encode();
    }

    return {
      'success': true,
      'active': _simulatedOwnerState == 'ACTIVE',
      'sessionId': record.sessionId,
      'lifecycleSeq': record.lifecycleSeq,
      'generation': record.generation,
      'state': _simulatedOwnerState,
    };
  }

  static Map<String, dynamic> _simulatedAtomicStop(
    String expectedUid,
    String expectedSessionId,
    int expectedLifecycleSeq,
    int expectedGeneration,
  ) {
    if (_simulatedOwnerJson == null) {
      return {
        'success': true,
        'stopped': simulatedIsRunningService,
        'reason': 'no_active_owner',
      };
    }

    final DurableDutyOwnerRecord current;
    try {
      current = DurableDutyOwnerRecord.fromJson(_simulatedOwnerJson!);
    } catch (e) {
      return {'success': false, 'stopped': false, 'reason': 'corrupt_record'};
    }

    if (current.uid != expectedUid) {
      return {
        'success': false,
        'stopped': false,
        'reason': 'uid_mismatch',
        'currentUid': current.uid,
        'currentSessionId': current.sessionId,
        'currentSeq': current.lifecycleSeq,
      };
    }

    if (current.sessionId != expectedSessionId) {
      return {
        'success': false,
        'stopped': false,
        'reason': 'ownership_transferred',
        'currentSessionId': current.sessionId,
        'currentSeq': current.lifecycleSeq,
      };
    }

    if (current.generation != expectedGeneration) {
      return {
        'success': false,
        'stopped': false,
        'reason': 'generation_mismatch',
        'currentSessionId': current.sessionId,
        'currentGeneration': current.generation,
        'currentSeq': current.lifecycleSeq,
      };
    }

    if (current.lifecycleSeq != expectedLifecycleSeq) {
      return {
        'success': false,
        'stopped': false,
        'reason': 'sequence_mismatch',
        'currentSessionId': current.sessionId,
        'currentSeq': current.lifecycleSeq,
      };
    }

    if (simulatedCommitFailure?.call('stop_removal') == true) {
      _simulatedOwnerState = 'FAILED_CLEANUP';
      return {'success': false, 'stopped': false, 'reason': 'commit_failed'};
    }

    if (simulatedNativeStopException != null) {
      final ex = simulatedNativeStopException!();
      _simulatedOwnerState = 'FAILED_CLEANUP';
      return {'success': false, 'stopped': false, 'error': ex.toString()};
    }

    _simulatedOwnerJson = null;
    _simulatedWorkerPayload = null;
    _simulatedOwnerState = 'STOPPED';
    simulatedIsRunningService = false;

    return {'success': true, 'stopped': true};
  }

  static Map<String, dynamic> _simulatedAtomicRemove(
    String expectedUid,
    String expectedSessionId,
    int expectedLifecycleSeq,
    int expectedGeneration,
  ) {
    if (_simulatedOwnerJson == null) {
      return {'success': true, 'removed': false, 'reason': 'no_active_owner'};
    }

    final DurableDutyOwnerRecord current;
    try {
      current = DurableDutyOwnerRecord.fromJson(_simulatedOwnerJson!);
    } catch (_) {
      return {'success': false, 'removed': false, 'reason': 'corrupt_record'};
    }

    if (current.uid != expectedUid ||
        current.sessionId != expectedSessionId ||
        current.lifecycleSeq != expectedLifecycleSeq ||
        current.generation != expectedGeneration) {
      return {
        'success': false,
        'removed': false,
        'reason': 'ownership_transferred',
      };
    }

    if (simulatedCommitFailure?.call('remove_owner') == true) {
      _simulatedOwnerState = 'FAILED_CLEANUP';
      return {'success': false, 'removed': false, 'reason': 'commit_failed'};
    }

    _simulatedOwnerJson = null;
    _simulatedWorkerPayload = null;
    _simulatedOwnerState = 'STOPPED';
    return {'success': true, 'removed': true};
  }
}
