// ignore_for_file: subtype_of_sealed_class, must_be_immutable
import 'dart:async';
import 'dart:convert';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

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
  Map<String, dynamic>? activeAcquisitionToken;
  bool isServiceRunning = false;
  Map<String, dynamic>? mockReadinessResponse;

  Position makePosition({double lat = 19.0760, double lng = 72.8777}) {
    return Position(
      latitude: lat,
      longitude: lng,
      timestamp: DateTime.now(),
      accuracy: 5.0,
      altitude: 10.0,
      heading: 0.0,
      speed: 0.0,
      speedAccuracy: 0.0,
      altitudeAccuracy: 0.0,
      headingAccuracy: 0.0,
    );
  }

  setUp(() {
    NativeOwnershipCoordinator.useTestSimulation = false;
    recordedStopAttempts.clear();
    currentDurableOwnerJson = null;
    currentWorkerPayloadJson = null;
    activeAcquisitionToken = null;
    isServiceRunning = false;
    mockReadinessResponse = null;

    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
      switch (call.method) {
        case 'getDurableOwner':
          return currentDurableOwnerJson;
        case 'getWorkerPayload':
          return currentWorkerPayloadJson;
        case 'getAcquisitionToken':
          return activeAcquisitionToken;
        case 'isServiceRunning':
          return isServiceRunning;
        case 'confirmWorkerBootstrapReadiness':
          if (mockReadinessResponse != null) {
            return mockReadinessResponse;
          }
          return {'success': true, 'granted': true};
        case 'reportWorkerBootstrapFailed':
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

  group('Milestone 2 Contract Acceptance Tests', () {
    // -------------------------------------------------------------------------
    // M2-A: Native/service ACTIVE alone cannot imply server readiness.
    // -------------------------------------------------------------------------
    group('M2-A: Server readiness must be worker-owned', () {
      test('Native ACTIVE and service running does not make serverReady true', () async {
        const uid = 'UID1';
        const sessionId = 'sess_1';
        const gen = 1;
        const seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        final startRes = await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );
        expect(startRes['active'], isTrue);
        expect(await NativeOwnershipCoordinator.isServiceRunning(), isTrue);

        // Deliver acquisition token to isolate
        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': gen,
          'lifecycleSeq': seq,
        };

        final handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => makePosition(),
        );

        // Before onStart runs or before server publication, serverReady is false
        expect(handler.isServerReady, isFalse);
        expect(handler.isInitialized, isFalse);

        // Run local bootstrap (onStart)
        await handler.onStart(DateTime.now(), TaskStarter.developer);

        // Local bootstrap succeeded
        expect(handler.isInitialized, isTrue);

        // Before worker publishes server readiness, serverReady remains false!
        expect(handler.isServerReady, isFalse);
      });
    });

    // -------------------------------------------------------------------------
    // M2-B: Only genuine exact worker epoch can publish readiness.
    // -------------------------------------------------------------------------
    group('M2-B: Readiness must be exact-epoch fenced', () {
      test('Worker with exact token publishes server readiness successfully', () async {
        const uid = 'UID1';
        const sessionId = 'sess_1';
        const gen = 1;
        const seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': gen,
          'lifecycleSeq': seq,
        };

        final publishedHeartbeats = <Map<String, dynamic>>[];

        final handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => makePosition(),
          heartbeatReporter: (sid, pos) async {
            publishedHeartbeats.add({
              'sessionId': sid,
              'pos': pos,
            });
          },
        );

        await handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(handler.isInitialized, isTrue);
        expect(handler.isServerReady, isFalse);

        final ready = await handler.publishServerReadiness();
        expect(ready, isTrue);
        expect(handler.isServerReady, isTrue);
        expect(publishedHeartbeats, hasLength(1));
        expect(publishedHeartbeats.first['sessionId'], equals(sessionId));
      });

      test('Worker rejects readiness publication if acquisition token is mismatched', () async {
        const uid = 'UID1';
        const sessionId = 'sess_1';
        const gen = 1;
        const seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        // Mismatched token delivered (e.g. wrong generation)
        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': 999, // Mismatched!
          'lifecycleSeq': seq,
        };

        final handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => makePosition(),
        );

        await handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(handler.isInitialized, isFalse);
        expect(handler.isServerReady, isFalse);

        final ready = await handler.publishServerReadiness();
        expect(ready, isFalse);
        expect(handler.isServerReady, isFalse);
      });
    });

    // -------------------------------------------------------------------------
    // M2-C: S1 -> S2 replacement: delayed S1 readiness rejected.
    // -------------------------------------------------------------------------
    group('M2-C: S1 -> S2 Replacement & Delayed Readiness Fencing', () {
      test('Delayed S1 readiness publication after S2 replacement is rejected', () async {
        const s1Uid = 'UID1';
        const sharedSessionId = 'sess_shared';
        const s1Gen = 1;
        const s1Seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s1Uid,
          generation: s1Gen,
          lifecycleSeq: s1Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': s1Uid,
          'sessionId': sharedSessionId,
          'generation': s1Gen,
          'lifecycleSeq': s1Seq,
        };

        final s1GpsDelayCompleter = Completer<void>();
        final s1ResumeGpsCompleter = Completer<void>();
        final s1CommittedWrites = <String>[];

        final s1Handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
          locationProvider: () async {
            s1GpsDelayCompleter.complete();
            await s1ResumeGpsCompleter.future;
            return makePosition();
          },
          heartbeatReporter: (sid, pos) async {
            s1CommittedWrites.add('s1_heartbeat:$sid');
          },
        );

        await s1Handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(s1Handler.isInitialized, isTrue);

        // S1 begins readiness publication in background
        final s1ReadinessFuture = s1Handler.publishServerReadiness();
        await s1GpsDelayCompleter.future;

        // S2 replaces S1
        const s2Uid = 'UID2';
        const s2Gen = 2;
        const s2Seq = 2;

        final s2Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s2Uid,
          generation: s2Gen,
          lifecycleSeq: s2Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s2Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        // Resume delayed S1 operation
        s1ResumeGpsCompleter.complete();
        final s1Result = await s1ReadinessFuture;

        // S1 MUST be rejected and cannot publish readiness
        expect(s1Result, isFalse);
        expect(s1Handler.isServerReady, isFalse);
        expect(s1CommittedWrites, isEmpty);

        // S2 remains authoritative
        final activeOwner = await NativeOwnershipCoordinator.getDurableOwner();
        expect(activeOwner?.uid, equals(s2Uid));
        expect(activeOwner?.generation, equals(s2Gen));
        expect(activeOwner?.lifecycleSeq, equals(s2Seq));
      });
    });

    // -------------------------------------------------------------------------
    // M2-D: Delayed S1 heartbeat/location completion after S2 replacement cannot mutate S2.
    // -------------------------------------------------------------------------
    group('M2-D: In-flight heartbeat retirement', () {
      test('Delayed S1 heartbeat after S2 replacement cannot commit state', () async {
        const s1Uid = 'UID1';
        const sharedSessionId = 'sess_shared';
        const s1Gen = 1;
        const s1Seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s1Uid,
          generation: s1Gen,
          lifecycleSeq: s1Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': s1Uid,
          'sessionId': sharedSessionId,
          'generation': s1Gen,
          'lifecycleSeq': s1Seq,
        };

        final s1NetworkDelayCompleter = Completer<void>();
        final s1ResumeNetworkCompleter = Completer<void>();
        final s1NetworkCommits = <String>[];

        final s1Handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
          locationProvider: () async => makePosition(lat: 10.0, lng: 20.0),
          heartbeatReporter: (sid, pos) async {
            s1NetworkDelayCompleter.complete();
            await s1ResumeNetworkCompleter.future;
            s1NetworkCommits.add('committed:${pos.latitude},${pos.longitude}');
          },
        );

        await s1Handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(s1Handler.isInitialized, isTrue);

        // Trigger S1 heartbeat
        final s1HeartbeatFuture = s1Handler.executeHeartbeat(DateTime.now());
        await s1NetworkDelayCompleter.future;

        // S2 replaces S1
        const s2Uid = 'UID2';
        const s2Gen = 2;
        const s2Seq = 2;

        final s2Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s2Uid,
          generation: s2Gen,
          lifecycleSeq: s2Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s2Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        // Resume S1 delayed completion
        s1ResumeNetworkCompleter.complete();
        await s1HeartbeatFuture;

        // S1 worker recognizes stale state and cannot adopt S2 or maintain readiness
        expect(s1Handler.isServerReady, isFalse);
        expect(s1Handler.workerSession, isNull);

        // S2 remains authoritative
        final activeOwner = await NativeOwnershipCoordinator.getDurableOwner();
        expect(activeOwner?.uid, equals(s2Uid));
        expect(activeOwner?.lifecycleSeq, equals(s2Seq));
      });
    });

    // -------------------------------------------------------------------------
    // M2-E: STOP/retirement revokes S1 readiness and late completion cannot restore it.
    // -------------------------------------------------------------------------
    group('M2-E: Server readiness revocation on STOP/retirement', () {
      test('STOP immediately revokes serverReady and late completion cannot restore it', () async {
        const uid = 'UID1';
        const sessionId = 'sess_1';
        const gen = 1;
        const seq = 1;

        final record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': gen,
          'lifecycleSeq': seq,
        };

        final delayCompleter = Completer<void>();
        final resumeCompleter = Completer<void>();

        final handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async {
            delayCompleter.complete();
            await resumeCompleter.future;
            return makePosition();
          },
        );

        await handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(handler.isInitialized, isTrue);

        // Start asynchronous readiness publication
        final readinessFuture = handler.publishServerReadiness();
        await delayCompleter.future;

        // STOP/retire the worker before completion
        await handler.onDestroy(DateTime.now(), false);

        expect(handler.isServerReady, isFalse);
        expect(handler.isDestroyed, isTrue);

        // Delayed operation completes
        resumeCompleter.complete();
        final res = await readinessFuture;

        expect(res, isFalse);
        expect(handler.isServerReady, isFalse);
      });
    });

    // -------------------------------------------------------------------------
    // M2-F: S2 independently earns readiness after replacement.
    // -------------------------------------------------------------------------
    group('M2-F: S2 independent readiness acquisition', () {
      test('S2 starts with serverReady=false and independently earns serverReady=true', () async {
        // S1 started and earned readiness
        const s1Uid = 'UID1';
        const sharedSessionId = 'sess_shared';
        const s1Gen = 1;
        const s1Seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s1Uid,
          generation: s1Gen,
          lifecycleSeq: s1Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': s1Uid,
          'sessionId': sharedSessionId,
          'generation': s1Gen,
          'lifecycleSeq': s1Seq,
        };

        final s1Handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
          locationProvider: () async => makePosition(),
        );

        await s1Handler.onStart(DateTime.now(), TaskStarter.developer);
        await s1Handler.publishServerReadiness();
        expect(s1Handler.isServerReady, isTrue);

        // S2 replaces S1
        const s2Uid = 'UID2';
        const s2Gen = 2;
        const s2Seq = 2;

        final s2Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s2Uid,
          generation: s2Gen,
          lifecycleSeq: s2Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s2Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        // S1 retired
        await s1Handler.onDestroy(DateTime.now(), false);
        expect(s1Handler.isServerReady, isFalse);

        // S2 engine boots up
        activeAcquisitionToken = {
          'uid': s2Uid,
          'sessionId': sharedSessionId,
          'generation': s2Gen,
          'lifecycleSeq': s2Seq,
        };

        final s2Handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(s2Uid)),
          locationProvider: () async => makePosition(),
        );

        // S2 starts with serverReady = false
        expect(s2Handler.isServerReady, isFalse);

        await s2Handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(s2Handler.isInitialized, isTrue);
        expect(s2Handler.isServerReady, isFalse); // Not ready yet!

        // S2 independently earns readiness
        final s2Ready = await s2Handler.publishServerReadiness();
        expect(s2Ready, isTrue);
        expect(s2Handler.isServerReady, isTrue);
      });
    });

    // -------------------------------------------------------------------------
    // M2-G: Failure truthfulness across startup failure points.
    // -------------------------------------------------------------------------
    group('M2-G: Failure truthfulness', () {
      test('Firebase initialization failure leaves serverReady=false', () async {
        const uid = 'UID1';
        const sessionId = 'sess_fail_fb';
        const gen = 1;
        const seq = 1;

        final record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': gen,
          'lifecycleSeq': seq,
        };

        final handler = DriverLocationTaskHandler(
          firebaseInitializer: () async => throw Exception('Firebase init failed'),
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => makePosition(),
        );

        await handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(handler.isInitialized, isFalse);
        expect(handler.isServerReady, isFalse);

        final ready = await handler.publishServerReadiness();
        expect(ready, isFalse);
        expect(handler.isServerReady, isFalse);
      });

      test('Location pipeline failure leaves serverReady=false', () async {
        const uid = 'UID1';
        const sessionId = 'sess_fail_loc';
        const gen = 1;
        const seq = 1;

        final record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': gen,
          'lifecycleSeq': seq,
        };

        final handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => throw Exception('GPS hardware error'),
        );

        await handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(handler.isInitialized, isTrue);

        final ready = await handler.publishServerReadiness();
        expect(ready, isFalse);
        expect(handler.isServerReady, isFalse);
      });

      test('Server publication call failure leaves serverReady=false', () async {
        const uid = 'UID1';
        const sessionId = 'sess_fail_net';
        const gen = 1;
        const seq = 1;

        final record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': gen,
          'lifecycleSeq': seq,
        };

        final handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => makePosition(),
          heartbeatReporter: (sid, pos) async => throw Exception('Server write timeout'),
        );

        await handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(handler.isInitialized, isTrue);

        final ready = await handler.publishServerReadiness();
        expect(ready, isFalse);
        expect(handler.isServerReady, isFalse);
      });
    });

    // -------------------------------------------------------------------------
    // M2-H: Same sessionId reused with different epoch remains fully isolated.
    // -------------------------------------------------------------------------
    group('M2-H: SessionId reuse isolation across epochs', () {
      test('Reused sessionId with different generation & seq is strictly fenced', () async {
        const s1Uid = 'UID_SAME';
        const sharedSessionId = 'sess_reused';
        const s1Gen = 1;
        const s1Seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s1Uid,
          generation: s1Gen,
          lifecycleSeq: s1Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': s1Uid,
          'sessionId': sharedSessionId,
          'generation': s1Gen,
          'lifecycleSeq': s1Seq,
        };

        final s1Handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
          locationProvider: () async => makePosition(),
        );

        await s1Handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(s1Handler.isInitialized, isTrue);

        // Same sessionId reused in generation 2 and lifecycleSeq 2
        const s2Gen = 2;
        const s2Seq = 2;

        final s2Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s1Uid,
          generation: s2Gen,
          lifecycleSeq: s2Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s2Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        // S1 attempts to publish readiness or heartbeat after replacement
        final s1Ready = await s1Handler.publishServerReadiness();
        expect(s1Ready, isFalse, reason: 'S1 MUST be fenced even though sessionId is identical');
        expect(s1Handler.isServerReady, isFalse);

        final activeOwner = await NativeOwnershipCoordinator.getDurableOwner();
        expect(activeOwner?.generation, equals(s2Gen));
        expect(activeOwner?.lifecycleSeq, equals(s2Seq));
      });
    });

    // -------------------------------------------------------------------------
    // M2-FIX: Verification Tests (M2-FIX-1, M2-FIX-9, M2-FIX-10)
    // -------------------------------------------------------------------------
    group('M2-FIX: Independent Verification Fixes (M2-FIX-1, M2-FIX-9, M2-FIX-10)', () {
      test('M2-FIX-1: Main-isolate readiness forbidden - worker readiness is strictly worker-owned', () async {
        const uid = 'UID1';
        const sessionId = 'sess_fix_1';
        const gen = 1;
        const seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        // Native service is active
        expect(await NativeOwnershipCoordinator.isServiceRunning(), isTrue);

        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': gen,
          'lifecycleSeq': seq,
        };

        final handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => makePosition(),
        );

        // Before background worker publication, readiness is strictly false
        expect(handler.isServerReady, isFalse);

        await handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(handler.isInitialized, isTrue);
        expect(handler.isServerReady, isFalse);

        // Only explicit worker publication sets isServerReady to true
        final published = await handler.publishServerReadiness();
        expect(published, isTrue);
        expect(handler.isServerReady, isTrue);
      });

      test('M2-FIX-9: S2 independent readiness - S1 cannot satisfy S2 readiness', () async {
        // S1 starts and earns readiness
        const s1Uid = 'UID_SAME';
        const sharedSessionId = 'sess_m2_fix_9';
        const s1Gen = 1;
        const s1Seq = 1;

        final s1Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s1Uid,
          generation: s1Gen,
          lifecycleSeq: s1Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s1Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': s1Uid,
          'sessionId': sharedSessionId,
          'generation': s1Gen,
          'lifecycleSeq': s1Seq,
        };

        final s1Handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
          locationProvider: () async => makePosition(),
        );

        await s1Handler.onStart(DateTime.now(), TaskStarter.developer);
        await s1Handler.publishServerReadiness();
        expect(s1Handler.isServerReady, isTrue);

        // S2 replaces S1
        const s2Gen = 2;
        const s2Seq = 2;

        final s2Record = DurableDutyOwnerRecord(
          sessionId: sharedSessionId,
          uid: s1Uid,
          generation: s2Gen,
          lifecycleSeq: s2Seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: s2Record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        // S1 is retired
        await s1Handler.onDestroy(DateTime.now(), false);
        expect(s1Handler.isServerReady, isFalse);

        // S2 starts with workerReady = false
        activeAcquisitionToken = {
          'uid': s1Uid,
          'sessionId': sharedSessionId,
          'generation': s2Gen,
          'lifecycleSeq': s2Seq,
        };

        final s2Handler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(s1Uid)),
          locationProvider: () async => makePosition(),
        );

        expect(s2Handler.isServerReady, isFalse);
        await s2Handler.onStart(DateTime.now(), TaskStarter.developer);
        expect(s2Handler.isServerReady, isFalse);

        // Only exact S2 worker publication transitions it to true
        final s2Ready = await s2Handler.publishServerReadiness();
        expect(s2Ready, isTrue);
        expect(s2Handler.isServerReady, isTrue);
      });

      test('M2-FIX-10: Worker failure truthfulness - GPS or server failure leaves workerReady=false', () async {
        const uid = 'UID1';
        const sessionId = 'sess_m2_fix_10';
        const gen = 1;
        const seq = 1;

        final record = DurableDutyOwnerRecord(
          sessionId: sessionId,
          uid: uid,
          generation: gen,
          lifecycleSeq: seq,
          startedAt: DateTime.now(),
        );

        await NativeOwnershipCoordinator.atomicStartService(
          record: record,
          foregroundTaskOptionsMap: const {'callbackHandle': 10001},
        );

        activeAcquisitionToken = {
          'uid': uid,
          'sessionId': sessionId,
          'generation': gen,
          'lifecycleSeq': seq,
        };

        // Failure case A: GPS error
        final gpsFailHandler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => throw Exception('GPS hardware failure'),
        );

        await gpsFailHandler.onStart(DateTime.now(), TaskStarter.developer);
        expect(gpsFailHandler.isInitialized, isTrue);
        final gpsReady = await gpsFailHandler.publishServerReadiness();
        expect(gpsReady, isFalse);
        expect(gpsFailHandler.isServerReady, isFalse);

        // Failure case B: Server write error
        final serverFailHandler = DriverLocationTaskHandler(
          firebaseInitializer: () async {},
          authProvider: () => FakeFirebaseAuth(FakeUser(uid)),
          locationProvider: () async => makePosition(),
          heartbeatReporter: (sid, pos) async => throw Exception('Firestore timeout'),
        );

        await serverFailHandler.onStart(DateTime.now(), TaskStarter.developer);
        expect(serverFailHandler.isInitialized, isTrue);
        final serverReady = await serverFailHandler.publishServerReadiness();
        expect(serverReady, isFalse);
        expect(serverFailHandler.isServerReady, isFalse);
      });
    });
  });
}
