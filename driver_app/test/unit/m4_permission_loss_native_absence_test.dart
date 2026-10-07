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
class PermissionLossLocationService extends DriverLocationService {
  final events = <String>[];
  final ends = <DutySession>[];
  bool serverOn = true;
  bool permissionLost = false;
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
  Future<LocationPermissionStatus> checkPermission() async => permissionLost
      ? LocationPermissionStatus.denied
      : LocationPermissionStatus.granted;

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
  late PermissionLossLocationService location;
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
    location = PermissionLossLocationService();
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
    location.permissionLost = true;
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

  test(
    'PL-ABS-1 END -> exact STOP -> strict verification -> clean OFF',
    () async {
      await controller.reconcileDutyState();
      expectClean();
      final end = location.events.indexOf('end');
      final stop = location.events.indexOf('stop');
      expect(end, greaterThanOrEqualTo(0));
      expect(stop, greaterThan(end));
      expect(location.events.sublist(stop + 1), ['owner', 'owner', 'running', 'owner']);
      expect(location.ends, [exact]);
      expect(stops, [exact]);
    },
  );

  for (final response in [null, true]) {
    test(
      'PL-ABS-${response == null ? 2 : 3} STOP success + running $response',
      () async {
        overridePostStopRunning = true;
        postStopRunningResponse = response;
        keepWorkerAfterStop = true;
        await controller.reconcileDutyState();
        expectActionable();
        expect(owner, isNull);
        expect(running, isTrue);
        expect(location.events.last, 'running');
      },
    );
  }

  test('PL-ABS-4 running read throws', () async {
    failRead = 'running';
    keepWorkerAfterStop = true;
    await controller.reconcileDutyState();
    expectActionable();
  });

  for (final throws in [false, true]) {
    test('PL-ABS-5 STOP ${throws ? 'throws' : 'fails'}', () async {
      throwStop = throws;
      failStop = !throws;
      await controller.reconcileDutyState();
      expectActionable();
      expect(owner, exact);
      expect(running, isTrue);
    });
  }

  test('PL-ABS-6 END failure never native STOP', () async {
    location.failEnd = true;
    await controller.reconcileDutyState();
    expect(stops, isEmpty);
    expect(location.serverOn, isTrue);
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
    expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
    expect(controller.activeSession, exact);
    expect(controller.pendingCleanupSession, isNull);
    expect(owner, exact);
    expect(running, isTrue);
  });

  test('PL-ABS-7 exact retry after unknown verifies absence', () async {
    overridePostStopRunning = true;
    keepWorkerAfterStop = true;
    await controller.reconcileDutyState();
    expectActionable();
    running = false;
    postStopRunningResponse = false;
    expect(await controller.retryCleanup(), isTrue);
    expect(stops, [exact, exact]);
    expect(location.ends, [exact]);
    expectClean();
  });

  for (final replacement in [
    exact.copyWith(lifecycleSeq: 8),
    const DutySession(
      uid: 'driver-B',
      sessionId: 'session-B',
      generation: 3,
      lifecycleSeq: 8,
    ),
  ]) {
    test(
      'PL-ABS-${replacement.uid == exact.uid ? 8 : 9} replacement survives',
      () async {
        location.afterEnd = () => owner = replacement;
        await controller.reconcileDutyState();
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

  test('PL-ABS verification waits with exact actionable authority', () async {
    verificationGate = Completer<void>();
    final result = controller.reconcileDutyState();
    while (postStopOwnerReads == 0) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(controller.pendingCleanupSession, exact);
    expect(controller.isCleanupRequired, isTrue);
    expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
    verificationGate!.complete();
    await result;
    expectClean();
  });
}
