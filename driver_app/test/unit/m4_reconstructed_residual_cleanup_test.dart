import 'dart:async';

import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:flutter_test/flutter_test.dart';

import 'duty_controller_test.dart' as f;

class ResidualLocationService extends f.TestLocationService {
  final events = <String>[];
  final ends = <DutySession>[];
  DutySession? replacement;
  bool failStop = false;
  bool leaveResidue = false;
  bool failEnd = false;
  bool failVerification = false;
  Completer<void>? verificationGate;
  bool serverOn = true;
  bool useNativeRunningRead = false;

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
    if (failEnd) throw StateError('server end failed');
    serverOn = false;
    if (replacement != null) durableSession = replacement;
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    events.add('stop');
    // Reject every partial selector. Model native's atomic four-field fence.
    expect(expectedUid, isNotNull);
    expect(expectedGeneration, isNotNull);
    expect(expectedLifecycleSeq, isNotNull);
    exactStopRequests.add(
      DutySession(
        uid: expectedUid!,
        sessionId: expectedSessionId,
        generation: expectedGeneration!,
        lifecycleSeq: expectedLifecycleSeq,
      ),
    );
    if (failStop) throw StateError('exact native stop failed');
    final owner = durableSession;
    if (owner != null &&
        (owner.uid != expectedUid ||
            owner.sessionId != expectedSessionId ||
            owner.generation != expectedGeneration ||
            owner.lifecycleSeq != expectedLifecycleSeq)) {
      return;
    }
    if (!leaveResidue) {
      durableSession = null;
      serviceRunning = false;
    }
  }

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    events.add(serverOn ? 'initial-owner' : 'verify-owner');
    if (!serverOn) {
      if (failVerification) throw StateError('durable verification failed');
      if (verificationGate != null) await verificationGate!.future;
    }
    return super.getDurableOwnerRecord();
  }

  @override
  Future<DutySession?> getDurableSession() async {
    events.add(serverOn ? 'initial-session' : 'verify-session');
    return super.getDurableSession();
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    events.add(serverOn ? 'initial-running' : 'verify-running');
    if (!serverOn && useNativeRunningRead) {
      return NativeOwnershipCoordinator.isServiceRunning();
    }
    return serviceRunning;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const exact = DutySession(
    uid: 'audit-driver',
    sessionId: 'audit-session',
    generation: 2,
    lifecycleSeq: 7,
  );
  const cached = DriverProfile(
    uid: 'audit-driver',
    name: 'Driver',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 AB 1234',
    verificationStatus: 'approved',
  );
  late ResidualLocationService location;
  late f.TestAuthService auth;
  late DutyController controller;

  void expectExact(DutySession? session) {
    expect(session, isNotNull);
    expect(session!.uid, exact.uid);
    expect(session.sessionId, exact.sessionId);
    expect(session.generation, 2);
    expect(session.lifecycleSeq, 7);
  }

  void expectActionable() {
    expect(location.serverOn, isFalse);
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
    expect(controller.isCleanupRequired, isTrue);
    expect(controller.activeSession, isNull);
    expectExact(controller.pendingCleanupSession);
    expectExact(location.exactStopRequests.single);
  }

  void expectClean() {
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(controller.trackingHealth, TrackingHealth.off);
    expect(controller.isCleanupRequired, isFalse);
    expect(controller.pendingCleanupSession, isNull);
    expect(controller.activeSession, isNull);
    expect(controller.activeLifecycleSeq, isNull);
    expect(location.durableSession, isNull);
    expect(location.serviceRunning, isFalse);
  }

  setUp(() {
    location = ResidualLocationService()
      ..durableSession = exact
      ..serviceRunning = true
      // Deliberately unrelated volatile sequence must never select server end.
      ..mockLifecycleSeq = 99
      ..serverDriverState = {
        'name': cached.name,
        'phone': cached.phone,
        'truckType': cached.truckType.backendValue,
        'vehicleNumber': cached.vehicleNumber,
        'uid': exact.uid,
        'verificationStatus': 'rejected',
        'isOnDuty': true,
        'activeDutySessionId': exact.sessionId,
        'dutyGeneration': 2,
        'lifecycleSeq': 7,
        'workerReady': true,
      };
    auth = f.TestAuthService(f.FakeUser(exact.uid));
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(cached);
    expect(controller.activeSession, isNull);
  });

  tearDown(() {
    controller.dispose();
    auth.dispose();
    messenger.setMockMethodCallHandler(
      NativeOwnershipCoordinator.channel,
      null,
    );
  });

  for (final response in [null, 'false']) {
    test(
      'R13 unknown native running response $response retains exact retry',
      () async {
        location.useNativeRunningRead = true;
        messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (
          call,
        ) async {
          expect(call.method, 'isServiceRunning');
          return response;
        });
        await controller.reconcileDutyState();
        expectActionable();
        expect(location.durableSession, isNull);
        expect(controller.lastError!.cleanupRequired, isTrue);
        messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (
          call,
        ) async {
          expect(call.method, 'isServiceRunning');
          return false;
        });
        expect(await controller.retryCleanup(), isTrue);
        expect(location.exactStopRequests, [exact, exact]);
        expectClean();
      },
    );
  }

  test(
    'M4-RESIDUAL-1 reconstructed exact owner stops after server end',
    () async {
      await controller.reconcileDutyState();
      expectExact(location.ends.single);
      expectExact(location.exactStopRequests.single);
      expect(location.events, [
        'initial-owner',
        'initial-session',
        'initial-running',
        'end',
        'stop',
        'verify-owner',
        'verify-session',
        'verify-running',
        'verify-owner',
      ]);
      expectClean();
    },
  );

  test('M4-RESIDUAL-2 STOP failure retains exact actionable retry', () async {
    location.failStop = true;
    await controller.reconcileDutyState();
    expectActionable();
    expect(location.serviceRunning, isTrue);
    expectExact(location.durableSession);
    expect(controller.lastError!.cleanupRequired, isTrue);
    location.failStop = false;
    expect(await controller.retryCleanup(), isTrue);
    expectExact(location.exactStopRequests.last);
    expectClean();
  });

  test(
    'M4-RESIDUAL-3 successful STOP with durable residue stays actionable',
    () async {
      location.leaveResidue = true;
      await controller.reconcileDutyState();
      expectActionable();
      expectExact(location.durableSession);
      expect(location.events, contains('verify-owner'));
    },
  );

  test('M4-RESIDUAL-4 clean OFF waits for verified absence', () async {
    final gate = Completer<void>();
    location.verificationGate = gate;
    final reconcile = controller.reconcileDutyState();
    while (!location.events.contains('verify-owner')) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(controller.trackingHealth, isNot(TrackingHealth.off));
    gate.complete();
    await reconcile;
    expectClean();
  });

  test('M4-RESIDUAL-5 exact L7 selector preserves newer same-UID L8', () async {
    location.replacement = const DutySession(
      uid: 'audit-driver',
      sessionId: 'audit-session',
      generation: 2,
      lifecycleSeq: 8,
    );
    await controller.reconcileDutyState();
    expectActionable();
    expect(location.durableSession, same(location.replacement));
    expect(location.serviceRunning, isTrue);
  });

  test('M4-RESIDUAL-6 A selector preserves replacement UID B', () async {
    location.replacement = const DutySession(
      uid: 'driver-B',
      sessionId: 'session-B',
      generation: 3,
      lifecycleSeq: 8,
    );
    await controller.reconcileDutyState();
    expectActionable();
    expect(location.durableSession, same(location.replacement));
    expect(location.serviceRunning, isTrue);
  });

  test('M4-RESIDUAL server end failure cannot trigger native STOP', () async {
    location.failEnd = true;
    await controller.reconcileDutyState();
    expect(location.exactStopRequests, isEmpty);
    expect(location.serverOn, isTrue);
    expectExact(location.durableSession);
    expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
  });

  test(
    'M4-RESIDUAL failed durable verification cannot claim absence',
    () async {
      location.failVerification = true;
      await controller.reconcileDutyState();
      expectActionable();
    },
  );
}
