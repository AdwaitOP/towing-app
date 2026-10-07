// ignore_for_file: subtype_of_sealed_class, must_be_immutable
import 'dart:async';
import 'dart:convert';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
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
  final List<Map<String, dynamic>> recordedStopAttempts = [];

  String? currentDurableOwnerJson;
  String? currentWorkerPayloadJson;
  Map<String, dynamic>? s1EngineAcquisitionToken;
  bool isServiceRunning = false;
  bool bootstrapFailureReported = false;
  bool readinessConfirmed = false;
  Map<String, dynamic>? mockBootstrapFailedResponse;
  bool throwOnReportFailed = false;
  Map<String, dynamic>? mockReadinessResponse;
  bool throwOnReadiness = false;

  setUp(() {
    NativeOwnershipCoordinator.useTestSimulation = false;
    recordedStopAttempts.clear();
    currentDurableOwnerJson = null;
    currentWorkerPayloadJson = null;
    s1EngineAcquisitionToken = null;
    isServiceRunning = false;
    bootstrapFailureReported = false;
    readinessConfirmed = false;
    mockBootstrapFailedResponse = null;
    throwOnReportFailed = false;
    mockReadinessResponse = null;
    throwOnReadiness = false;

    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
      switch (call.method) {
        case 'getDurableOwner':
          return currentDurableOwnerJson;
        case 'getWorkerPayload':
          return currentWorkerPayloadJson;
        case 'getAcquisitionToken':
          return s1EngineAcquisitionToken;
        case 'isServiceRunning':
          return isServiceRunning;
        case 'confirmWorkerBootstrapReadiness':
          readinessConfirmed = true;
          if (throwOnReadiness) {
            throw PlatformException(code: 'readiness_thrown', message: 'Simulated readiness throw');
          }
          if (mockReadinessResponse != null) {
            return mockReadinessResponse;
          }
          return {'success': true, 'granted': true};
        case 'reportWorkerBootstrapFailed':
          bootstrapFailureReported = true;
          if (throwOnReportFailed) {
            throw PlatformException(code: 'cleanup_failed', message: 'Simulated channel failure');
          }
          if (mockBootstrapFailedResponse != null) {
            return mockBootstrapFailedResponse;
          }
          // Native creator epoch-bound cleanup:
          if (currentDurableOwnerJson != null) {
            final cur = jsonDecode(currentDurableOwnerJson!) as Map<String, dynamic>;
            // If the failing epoch is currently authoritative, native creator rolls back start and stops service
            if (cur['uid'] == 'UID1' && cur['lifecycleSeq'] == 1) {
              currentDurableOwnerJson = null;
              currentWorkerPayloadJson = null;
              isServiceRunning = false;
            }
          }
          return {'success': true, 'cleaned': true};
        case 'atomicStartService':
          final args = Map<String, dynamic>.from(call.arguments as Map);
          currentDurableOwnerJson = jsonEncode({
            'sessionId': args['sessionId'],
            'uid': args['uid'],
            'generation': args['dutyGeneration'],
            'lifecycleSeq': args['lifecycleSeq'],
            'state': 'ACTIVE',
            'startedAt': DateTime.now().toIso8601String(),
          });
          currentWorkerPayloadJson = args['sessionPayloadJson'] as String?;
          isServiceRunning = true;
          return {
            'success': true,
            'active': true,
            'sessionId': args['sessionId'],
            'lifecycleSeq': args['lifecycleSeq'],
            'generation': args['dutyGeneration'],
            'state': 'ACTIVE',
          };
        case 'atomicStopService':
          final args = Map<String, dynamic>.from(call.arguments as Map);
          recordedStopAttempts.add(args);

          if (currentDurableOwnerJson != null) {
            final cur = jsonDecode(currentDurableOwnerJson!) as Map<String, dynamic>;
            if (cur['uid'] == args['expectedUid'] &&
                cur['sessionId'] == args['expectedSessionId'] &&
                cur['generation'] == args['expectedGeneration'] &&
                cur['lifecycleSeq'] == args['expectedLifecycleSeq']) {
              currentDurableOwnerJson = null;
              currentWorkerPayloadJson = null;
              isServiceRunning = false;
              return {'success': true, 'stopped': true, 'reason': 'stopped'};
            } else {
              return {'success': false, 'stopped': false, 'reason': 'uid_mismatch'};
            }
          }
          return {'success': true, 'stopped': false, 'reason': 'no_active_owner'};
        default:
          return null;
      }
    });
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
  });

  group('Checkpoint 3 Scope A: Worker Bootstrap Cleanup Authority Reproductions', () {
    test('A1: Token delivery failure (null) fails closed immediately with creator teardown', () async {
      const s1Uid = 'UID1';
      const s1SessionId = 'sess_shared';
      const s1Gen = 1;
      const s1Seq = 1;

      final s1Record = DurableDutyOwnerRecord(
        sessionId: s1SessionId,
        uid: s1Uid,
        generation: s1Gen,
        lifecycleSeq: s1Seq,
        notificationTitle: 'S1 Title',
        notificationText: 'S1 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      final startRes = await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );
      expect(startRes['success'], isTrue);
      expect(startRes['active'], isTrue);

      // Token delivery returns null
      s1EngineAcquisitionToken = null;

      final s1Handler = DriverLocationTaskHandler(
        authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
      );

      await s1Handler.onStart(DateTime.now(), TaskStarter.developer);

      // Fails closed immediately:
      expect(s1Handler.isInitialized, isFalse);
      expect(s1Handler.workerSession, isNull);
      // Signals native creator to tear down:
      expect(bootstrapFailureReported, isTrue);
      // NEVER calls atomicStopService:
      expect(recordedStopAttempts, isEmpty);
      // Native creator tore down service:
      expect(isServiceRunning, isFalse);
    });

    test('A1: Bootstrap failure with acquisition token uses ONLY S1 token to clean up', () async {
      const s1Uid = 'UID1';
      const s1SessionId = 'sess_shared';
      const s1Gen = 1;
      const s1Seq = 1;

      final s1Record = DurableDutyOwnerRecord(
        sessionId: s1SessionId,
        uid: s1Uid,
        generation: s1Gen,
        lifecycleSeq: s1Seq,
        notificationTitle: 'S1 Title',
        notificationText: 'S1 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );

      // S1 engine delivered immutable token
      s1EngineAcquisitionToken = {
        'uid': s1Uid,
        'sessionId': s1SessionId,
        'generation': s1Gen,
        'lifecycleSeq': s1Seq,
      };

      // Fails during Firebase init
      final s1Handler = DriverLocationTaskHandler(
        firebaseInitializer: () async {
          throw Exception('Firebase initialization failed');
        },
        authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
      );

      await s1Handler.onStart(DateTime.now(), TaskStarter.developer);

      expect(recordedStopAttempts, isNotEmpty);
      final cleanup = recordedStopAttempts.last;
      expect(cleanup['expectedUid'], equals(s1Uid));
      expect(cleanup['expectedSessionId'], equals(s1SessionId));
      expect(cleanup['expectedGeneration'], equals(s1Gen));
      expect(cleanup['expectedLifecycleSeq'], equals(s1Seq));
      expect(isServiceRunning, isFalse);
    });

    test('A2: S1 delayed during bootstrap with null token, S2 replaces it, S1 fails closed without touching S2', () async {
      const s1Uid = 'UID1';
      const sharedSessionId = 'sess_shared';
      const s1Gen = 1;
      const s1Seq = 1;

      final s1Record = DurableDutyOwnerRecord(
        sessionId: sharedSessionId,
        uid: s1Uid,
        generation: s1Gen,
        lifecycleSeq: s1Seq,
        notificationTitle: 'S1 Title',
        notificationText: 'S1 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );

      // S2 replaces S1
      const s2Uid = 'UID2';
      const s2Gen = 2;
      const s2Seq = 2;

      final s2Record = DurableDutyOwnerRecord(
        sessionId: sharedSessionId,
        uid: s2Uid,
        generation: s2Gen,
        lifecycleSeq: s2Seq,
        notificationTitle: 'S2 Title',
        notificationText: 'S2 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      await NativeOwnershipCoordinator.atomicStartService(
        record: s2Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );

      // S1 wakes up, but token delivery is null
      s1EngineAcquisitionToken = null;

      final s1Handler = DriverLocationTaskHandler(
        authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
      );

      await s1Handler.onStart(DateTime.now(), TaskStarter.developer);

      // S1 fails closed, NEVER touches S2
      expect(recordedStopAttempts, isEmpty);
      expect(s1Handler.isInitialized, isFalse);

      final activeOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(activeOwner?.uid, equals(s2Uid));
      expect(activeOwner?.lifecycleSeq, equals(s2Seq));
      expect(isServiceRunning, isTrue);
    });

    test('A2: S1 delayed during bootstrap with S1 token, S2 replaces it; S1 cleanup uses S1 token and S2 remains untouched', () async {
      const s1Uid = 'UID1';
      const sharedSessionId = 'sess_shared';
      const s1Gen = 1;
      const s1Seq = 1;

      final s1Record = DurableDutyOwnerRecord(
        sessionId: sharedSessionId,
        uid: s1Uid,
        generation: s1Gen,
        lifecycleSeq: s1Seq,
        notificationTitle: 'S1 Title',
        notificationText: 'S1 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );

      // S1 token delivery is ready
      s1EngineAcquisitionToken = {
        'uid': s1Uid,
        'sessionId': sharedSessionId,
        'generation': s1Gen,
        'lifecycleSeq': s1Seq,
      };

      final s1BootstrapDelayedCompleter = Completer<void>();
      final s1ResumeBootstrapCompleter = Completer<void>();

      final s1Handler = DriverLocationTaskHandler(
        firebaseInitializer: () async {
          s1BootstrapDelayedCompleter.complete();
          await s1ResumeBootstrapCompleter.future;
          throw Exception('Delayed failure');
        },
        authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
      );

      final s1StartFuture = s1Handler.onStart(DateTime.now(), TaskStarter.developer);
      await s1BootstrapDelayedCompleter.future;

      // S2 replaces S1
      const s2Uid = 'UID2';
      const s2Gen = 2;
      const s2Seq = 2;

      final s2Record = DurableDutyOwnerRecord(
        sessionId: sharedSessionId,
        uid: s2Uid,
        generation: s2Gen,
        lifecycleSeq: s2Seq,
        notificationTitle: 'S2 Title',
        notificationText: 'S2 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      await NativeOwnershipCoordinator.atomicStartService(
        record: s2Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );

      // S1 resumes and fails
      s1ResumeBootstrapCompleter.complete();
      await s1StartFuture;

      for (final attempt in recordedStopAttempts) {
        expect(attempt['expectedUid'], isNot(equals(s2Uid)),
            reason: 'S1 MUST NEVER borrow S2 UID');
        expect(attempt['expectedLifecycleSeq'], isNot(equals(s2Seq)),
            reason: 'S1 MUST NEVER borrow S2 lifecycle sequence');
      }

      final activeOwner = await NativeOwnershipCoordinator.getDurableOwner();
      expect(activeOwner?.uid, equals(s2Uid));
      expect(activeOwner?.lifecycleSeq, equals(s2Seq));
      expect(isServiceRunning, isTrue);
    });

    test('A2: Bootstrap failure with unconfirmed cleanup throws typed BootstrapCleanupException', () async {
      s1EngineAcquisitionToken = null;
      mockBootstrapFailedResponse = {
        'success': false,
        'cleaned': false,
        'cleanupRequired': false,
        'reason': 'unbound_cleanup_rejected',
      };

      final s1Handler = DriverLocationTaskHandler(
        authProvider: () => FakeFirebaseAuth(FakeUser('UID1')),
      );

      expect(
        () => s1Handler.onStart(DateTime.now(), TaskStarter.developer),
        throwsA(isA<BootstrapCleanupException>().having(
          (e) => e.code,
          'code',
          equals('unbound_cleanup_rejected'),
        )),
      );
    });

    test('A2: Bootstrap failure when reportWorkerBootstrapFailed throws surfaces BootstrapCleanupException', () async {
      s1EngineAcquisitionToken = null;
      throwOnReportFailed = true;

      final s1Handler = DriverLocationTaskHandler(
        authProvider: () => FakeFirebaseAuth(FakeUser('UID1')),
      );

      expect(
        () => s1Handler.onStart(DateTime.now(), TaskStarter.developer),
        throwsA(isA<BootstrapCleanupException>().having(
          (e) => e.code,
          'code',
          equals('cleanup_thrown'),
        )),
      );
    });

    test('B5: Successful worker bootstrap calls confirmWorkerBootstrapReadiness', () async {
      const s1Uid = 'UID1';
      const s1SessionId = 'sess_1';
      const s1Gen = 1;
      const s1Seq = 1;

      final s1Record = DurableDutyOwnerRecord(
        sessionId: s1SessionId,
        uid: s1Uid,
        generation: s1Gen,
        lifecycleSeq: s1Seq,
        notificationTitle: 'S1 Title',
        notificationText: 'S1 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );

      s1EngineAcquisitionToken = {
        'uid': s1Uid,
        'sessionId': s1SessionId,
        'generation': s1Gen,
        'lifecycleSeq': s1Seq,
      };

      final s1Handler = DriverLocationTaskHandler(
        firebaseInitializer: () async {},
        authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
      );

      await s1Handler.onStart(DateTime.now(), TaskStarter.developer);
      expect(s1Handler.isInitialized, isTrue);
      expect(readinessConfirmed, isTrue);
    });

    test('CP3-A1-D: Worker readiness rejection prevents initialization and fails closed', () async {
      const s1Uid = 'UID1';
      const s1SessionId = 'sess_readiness_fail';
      const s1Gen = 1;
      const s1Seq = 1;

      final s1Record = DurableDutyOwnerRecord(
        sessionId: s1SessionId,
        uid: s1Uid,
        generation: s1Gen,
        lifecycleSeq: s1Seq,
        notificationTitle: 'S1 Title',
        notificationText: 'S1 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );

      s1EngineAcquisitionToken = {
        'uid': s1Uid,
        'sessionId': s1SessionId,
        'generation': s1Gen,
        'lifecycleSeq': s1Seq,
      };

      mockReadinessResponse = {
        'success': false,
        'granted': false,
        'reason': 'grant_denied',
      };

      final s1Handler = DriverLocationTaskHandler(
        firebaseInitializer: () async {},
        authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
      );

      expect(
        () => s1Handler.onStart(DateTime.now(), TaskStarter.developer),
        throwsA(isA<BootstrapCleanupException>().having(
          (e) => e.code,
          'code',
          equals('grant_denied'),
        )),
      );

      expect(s1Handler.isInitialized, isFalse);
      expect(s1Handler.workerSession, isNull);
    });

    test('CP3-A1-D: Worker readiness throw prevents initialization and fails closed', () async {
      const s1Uid = 'UID1';
      const s1SessionId = 'sess_readiness_throw';
      const s1Gen = 1;
      const s1Seq = 1;

      final s1Record = DurableDutyOwnerRecord(
        sessionId: s1SessionId,
        uid: s1Uid,
        generation: s1Gen,
        lifecycleSeq: s1Seq,
        notificationTitle: 'S1 Title',
        notificationText: 'S1 Text',
        locale: 'en',
        startedAt: DateTime.now(),
      );

      await NativeOwnershipCoordinator.atomicStartService(
        record: s1Record,
        foregroundTaskOptionsMap: const {'callbackHandle': 10001},
      );

      s1EngineAcquisitionToken = {
        'uid': s1Uid,
        'sessionId': s1SessionId,
        'generation': s1Gen,
        'lifecycleSeq': s1Seq,
      };

      final s1Handler = DriverLocationTaskHandler(
        firebaseInitializer: () async {},
        authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
        readinessConfirmer: () async => throw Exception('Simulated readiness exception'),
      );

      expect(
        () => s1Handler.onStart(DateTime.now(), TaskStarter.developer),
        throwsA(isA<BootstrapCleanupException>().having(
          (e) => e.message,
          'message',
          contains('Readiness confirmation threw: Exception: Simulated readiness exception'),
        )),
      );

      expect(s1Handler.isInitialized, isFalse);
      expect(s1Handler.workerSession, isNull);
    });
  });
}
