import 'dart:async';

import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'duty_controller_test.dart' as fixtures;

// Only the server/permission boundaries are replaced. STOP and all native
// truth reads use DriverLocationService's production method-channel adapters.
class GoOffLocationService extends DriverLocationService {
  final events = <String>[];
  final ends = <DutySession>[];
  bool serverOn = true;
  bool failEnd = false;
  void Function()? afterEnd;

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => {
    'uid': uid,
    'name': 'Driver',
    'phone': '+919876543210',
    'truckType': 'flatbed',
    'vehicleNumber': 'MH 12 AB 1234',
    'verificationStatus': 'approved',
    'isOnDuty': serverOn,
    'activeDutySessionId': 'm5-session',
    'dutyGeneration': 2,
    'lifecycleSeq': 7,
    'workerReady': true,
  };

  @override
  Future<bool> isLocationServiceEnabled() async => true;

  @override
  Future<LocationPermissionStatus> checkPermission() async =>
      LocationPermissionStatus.granted;

  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async =>
      LocationPermissionStatus.granted;

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    events.add('end');
    ends.add(
      DutySession(
        uid: uid,
        sessionId: sessionId,
        generation: generation!,
        lifecycleSeq: lifecycleSeq,
      ),
    );
    if (failEnd) throw StateError('server END failed');
    serverOn = false;
    afterEnd?.call();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const exact = DutySession(
    uid: 'm5-driver',
    sessionId: 'm5-session',
    generation: 2,
    lifecycleSeq: 7,
  );
  const profile = DriverProfile(
    uid: 'm5-driver',
    name: 'Driver',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 AB 1234',
    verificationStatus: 'approved',
    isOnDuty: true,
    activeDutySessionId: 'm5-session',
    dutyGeneration: 2,
    lifecycleSeq: 7,
    workerReady: true,
  );
  late GoOffLocationService location;
  late fixtures.TestAuthService auth;
  late DutyController controller;
  DutySession? owner;
  bool running = true;
  bool leaveResidue = false;
  bool failStop = false;
  bool throwStop = false;
  String? failRead;
  int postStopOwnerReads = 0;
  bool stopped = false;
  bool overridePostStopRunning = false;
  Object? postStopRunningResponse;
  bool keepWorkerAfterStop = false;
  Completer<void>? verificationGate;
  final stops = <DutySession>[];

  void expectClean() {
    expect(location.serverOn, isFalse);
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(controller.trackingHealth, TrackingHealth.off);
    expect(controller.isCleanupRequired, isFalse);
    expect(controller.pendingCleanupSession, isNull);
    expect(controller.activeSession, isNull);
    expect(controller.activeLifecycleSeq, isNull);
    expect(owner, isNull);
    expect(running, isFalse);
  }

  void expectActionable() {
    expect(location.serverOn, isFalse);
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
    expect(controller.isReady, isFalse);
    expect(controller.isCleanupRequired, isTrue);
    expect(controller.pendingCleanupSession, exact);
    expect(controller.activeSession, isNull);
    expect(controller.lastError!.cleanupRequired, isTrue);
    expect(stops, [exact]);
    expect(location.ends, [exact]);
  }

