// ignore_for_file: subtype_of_sealed_class, must_be_immutable
import 'dart:async';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeUser implements User {
  @override
  final String uid;
  FakeUser(this.uid);

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeFirebaseAuth implements FirebaseAuth {
  User? _currentUser;
  FakeFirebaseAuth(this._currentUser);

  @override
  User? get currentUser => _currentUser;

  set currentUser(User? user) {
    _currentUser = user;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const taskChannel = MethodChannel('flutter_foreground_task/methods');
  const prefChannel = MethodChannel('plugins.flutter.io/shared_preferences');
  final Map<String, dynamic> mockStoredData = {};
  final Map<String, Object> mockPrefData = {};
  bool failTaskStorage = false;
  const defaultTaskOptions = <String, dynamic>{'callbackHandle': 10001};

  setUp(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    NativeOwnershipCoordinator.useTestSimulation = true;
    mockStoredData.clear();
    mockPrefData.clear();
    failTaskStorage = false;
    messenger.setMockMethodCallHandler(prefChannel, (call) async {
      if (call.method == 'getAll') {
        return mockPrefData;
      }
      if (call.method == 'setString') {
        final key = call.arguments['key'] as String;
        final value = call.arguments['value'] as String;
        mockPrefData[key] = value;
        return true;
      }
      if (call.method == 'setInt') {
        final key = call.arguments['key'] as String;
        final value = call.arguments['value'] as int;
        mockPrefData[key] = value;
        return true;
      }
      if (call.method == 'remove') {
        final key = call.arguments['key'] as String;
        mockPrefData.remove(key);
        return true;
      }
      return true;
    });
    messenger.setMockMethodCallHandler(taskChannel, (call) async {
      switch (call.method) {
        case 'saveData':
          if (failTaskStorage) {
            throw PlatformException(code: 'DISK_FULL', message: 'Storage exhausted');
          }
          final args = call.arguments as Map;
          mockStoredData[args['key'] as String] = args['value'];
          return true;
        case 'getData':
          final args = call.arguments as Map;
          return mockStoredData[args['key'] as String];
        case 'isRunningService':
          return NativeOwnershipCoordinator.simulatedIsRunningService;
        case 'startService':
          return true;
        case 'stopService':
          return true;
        default:
          return true;
      }
    });
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(taskChannel, null);
    messenger.setMockMethodCallHandler(prefChannel, null);
    NativeOwnershipCoordinator.resetTestSimulation();
  });

  group('Astra Regressions: Findings 1 - 9', () {
    // Finding 1: Execution boundary fence prevents ownerless service on queued start after stop
    test('Astra 1: Execution boundary fence prevents ownerless service when queued start executes after stop', () async {
      NativeOwnershipCoordinator.simulateDelayedStartExecution = true;
      final record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_1',
        uid: 'driver_astra_1',
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );

      final startRes = await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );
      expect(startRes['success'], isTrue);
      expect(startRes['state'], equals('PENDING_START'));
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isFalse);

      final stopRes = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_astra_1',
        expectedSessionId: 'sess_astra_1',
        expectedLifecycleSeq: 1,
        expectedGeneration: 1,
      );
      expect(stopRes['success'], isTrue);
      expect(stopRes['stopped'], isTrue);
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);

      final executionAllowed = NativeOwnershipCoordinator.simulateServiceExecutionBoundary();
      expect(executionAllowed, isFalse, reason: 'Queued start must be rejected by execution boundary fence');
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isFalse);
    });

    // Finding 2: S1 delayed start does not displace authoritative S2
    test('Astra 2: Delayed start execution does not displace authoritative replacement owner S2', () async {
      final s1Record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_2_s1',
        uid: 'driver_astra_2',
        generation: 1,
        lifecycleSeq: 10,
        startedAt: DateTime.now(),
      );
      final s2Record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_2_s2',
        uid: 'driver_astra_2',
        generation: 2,
        lifecycleSeq: 20,
        startedAt: DateTime.now(),
      );

      final barrier = Completer<void>();
      NativeOwnershipCoordinator.testHook = (action) async {
        if (action == 'before_atomic_start' && !barrier.isCompleted) {
          NativeOwnershipCoordinator.testHook = null;
          final s2Res = await NativeOwnershipCoordinator.atomicStartService(
            record: s2Record,
            foregroundTaskOptionsMap: defaultTaskOptions,
          );
          expect(s2Res['success'], isTrue);
          barrier.complete();
        }
      };

      final s1Res = await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );
      expect(s1Res['success'], isFalse);
      expect(s1Res['reason'], equals('superseded_sequence'));

      final currentOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(currentOwner!.sessionId, equals('sess_astra_2_s2'));
      expect(currentOwner.lifecycleSeq, equals(20));
    });

    // Finding 3: Delayed stop does not terminate replacement S2
    test('Astra 3: Delayed stop execution does not terminate replacement owner S2', () async {
      final s1Record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_3_s1',
        uid: 'driver_astra_3',
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      final s2Record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_3_s2',
        uid: 'driver_astra_3',
        generation: 2,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );

      final barrier = Completer<void>();
      NativeOwnershipCoordinator.testHook = (action) async {
        if (action == 'before_atomic_stop' && !barrier.isCompleted) {
          NativeOwnershipCoordinator.testHook = null;
          final s2Res = await NativeOwnershipCoordinator.atomicStartService(
            record: s2Record,
            foregroundTaskOptionsMap: defaultTaskOptions,
          );
          expect(s2Res['success'], isTrue);
          barrier.complete();
        }
      };

      final s1StopRes = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_astra_3',
        expectedSessionId: 'sess_astra_3_s1',
        expectedLifecycleSeq: 1,
        expectedGeneration: 1,
      );

      expect(s1StopRes['success'], isFalse);
      expect(s1StopRes['stopped'], isFalse);
      expect(s1StopRes['reason'], equals('ownership_transferred'));
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isTrue);

      final currentOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(currentOwner!.sessionId, equals('sess_astra_3_s2'));
    });

    // Finding 4: Callback handle validation
    test('Astra 4: Callback handle validation strictly rejects missing, null, or zero handles', () async {
      final record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_4',
        uid: 'driver_astra_4',
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );

      // Missing foregroundTaskOptionsMap
      final resMissing = await NativeOwnershipCoordinator.atomicStartService(record: record);
      expect(resMissing['success'], isFalse);
      expect(resMissing['error'], contains('callbackHandle is required'));

      // Null callback handle
      final resNull = await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: const {'callbackHandle': null},
      );
      expect(resNull['success'], isFalse);
      expect(resNull['error'], contains('callbackHandle is required'));

      // Zero callback handle
      final resZero = await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: const {'callbackHandle': 0},
      );
      expect(resZero['success'], isFalse);
      expect(resZero['error'], contains('callbackHandle is required'));

      // Valid callback handle
      final resValid = await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );
      expect(resValid['success'], isTrue);
    });

    // Finding 5: Safe rollback on failed persistence
    test('Astra 5: Safe rollback on failed persistence never erases replacement owner', () async {
      final s1Record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_5_s1',
        uid: 'driver_astra_5',
        generation: 1,
        lifecycleSeq: 10,
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      final s2Record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_5_s2',
        uid: 'driver_astra_5',
        generation: 2,
        lifecycleSeq: 20,
        startedAt: DateTime.now(),
      );

      NativeOwnershipCoordinator.simulatedCommitFailure = (op) => op == 'start_payload';
      final s2Res = await NativeOwnershipCoordinator.atomicStartService(
        record: s2Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );
      expect(s2Res['success'], isFalse);

      final currentOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(currentOwner, isNotNull);
      expect(currentOwner!.sessionId, equals('sess_astra_5_s1'));
      expect(currentOwner.lifecycleSeq, equals(10));
    });

    // Finding 6: Failed stop retains authority and retry succeeds
    test('Astra 6: Failed stop retains authority and subsequent retry succeeds', () async {
      final record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_6',
        uid: 'driver_astra_6',
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      NativeOwnershipCoordinator.simulatedCommitFailure = (op) => op == 'stop_removal';
      final failedStop = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_astra_6',
        expectedSessionId: 'sess_astra_6',
        expectedLifecycleSeq: 1,
        expectedGeneration: 1,
      );
      expect(failedStop['success'], isFalse);
      expect(failedStop['stopped'], isFalse);

      // Verify owner retained
      final retainedOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(retainedOwner, isNotNull);
      expect(retainedOwner!.sessionId, equals('sess_astra_6'));

      // Retry stop without error succeeds
      NativeOwnershipCoordinator.simulatedCommitFailure = null;
      final retryStop = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_astra_6',
        expectedSessionId: 'sess_astra_6',
        expectedLifecycleSeq: 1,
        expectedGeneration: 1,
      );
      expect(retryStop['success'], isTrue);
      expect(retryStop['stopped'], isTrue);
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
    });

    // Finding 7: Same session ID with different generation is fenced
    test('Astra 7: Same session ID with different generation cannot stop replacement generation', () async {
      final gen1Record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_7',
        uid: 'driver_astra_7',
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: gen1Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      final gen2Record = DurableDutyOwnerRecord(
        sessionId: 'sess_astra_7',
        uid: 'driver_astra_7',
        generation: 2,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: gen2Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      final staleGenStop = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_astra_7',
        expectedSessionId: 'sess_astra_7',
        expectedLifecycleSeq: 2,
        expectedGeneration: 1,
      );
      expect(staleGenStop['success'], isFalse);
      expect(staleGenStop['stopped'], isFalse);
      expect(staleGenStop['reason'], equals('generation_mismatch'));
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isTrue);

      final validGenStop = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_astra_7',
        expectedSessionId: 'sess_astra_7',
        expectedLifecycleSeq: 2,
        expectedGeneration: 2,
      );
      expect(validGenStop['success'], isTrue);
      expect(validGenStop['stopped'], isTrue);
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isFalse);
    });

    // Finding 8: Stop authority borrowing eliminated
    test('Astra 8: Stop operations require explicit tokens and reject empty/invalid inputs', () async {
      expect(
        () => NativeOwnershipCoordinator.atomicStopService(
          expectedUid: '',
          expectedSessionId: 'valid_id',
          expectedLifecycleSeq: 1,
          expectedGeneration: 1,
        ),
        throwsArgumentError,
      );
      expect(
        () => NativeOwnershipCoordinator.atomicStopService(
          expectedUid: 'valid_uid',
          expectedSessionId: '',
          expectedLifecycleSeq: 1,
          expectedGeneration: 1,
        ),
        throwsArgumentError,
      );
      expect(
        () => NativeOwnershipCoordinator.atomicStopService(
          expectedUid: 'valid_uid',
          expectedSessionId: 'valid_id',
          expectedLifecycleSeq: -1,
          expectedGeneration: 1,
        ),
        throwsArgumentError,
      );
      expect(
        () => NativeOwnershipCoordinator.atomicStopService(
          expectedUid: 'valid_uid',
          expectedSessionId: 'valid_id',
          expectedLifecycleSeq: 1,
          expectedGeneration: -1,
        ),
        throwsArgumentError,
      );
      expect(
        () => NativeOwnershipCoordinator.atomicRemoveOwner(
          expectedUid: '   ',
          expectedSessionId: 'valid_id',
          expectedLifecycleSeq: 1,
          expectedGeneration: 1,
        ),
        throwsArgumentError,
      );
      expect(
        () => NativeOwnershipCoordinator.atomicRemoveOwner(
          expectedUid: 'valid_uid',
          expectedSessionId: '   ',
          expectedLifecycleSeq: 1,
          expectedGeneration: 1,
        ),
        throwsArgumentError,
      );
    });

    // Finding 9: Platform channel missing in production fails closed with StateError
    test('Astra 9: Missing platform channel in production fails closed with StateError', () async {
      NativeOwnershipCoordinator.useTestSimulation = false;

      expect(
        () => NativeOwnershipCoordinator.getDurableOwner(),
        throwsA(isA<StateError>()),
      );
      expect(
        () => NativeOwnershipCoordinator.getWorkerPayload(),
        throwsA(isA<StateError>()),
      );
      expect(
        () => NativeOwnershipCoordinator.getMonotonicSequence(),
        throwsA(isA<StateError>()),
      );
      expect(
        () => NativeOwnershipCoordinator.atomicStartService(
          record: DurableDutyOwnerRecord(
            sessionId: 's',
            uid: 'u',
            generation: 1,
            lifecycleSeq: 1,
            startedAt: DateTime.now(),
          ),
          foregroundTaskOptionsMap: defaultTaskOptions,
        ),
        throwsA(isA<StateError>()),
      );
      expect(
        () => NativeOwnershipCoordinator.atomicStopService(
          expectedUid: 'u',
          expectedSessionId: 's',
          expectedLifecycleSeq: 1,
          expectedGeneration: 1,
        ),
        throwsA(isA<StateError>()),
      );
    });
  });

  group('Milestone 1: Native Ownership & Lifecycle Boundary Regressions (Scenarios A - J)', () {
    // Scenario A: Worker payload persistence returns false -> native start is not attempted.
    test('Scenario A: Worker payload persistence returns false -> native start is not attempted', () async {
      NativeOwnershipCoordinator.simulatedCommitFailure = (op) => op == 'start_payload';

      final record = DurableDutyOwnerRecord(
        sessionId: 'sess_A',
        uid: 'driver_A',
        generation: 1,
        lifecycleSeq: 1,
        notificationTitle: 'Dispatch',
        notificationText: 'Tracking',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      final result = await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      expect(result['success'], isFalse);
      expect(result['reason'], equals('commit_failed'));
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isFalse);

      final owner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(owner, isNull);
    });

    // Scenario B: Worker payload persistence throws -> native start is not attempted, no falsely current owner.
    test('Scenario B: Worker payload persistence throws -> native start is not attempted, no falsely current owner', () async {
      NativeOwnershipCoordinator.simulatedNativeStartException = () => Exception('Storage write crashed');

      final record = DurableDutyOwnerRecord(
        sessionId: 'sess_B',
        uid: 'driver_B',
        generation: 1,
        lifecycleSeq: 1,
        notificationTitle: 'Dispatch',
        notificationText: 'Tracking',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      final result = await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );
      expect(result['success'], isFalse);
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isFalse);

      final owner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(owner, isNull, reason: 'Zero falsely current owner must remain after persistence failure');

      // Also verify via DriverLocationService when persistence throws
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_B'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(
        uid: 'driver_B',
        sessionId: 'sess_B_throws',
        generation: 1,
      );

      final started = await service.startForegroundService(session: session);
      expect(started, isFalse);
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isFalse);
    });

    // Scenario C: Persisted sequence 100000 cannot regress after reconstruction.
    test('Scenario C: Persisted sequence 100000 cannot regress after reconstruction', () async {
      // Simulate process previously reached sequence 100000
      final priorRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_prior',
        uid: 'driver_C',
        generation: 1,
        lifecycleSeq: 100000,
        notificationTitle: 'Prior',
        notificationText: 'Prior',
        locale: 'en',
        startedAt: DateTime.now(),
      );
      final priorStart = await NativeOwnershipCoordinator.atomicStartService(
        record: priorRecord,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );
      expect(priorStart['success'], isTrue);

      final currentSeq = await NativeOwnershipCoordinator.getMonotonicSequence();
      expect(currentSeq, equals(100000));

      // Attempt start with a regressed sequence (e.g. 50 or 100000)
      final regressedRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_regressed',
        uid: 'driver_C',
        generation: 1,
        lifecycleSeq: 50,
        notificationTitle: 'Regressed',
        notificationText: 'Regressed',
        locale: 'en',
        startedAt: DateTime.now(),
      );
      final regressedResult = await NativeOwnershipCoordinator.atomicStartService(
        record: regressedRecord,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );
      expect(regressedResult['success'], isFalse);
      expect(regressedResult['reason'], equals('superseded_sequence'));

      // Clean reconstruction using DriverLocationService synchronizes with native sequence
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_C'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(
        uid: 'driver_C',
        sessionId: 'sess_reconstructed',
        generation: 2,
      );
      final started = await service.startForegroundService(session: session);
      expect(started, isTrue);

      final activeOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(activeOwner, isNotNull);
      expect(activeOwner!.lifecycleSeq, greaterThan(100000), reason: 'Sequence must advance monotonically past 100000');
    });

    // Scenario D: Corrupt or contradictory durable ownership fails closed.
    test('Scenario D: Corrupt or contradictory durable ownership fails closed', () async {
      // Missing required fields
      expect(
        () => DurableDutyOwnerRecord.fromJson('{"lifecycleSeq": 5}'),
        throwsA(isA<FormatException>()),
      );

      // Malformed JSON syntax
      expect(
        () => DurableDutyOwnerRecord.fromJson('{corrupt_not_json}'),
        throwsA(isA<FormatException>()),
      );

      // Negative sequence
      expect(
        () => DurableDutyOwnerRecord.fromJson(
          '{"sessionId":"s1","uid":"u1","generation":1,"lifecycleSeq":-5,"startedAt":"2026-09-21T00:00:00.000"}',
        ),
        throwsA(isA<FormatException>()),
      );
    });

    // Scenario E: S1 native start delayed; S2 becomes authoritative -> stale S1 start cannot start service or overwrite S2.
    test('Scenario E: S1 native start delayed; S2 becomes authoritative -> stale S1 cannot overwrite S2', () async {
      final s1Record = DurableDutyOwnerRecord(
        sessionId: 'sess_E_1',
        uid: 'driver_E',
        generation: 1,
        lifecycleSeq: 10,
        notificationTitle: 'S1',
        notificationText: 'S1',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      final s2Record = DurableDutyOwnerRecord(
        sessionId: 'sess_E_2',
        uid: 'driver_E',
        generation: 2,
        lifecycleSeq: 20,
        notificationTitle: 'S2',
        notificationText: 'S2',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      final barrier = Completer<void>();

      // S1 is intercepted before atomic start
      NativeOwnershipCoordinator.testHook = (action) async {
        if (action == 'before_atomic_start' && !barrier.isCompleted) {
          // While S1 is delayed, S2 commits and becomes authoritative
          NativeOwnershipCoordinator.testHook = null; // Prevent recursion
          final s2Res = await NativeOwnershipCoordinator.atomicStartService(
            record: s2Record,
            foregroundTaskOptionsMap: defaultTaskOptions,
          );
          expect(s2Res['success'], isTrue);
          barrier.complete();
        }
      };

      final s1Res = await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      expect(s1Res['success'], isFalse);
      expect(s1Res['reason'], equals('superseded_sequence'));

      final authoritativeOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(authoritativeOwner!.sessionId, equals('sess_E_2'));
      expect(authoritativeOwner.lifecycleSeq, equals(20));
    });

    // Scenario F: S1 stop delayed; S2 becomes authoritative -> stale S1 stop cannot terminate S2.
    test('Scenario F: S1 stop delayed; S2 becomes authoritative -> stale S1 stop cannot terminate S2', () async {
      final s1Record = DurableDutyOwnerRecord(
        sessionId: 'sess_F_1',
        uid: 'driver_F',
        generation: 1,
        lifecycleSeq: 1,
        notificationTitle: 'S1',
        notificationText: 'S1',
        locale: 'en',
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      final s2Record = DurableDutyOwnerRecord(
        sessionId: 'sess_F_2',
        uid: 'driver_F',
        generation: 2,
        lifecycleSeq: 2,
        notificationTitle: 'S2',
        notificationText: 'S2',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      final barrier = Completer<void>();

      // Intercept S1 stop: before removal, S2 replaces ownership
      NativeOwnershipCoordinator.testHook = (action) async {
        if (action == 'before_atomic_stop' && !barrier.isCompleted) {
          NativeOwnershipCoordinator.testHook = null;
          final s2Res = await NativeOwnershipCoordinator.atomicStartService(
            record: s2Record,
            foregroundTaskOptionsMap: defaultTaskOptions,
          );
          expect(s2Res['success'], isTrue);
          barrier.complete();
        }
      };

      final s1StopRes = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_F',
        expectedSessionId: 'sess_F_1',
        expectedLifecycleSeq: 1,
        expectedGeneration: 1,
      );

      expect(s1StopRes['success'], isFalse);
      expect(s1StopRes['stopped'], isFalse);
      expect(s1StopRes['reason'], equals('ownership_transferred'));
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isTrue, reason: 'S2 must remain running');

      final currentOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(currentOwner!.sessionId, equals('sess_F_2'));
    });

    // Scenario G: S1 cleanup delayed; S2 replaces ownership and payload -> S2 records remain intact.
    test('Scenario G: S1 cleanup delayed; S2 replaces ownership and payload -> S2 records remain intact', () async {
      final s1Record = DurableDutyOwnerRecord(
        sessionId: 'sess_G_1',
        uid: 'driver_G',
        generation: 1,
        lifecycleSeq: 100,
        notificationTitle: 'S1',
        notificationText: 'S1',
        locale: 'en',
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      final s2Record = DurableDutyOwnerRecord(
        sessionId: 'sess_G_2',
        uid: 'driver_G',
        generation: 2,
        lifecycleSeq: 200,
        notificationTitle: 'S2',
        notificationText: 'S2',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      // S2 becomes authoritative
      await NativeOwnershipCoordinator.atomicStartService(
        record: s2Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      // Delayed S1 cleanup runs
      final cleanupRes = await NativeOwnershipCoordinator.atomicRemoveOwner(
        expectedUid: 'driver_G',
        expectedSessionId: 'sess_G_1',
        expectedLifecycleSeq: 100,
        expectedGeneration: 1,
      );

      expect(cleanupRes['success'], isFalse);
      expect(cleanupRes['removed'], isFalse);
      expect(cleanupRes['reason'], equals('ownership_transferred'));

      // S2 record and payload must remain intact
      final currentOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(currentOwner, isNotNull);
      expect(currentOwner!.sessionId, equals('sess_G_2'));
      expect(currentOwner.lifecycleSeq, equals(200));

      final workerPayload = await NativeOwnershipCoordinator.getWorkerPayload();
      expect(workerPayload, isNotNull);
      final decodedPayload = DutySession.tryDecode(workerPayload!);
      expect(decodedPayload?.sessionId, equals('sess_G_2'));
    });

    // Scenario H: Same session ID with different generation/epoch cannot bypass ownership fencing.
    test('Scenario H: Same session ID with different generation/epoch cannot bypass ownership fencing', () async {
      // Epoch 1 of session 'sess_H'
      final epoch1Record = DurableDutyOwnerRecord(
        sessionId: 'sess_H',
        uid: 'driver_H',
        generation: 1,
        lifecycleSeq: 1,
        notificationTitle: 'Epoch 1',
        notificationText: 'Epoch 1',
        locale: 'en',
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: epoch1Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      // Epoch 2 of same session 'sess_H'
      final epoch2Record = DurableDutyOwnerRecord(
        sessionId: 'sess_H',
        uid: 'driver_H',
        generation: 2,
        lifecycleSeq: 2,
        notificationTitle: 'Epoch 2',
        notificationText: 'Epoch 2',
        locale: 'en',
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: epoch2Record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      // Stale stop from epoch 1 with outdated sequence
      final staleSeqStop = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_H',
        expectedSessionId: 'sess_H',
        expectedLifecycleSeq: 1,
        expectedGeneration: 2,
      );
      expect(staleSeqStop['success'], isFalse);
      expect(staleSeqStop['stopped'], isFalse);
      expect(staleSeqStop['reason'], equals('sequence_mismatch'));
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isTrue);

      // Stale stop with outdated generation
      final staleGenStop = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_H',
        expectedSessionId: 'sess_H',
        expectedLifecycleSeq: 2,
        expectedGeneration: 1,
      );
      expect(staleGenStop['success'], isFalse);
      expect(staleGenStop['stopped'], isFalse);
      expect(staleGenStop['reason'], equals('generation_mismatch'));
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isTrue);

      // Matching epoch 2 stop succeeds
      final validStop = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_H',
        expectedSessionId: 'sess_H',
        expectedLifecycleSeq: 2,
        expectedGeneration: 2,
      );
      expect(validStop['success'], isTrue);
      expect(validStop['stopped'], isTrue);
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isFalse);
    });

    // Scenario I: Native stop throws or owner removal commit fails -> does not report successful cleanup.
    test('Scenario I: Native stop throws or owner removal commit fails -> does not report successful cleanup', () async {
      final record = DurableDutyOwnerRecord(
        sessionId: 'sess_I',
        uid: 'driver_I',
        generation: 1,
        lifecycleSeq: 1,
        notificationTitle: 'I',
        notificationText: 'I',
        locale: 'en',
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      // Test 1: Native stop throws
      NativeOwnershipCoordinator.simulatedNativeStopException = () => Exception('Native stop crashed');
      final stopExResult = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_I',
        expectedSessionId: 'sess_I',
        expectedLifecycleSeq: 1,
        expectedGeneration: 1,
      );
      expect(stopExResult['success'], isFalse);
      expect(stopExResult['stopped'], isFalse);
      expect(stopExResult['error'], contains('Native stop crashed'));

      NativeOwnershipCoordinator.simulatedNativeStopException = null;

      // Test 2: Commit failure during removal
      NativeOwnershipCoordinator.simulatedCommitFailure = (op) => op == 'stop_removal';
      final commitFailResult = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_I',
        expectedSessionId: 'sess_I',
        expectedLifecycleSeq: 1,
        expectedGeneration: 1,
      );
      expect(commitFailResult['success'], isFalse);
      expect(commitFailResult['stopped'], isFalse);
      expect(commitFailResult['reason'], equals('commit_failed'));
    });

    // Scenario J: Main and worker engines observe the same canonical ownership state.
    test('Scenario J: Main and worker engines observe the same canonical ownership state', () async {
      // Main UI creates and activates session J
      const session = DutySession(
        uid: 'driver_J',
        sessionId: 'sess_J_dual',
        generation: 3,
        notificationTitle: 'Duty J',
        notificationText: 'Active',
      );
      final ownerRecord = DurableDutyOwnerRecord(
        sessionId: session.sessionId,
        uid: session.uid,
        generation: session.generation,
        lifecycleSeq: 42,
        notificationTitle: session.notificationTitle,
        notificationText: session.notificationText,
        locale: session.locale,
        startedAt: DateTime.now(),
      );
      final startRes = await NativeOwnershipCoordinator.atomicStartService(
        record: ownerRecord,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );
      expect(startRes['success'], isTrue);

      // Background worker isolate loads durable owner and worker payload
      final workerOwner = await NativeOwnershipCoordinator.getDurableOwner();
      final workerPayload = await NativeOwnershipCoordinator.getWorkerPayload();

      expect(workerOwner, isNotNull);
      expect(workerOwner!.sessionId, equals(session.sessionId));
      expect(workerOwner.uid, equals(session.uid));
      expect(workerOwner.generation, equals(session.generation));
      expect(workerOwner.lifecycleSeq, equals(42));

      expect(workerPayload, isNotNull);
      final decodedWorkerSession = DutySession.tryDecode(workerPayload!);
      expect(decodedWorkerSession?.sessionId, equals(session.sessionId));
      expect(decodedWorkerSession?.uid, equals(session.uid));

      // Worker executes DriverLocationTaskHandler.onStart successfully
      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => workerPayload,
        durableOwnerLoader: () async => workerOwner.encode(),
        authProvider: () => FakeFirebaseAuth(FakeUser('driver_J')),
      );
      await handler.onStart(DateTime.now(), TaskStarter.developer);
      expect(handler.isInitialized, isTrue);
      expect(handler.workerSession?.sessionId, equals('sess_J_dual'));

      // When service is stopped atomically, both sides observe it stopped and cleared
      await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_J',
        expectedSessionId: 'sess_J_dual',
        expectedLifecycleSeq: 42,
        expectedGeneration: 3,
      );

      final postStopOwner = await NativeOwnershipCoordinator.getDurableOwner();
      final postStopPayload = await NativeOwnershipCoordinator.getWorkerPayload();
      expect(postStopOwner, isNull);
      expect(postStopPayload, isNull);
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isFalse);
    });

    // Scenario K: Stop operation with mismatched UID fails closed with uid_mismatch
    test('Scenario K: Stop operation with mismatched UID fails closed with uid_mismatch', () async {
      final record = DurableDutyOwnerRecord(
        sessionId: 'sess_K',
        uid: 'driver_K',
        generation: 1,
        lifecycleSeq: 10,
        notificationTitle: 'K',
        notificationText: 'K',
        locale: 'en',
        startedAt: DateTime.now(),
      );
      await NativeOwnershipCoordinator.atomicStartService(
        record: record,
        foregroundTaskOptionsMap: defaultTaskOptions,
      );

      // Attempt stop with wrong UID
      final res = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'driver_WRONG',
        expectedSessionId: 'sess_K',
        expectedLifecycleSeq: 10,
        expectedGeneration: 1,
      );

      expect(res['success'], isFalse);
      expect(res['stopped'], isFalse);
      expect(res['reason'], equals('uid_mismatch'));
      expect(NativeOwnershipCoordinator.simulatedIsRunningService, isTrue);

      final currentOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(currentOwner, isNotNull);
      expect(currentOwner!.uid, equals('driver_K'));
      expect(currentOwner.sessionId, equals('sess_K'));
    });
  });
}