  setUp(() async {
    NativeOwnershipCoordinator.resetTestSimulation();
    location = GoOffLocationService();
    auth = fixtures.TestAuthService(fixtures.FakeUser(exact.uid));
    owner = exact;
    running = true;
    leaveResidue = failStop = throwStop = stopped = false;
    failRead = null;
    overridePostStopRunning = false;
    postStopRunningResponse = null;
    keepWorkerAfterStop = false;
    postStopOwnerReads = 0;
    verificationGate = null;
    stops.clear();
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (
      call,
    ) async {
      switch (call.method) {
        case 'getDurableOwner':
          location.events.add('owner');
          if (stopped) {
            postStopOwnerReads++;
            if (verificationGate != null) await verificationGate!.future;
            if (failRead == 'owner' ||
                (failRead == 'session' && postStopOwnerReads == 2)) {
              throw PlatformException(code: 'VERIFY_FAILED');
            }
          }
          final current = owner;
          return current == null
              ? null
              : DurableDutyOwnerRecord(
                  uid: current.uid,
                  sessionId: current.sessionId,
                  generation: current.generation,
                  lifecycleSeq: current.lifecycleSeq!,
                  startedAt: DateTime.utc(2026, 9, 30),
                ).encode();
        case 'isServiceRunning':
          location.events.add('running');
          if (stopped && failRead == 'running') {
            throw PlatformException(code: 'VERIFY_FAILED');
          }
          return stopped && overridePostStopRunning
              ? postStopRunningResponse
              : running;
        case 'atomicStopService':
          location.events.add('stop');
          final args = Map<String, dynamic>.from(call.arguments as Map);
          expect(args.keys.toSet(), {
            'expectedUid',
            'expectedSessionId',
            'expectedGeneration',
            'expectedLifecycleSeq',
          });
          final selector = DutySession(
            uid: args['expectedUid'] as String,
            sessionId: args['expectedSessionId'] as String,
            generation: args['expectedGeneration'] as int,
            lifecycleSeq: args['expectedLifecycleSeq'] as int,
          );
          stops.add(selector);
          stopped = true;
          if (throwStop) throw PlatformException(code: 'STOP_THROWN');
          if (failStop) return {'success': false, 'stopped': false};
          if (owner != selector) {
            return {'success': true, 'stopped': false, 'reason': 'mismatch'};
          }
          if (!leaveResidue) {
            owner = null;
            if (!keepWorkerAfterStop) running = false;
          }
          return {'success': true, 'stopped': true};
        default:
          throw StateError('Unexpected native call: ${call.method}');
      }
    });
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(profile);
    await controller.reconcileDutyState();
    expect(controller.isReady, isTrue);
    expect(controller.activeSession, exact);
    location.events.clear();
  });

  tearDown(() {
    controller.dispose();
    auth.dispose();
    messenger.setMockMethodCallHandler(
      NativeOwnershipCoordinator.channel,
      null,
    );
    NativeOwnershipCoordinator.resetTestSimulation();
  });

  test('M4-GOOFF-NULL-1 null running response cannot prove absence', () async {
    overridePostStopRunning = true;
    keepWorkerAfterStop = true;
    expect(await controller.requestGoOffDuty(), isFalse);
    expectActionable();
    expect(owner, isNull);
    expect(running, isTrue);
  });

  test('M4-GOOFF-NULL-2 definitive false permits clean OFF', () async {
    overridePostStopRunning = true;
    postStopRunningResponse = false;
    expect(await controller.requestGoOffDuty(), isTrue);
    expect(stops, [exact]);
    expect(location.ends, [exact]);
    expectClean();
  });

  test('M4-GOOFF-NULL-3 true with absent owner remains residual', () async {
    overridePostStopRunning = true;
    postStopRunningResponse = true;
    keepWorkerAfterStop = true;
    expect(await controller.requestGoOffDuty(), isFalse);
    expectActionable();
    expect(owner, isNull);
    expect(running, isTrue);
  });

  test('M4-GOOFF-NULL-4 thrown running read retains cleanup', () async {
    failRead = 'running';
    keepWorkerAfterStop = true;
    expect(await controller.requestGoOffDuty(), isFalse);
    expectActionable();
    expect(owner, isNull);
    expect(running, isTrue);
  });

  test('M4-GOOFF-NULL-5 wrong-type channel response fails closed', () async {
    // StandardMethodCodec can decode a string; invokeMethod<bool> rejects it.
    overridePostStopRunning = true;
    postStopRunningResponse = 'false';
    keepWorkerAfterStop = true;
    expect(await controller.requestGoOffDuty(), isFalse);
    expectActionable();
    expect(owner, isNull);
    expect(running, isTrue);
  });

  test('M4-GOOFF-NULL-6 exact retry clears unknown only after proof', () async {
    overridePostStopRunning = true;
    keepWorkerAfterStop = true;
    expect(await controller.requestGoOffDuty(), isFalse);
    expectActionable();
    expect(owner, isNull);
    expect(running, isTrue);
    // Native status becomes definitive only once the controlled worker exits.
    running = false;
    postStopRunningResponse = false;
    expect(await controller.retryCleanup(), isTrue);
    expect(stops, [exact, exact]);
    expect(location.ends, [exact]);
    expectClean();
  });

  test(
    'M4-GOOFF-1 normal END -> exact STOP -> verified absence -> clean OFF',
    () async {
      expect(await controller.requestGoOffDuty(), isTrue);
      expect(location.ends, [exact]);
      expect(stops, [exact]);
      expect(location.events, [
        'end',
        'running',
        'stop',
        'owner',
        'owner',
        'running',
        'owner',
      ]);
      expectClean();
    },
  );

  test(
    'M4-GOOFF-1 clean OFF waits for verification and retains exact selector',
    () async {
      verificationGate = Completer<void>();
      final result = controller.requestGoOffDuty();
      while (postStopOwnerReads == 0) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(controller.pendingCleanupSession, exact);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      verificationGate!.complete();
      expect(await result, isTrue);
      expectClean();
    },
  );

  test(
    'M4-GOOFF-2 success=true stopped=true but exact ACTIVE owner/worker survive',
    () async {
      leaveResidue = true;
      expect(await controller.requestGoOffDuty(), isFalse);
      expectActionable();
      expect(owner, exact);
      expect(running, isTrue);
      expect(location.events, [
        'end',
        'running',
        'stop',
        'owner',
        'owner',
        'running',
      ]);
      leaveResidue = false;
      expect(await controller.retryCleanup(), isTrue);
      expect(stops, [exact, exact]);
      expectClean();
    },
  );

  for (final throws in [false, true]) {
    test(
      'M4-GOOFF-3 native STOP ${throws ? 'throws' : 'fails'} retains retry',
      () async {
        throwStop = throws;
        failStop = !throws;
        expect(await controller.requestGoOffDuty(), isFalse);
        expectActionable();
        expect(owner, exact);
        expect(running, isTrue);
        throwStop = failStop = false;
        expect(await controller.retryCleanup(), isTrue);
        expect(stops, [exact, exact]);
        expectClean();
      },
    );
  }

  for (final read in ['owner', 'session', 'running']) {
    test(
      'M4-GOOFF-4 post-STOP $read verification failure retains retry',
      () async {
        failRead = read;
        expect(await controller.requestGoOffDuty(), isFalse);
        expectActionable();
        failRead = null;
        expect(await controller.retryCleanup(), isTrue);
        expectClean();
      },
    );
  }

  test('M4-GOOFF-5 server END failure never attempts native STOP', () async {
    location.failEnd = true;
    expect(await controller.requestGoOffDuty(), isFalse);
    expect(location.serverOn, isTrue);
    expect(location.events, ['end']);
    expect(stops, isEmpty);
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
    expect(controller.activeSession, exact);
    expect(controller.pendingCleanupSession, isNull);
    expect(owner, exact);
    expect(running, isTrue);
  });

  for (final replacement in [
    const DutySession(
      uid: 'm5-driver',
      sessionId: 'm5-session',
      generation: 2,
      lifecycleSeq: 8,
    ),
    const DutySession(
      uid: 'driver-B',
      sessionId: 'session-B',
      generation: 3,
      lifecycleSeq: 8,
    ),
  ]) {
    test(
      'M4-GOOFF-${replacement.uid == exact.uid ? '6' : '7'} preserves replacement ${replacement.uid}/L8',
      () async {
        location.afterEnd = () => owner = replacement;
        expect(await controller.requestGoOffDuty(), isFalse);
        expectActionable();
        expect(owner, replacement);
        expect(running, isTrue);
        expect(await controller.retryCleanup(), isFalse);
        expect(stops, [exact, exact]);
        expect(owner, replacement);
        expect(controller.pendingCleanupSession, exact);
      },
    );
  }

  test('M4-GOOFF-2 worker alone surviving STOP blocks clean OFF', () async {
    location.afterEnd = () => owner = null;
    expect(await controller.requestGoOffDuty(), isFalse);
    expectActionable();
    expect(running, isTrue);
  });

  test(
    'M4-GOOFF-2 durable owner alone surviving STOP blocks clean OFF',
    () async {
      leaveResidue = true;
      location.afterEnd = () => running = false;
      expect(await controller.requestGoOffDuty(), isFalse);
      expectActionable();
      expect(owner, exact);
      expect(running, isFalse);
    },
  );
}
