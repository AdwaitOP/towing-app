import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:driver_app/features/hub/models/hub_error_category.dart';

import 'duty_controller_test.dart' as f;

class M4AcceptanceAuthService extends f.TestAuthService {
  bool signOutCalled = false;
  int signOutCallCount = 0;
  Completer<void>? pendingSignOutCompleter;

  M4AcceptanceAuthService([super.mockUser]);

  @override
  Future<void> signOut() async {
    signOutCalled = true;
    signOutCallCount++;
    if (pendingSignOutCompleter != null) {
      await pendingSignOutCompleter!.future;
    }
    emitUser(null);
  }
}

class M4AcceptanceLocationService extends f.TestLocationService {
  Completer<void>? pendingStopServiceCompleter;
  Completer<void>? pendingBeforeStartService;
  Completer<void>? pendingBeforePrepareActivation;
  Completer<void>? pendingBeforeStartDutySessionCall;
  Exception? throwOnGetDurableOwner;
  final List<Completer<void>> heldDurableOwnerReads = [];
  int durableOwnerReadsStarted = 0;
  Exception? throwOnIsServiceRunning;
  Exception? throwOnStartDutySessionCall;

  M4AcceptanceLocationService() {
    currentPos = DriverPosition(
      latitude: 18.5204,
      longitude: 73.8567,
      timestamp: DateTime.utc(2026, 9, 13, 12, 0, 0),
    );
  }

  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async {
    if (pendingBeforeStartDutySessionCall != null) {
      await pendingBeforeStartDutySessionCall!.future;
    }
    if (throwOnStartDutySessionCall != null) {
      throw throwOnStartDutySessionCall!;
    }
    return super.startDutySessionCall(
      uid: uid,
      sessionId: sessionId,
      initialLocation: initialLocation,
      lifecycleSeq: lifecycleSeq,
      generation: generation,
      attemptSeq: attemptSeq,
    );
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    if (throwOnIsServiceRunning != null) throw throwOnIsServiceRunning!;
    return super.isForegroundServiceRunning();
  }

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    durableOwnerReadsStarted++;
    if (heldDurableOwnerReads.isNotEmpty) {
      await heldDurableOwnerReads.removeAt(0).future;
    }
    if (throwOnGetDurableOwner != null) throw throwOnGetDurableOwner!;
    return super.getDurableOwnerRecord();
  }

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    if (pendingBeforePrepareActivation != null) {
      await pendingBeforePrepareActivation!.future;
    }
    operationLog.add('prepareDutyActivation:$uid');
    return super.prepareDutyActivation(uid: uid, clientRequestId: clientRequestId);
  }

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    if (pendingBeforeStartService != null) {
      await pendingBeforeStartService!.future;
    }
    return super.startForegroundService(
      session: session,
      notificationTitle: notificationTitle,
      notificationText: notificationText,
      onAuthorityAllocated: onAuthorityAllocated,
    );
  }

  final List<Map<String, dynamic>> stopCalls = [];

  bool simulatedStopLeavesServiceRunning = false;

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    stopCalls.add({
      'expectedUid': expectedUid,
      'expectedSessionId': expectedSessionId,
      'expectedLifecycleSeq': expectedLifecycleSeq,
      'expectedGeneration': expectedGeneration,
    });
    if (pendingStopServiceCompleter != null) {
      await pendingStopServiceCompleter!.future;
    }
    await super.stopForegroundService(
      expectedUid: expectedUid,
      expectedSessionId: expectedSessionId,
      expectedLifecycleSeq: expectedLifecycleSeq,
      expectedGeneration: expectedGeneration,
    );
    if (simulatedStopLeavesServiceRunning) {
      serviceRunning = true;
    } else {
      durableOwnerRecord = null;
    }
  }
}

void main() {
  const testUid = 'driver_m4_001';
  final baseProfile = DriverProfile(
    uid: testUid,
    name: 'M4 Test Driver',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 AB 1234',
    isOnDuty: false,
    verificationStatus: 'approved',
  );

  Map<String, dynamic> makeDriverDoc(DriverProfile p) => {
    'uid': p.uid,
    'name': p.name,
    'phone': p.phone,
    'truckType': p.truckType.backendValue,
    'vehicleNumber': p.vehicleNumber,
    'isOnDuty': p.isOnDuty,
    'verificationStatus': p.verificationStatus,
    'activeJobId': p.activeJobId,
    'activeOfferId': p.activeOfferId,
    'activeDutySessionId': p.activeDutySessionId,
    'dutyGeneration': p.dutyGeneration,
    'lifecycleSeq': p.lifecycleSeq,
    'workerReady': p.workerReady,
  };

  tearDown(() {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
  });

  group('Gate M4-A: Cold-Start / Reconnection Reconciliation Matrix (Cases 1-10)', () {
    test('Case 1: Firestore OFF / Native ABSENT -> Authority OFF, Worker STOPPED, toggle enabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = false;
      loc.currentSession = null;
      loc.durableOwnerRecord = null;

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: false));

      // A clean OFF conclusion requires a current server read, even with no worker.
      loc.serverDriverState = makeDriverDoc(baseProfile);

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isOnDuty, isFalse);
      expect(controller.isCleanupRequired, isFalse);
      expect(controller.canToggleDuty, isTrue);
      expect(loc.serviceRunning, isFalse);
    });

    test('Case 2: Firestore OFF / Native RUNNING (cleanable) -> Stale cleanup, Authority OFF, toggle enabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_stale_1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: false));

      // Native cleanup must be authorized by explicit fresh OFF state.
      loc.serverDriverState = makeDriverDoc(baseProfile);

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isOnDuty, isFalse);
      expect(controller.isCleanupRequired, isFalse);
      expect(controller.canToggleDuty, isTrue);
      expect(loc.serviceRunning, isFalse);
      expect(loc.operationLog.any((op) => op.contains('stopForegroundService:sess_stale_1')), isTrue);
    });

    test('Case 3: Firestore OFF / Native RUNNING (uncleanable, stop throws) -> Authority OFF, cleanup required, toggle disabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_stale_2',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.throwOnStopService = Exception('Native stop failure simulated');
      loc.serverDriverState = makeDriverDoc(baseProfile);

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: false));

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isOnDuty, isFalse);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.canToggleDuty, isFalse);
    });

    test('Case 4: fresh older ON S1 / newer native S2 -> preserve newer worker and fail closed', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_s2_native',
        uid: testUid,
        generation: 2,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1_server',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1_server',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      // Authority reflects server ON, tracking health is failed, cleanup required, toggle disabled
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.canToggleDuty, isFalse);
      expect(loc.operationLog.any((op) => op.contains('stopForegroundService:sess_s2_native')), isFalse);
    });

    test('Case 5: Firestore ON (S1) / Native STOPPED -> Fail closed, Authority ON, reconciliationFailed, toggle disabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = false;
      loc.durableOwnerRecord = null;

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1_server',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1_server',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.canToggleDuty, isFalse);
    });

    test('Case 6: Firestore ON (S1) / Native RUNNING (S1) matching 4-tuple, Worker bootstrap confirmed -> Authority ON, healthy, toggle enabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_s1_matched',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1_matched',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1_matched',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.isOnDuty, isTrue);
      expect(controller.trackingHealth, TrackingHealth.healthy);
      expect(controller.isReady, isTrue);
      expect(controller.isCleanupRequired, isFalse);
      expect(controller.canToggleDuty, isTrue);
    });

    test('Case 7: Firestore ON (S1) / Native RUNNING (S1) matching 4-tuple, Worker bootstrap failed -> WorkerBootstrapCleanup, Authority OFF, cleanup required', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_s1_bootstrap_fail',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1_bootstrap_fail',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1_bootstrap_fail',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      // Simulate bootstrap failure where required permissions are revoked
      loc.checkPermResult = LocationPermissionStatus.denied;

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.errorCategory, HubErrorCategory.foregroundPermissionDenied);
      expect(loc.serviceRunning, isFalse);
    });

    test('Case 8: Firestore UNKNOWN (no profile loaded yet) -> Authority UNKNOWN, worker preserved, toggle disabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_unknown_worker',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown);
      expect(controller.canToggleDuty, isFalse);
    });

    test('Case 9: In-flight go-off during reconciliation -> Reconcile does not overwrite go-off intent', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.pendingStopServiceCompleter = Completer<void>();
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_in_flight',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_in_flight',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_in_flight',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));
      await controller.reconcileDutyState();

      // Start go-off
      final goOffFuture = controller.requestGoOffDuty();
      final reconcileFuture = controller.reconcileDutyState();

      // The successful OFF transaction changes the authoritative server state.
      loc.serverDriverState = makeDriverDoc(baseProfile);

      // Release stop
      loc.pendingStopServiceCompleter!.complete();
      await goOffFuture;
      await reconcileFuture;

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isOnDuty, isFalse);
    });

    test('Case 10: In-flight go-on during reconciliation -> Reconcile does not duplicate worker launch', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: false));

      final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      final reconcileFuture = controller.reconcileDutyState();
      await goOnFuture;
      await reconcileFuture;

      expect(loc.operationLog.where((op) => op.startsWith('startForegroundService')).length, 1);
    });
  });

  group('Gate M4-B: Readiness Gating & Duty State Transitions', () {
    test('workerReady = false retains onDuty authoritative state but isReady is false', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      final session = controller.activeSession!;

      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: session.sessionId,
        dutyGeneration: session.generation,
        lifecycleSeq: session.lifecycleSeq,
        workerReady: false,
      ));

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.isReady, isFalse);

      // Now update with workerReady = true
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: session.sessionId,
        dutyGeneration: session.generation,
        lifecycleSeq: session.lifecycleSeq,
        workerReady: true,
      ));

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.isReady, isTrue);
    });

    test('canToggleDuty disables during in flight, reconciling, unknown, cleanup required, and logout in progress', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);
      loc.serverDriverState = makeDriverDoc(baseProfile);
      await controller.reconcileDutyState();
      expect(controller.canToggleDuty, isTrue);

      // Set logout in progress
      final barrier = controller.beginLogoutBarrier(testUid);
      expect(controller.canToggleDuty, isFalse);
      controller.endLogoutBarrier(barrier);
      expect(controller.canToggleDuty, isTrue);

      // Residual cleanup required disables toggle
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_unclean',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.throwOnStopService = Exception('Cleanup fail');
      await controller.reconcileDutyState();
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.canToggleDuty, isFalse);
    });
  });

  group('Gate M4-C: Go-On Serialization & Authority Handshake', () {
    test('strict sequence: server prepare -> native start -> worker readiness', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final success = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(success, isTrue);

      final ops = loc.operationLog;
      final prepIdx = ops.indexWhere((op) => op.startsWith('prepareDutyActivation'));
      final startNativeIdx = ops.indexWhere((op) => op.startsWith('startForegroundService'));
      final startSessionIdx = ops.indexWhere((op) => op.startsWith('startDutySessionCall'));

      expect(prepIdx, isNot(-1));
      expect(startNativeIdx, isNot(-1));
      expect(startSessionIdx, isNot(-1));
      expect(prepIdx, lessThan(startNativeIdx));
      expect(startNativeIdx, lessThan(startSessionIdx));
    });

    test('failure during native start cleans up server lease and remains OFF', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.throwOnStartService = Exception('Native start failed');

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final success = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(success, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(loc.cancelActivationCalls, isNotEmpty);
    });

    test('duplicate go-on gesture rejected while first is in flight', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final first = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      final second = controller.requestGoOnDuty(onShowDisclosure: () async => true);

      final resFirst = await first;
      final resSecond = await second;

      expect(resFirst, isTrue);
      expect(resSecond, isFalse);
    });
  });

  group('Gate M4-D: Go-Off Ordering & Worker Teardown', () {
    test('strict sequence: server end duty called before native service stop', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      loc.operationLog.clear();

      final offSuccess = await controller.requestGoOffDuty();
      expect(offSuccess, isTrue);

      final ops = loc.operationLog;
      final endServerIdx = ops.indexWhere((op) => op.startsWith('endDutySessionCall'));
      final stopNativeIdx = ops.indexWhere((op) => op.startsWith('stopForegroundService'));

      expect(endServerIdx, isNot(-1));
      expect(stopNativeIdx, isNot(-1));
      expect(endServerIdx, lessThan(stopNativeIdx));
    });

    test('server end failure keeps native worker running and retains authoritative ON', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      loc.throwOnOffDutyTx = true;
      final offSuccess = await controller.requestGoOffDuty();

      expect(offSuccess, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(loc.serviceRunning, isTrue);
    });

    test('server end success + native stop failure sets authoritative OFF and cleanupRequired = true', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      loc.throwOnStopService = Exception('Native stop failure');
      final offSuccess = await controller.requestGoOffDuty();

      expect(offSuccess, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.canToggleDuty, isFalse);
    });
  });

  group('Gate M4-E: Stale Snapshot & Race Resistance', () {
    test('stale profile snapshot carrying lower generation than active session is rejected', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final goOnRes = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(goOnRes, isTrue);
      expect(controller.isOnDuty, isTrue);
      final activeGen = controller.activeSession!.generation;

      // Stale snapshot with generation lower than active session
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: false,
        dutyGeneration: activeGen - 1,
      ));

      // Should remain ON and not be corrupted by stale snapshot
      expect(controller.isOnDuty, isTrue);
    });

    test('logout barrier blocks incoming duty state changes', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      controller.beginLogoutBarrier(testUid);

      // Attempt go on duty while logout barrier active
      final onRes = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(onRes, isFalse);
      expect(controller.isOnDuty, isFalse);

      // Snapshot update should also be ignored
      controller.updateProfile(baseProfile.copyWith(isOnDuty: true));
      expect(controller.isOnDuty, isFalse);
    });
  });

  group('Gate M4-F: Engagement Guards & Operation Refusal', () {
    test('active job blocks go-off with cannotGoOffDutyActiveJob', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final goOnRes = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(goOnRes, isTrue);

      // Assign active job
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeJobId: 'job_456',
        dutyGeneration: controller.activeSession!.generation,
      ));

      final success = await controller.requestGoOffDuty();
      expect(success, isFalse);
      expect(controller.errorCategory, HubErrorCategory.activeJobPreventOffDuty);
      expect(controller.isOnDuty, isTrue);
    });

    test('active offer blocks go-off with activeOfferPreventOffDuty', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final goOnRes = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(goOnRes, isTrue);

      // Assign active offer
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeOfferId: 'offer_789',
        dutyGeneration: controller.activeSession!.generation,
      ));

      final success = await controller.requestGoOffDuty();
      expect(success, isFalse);
      expect(controller.errorCategory, HubErrorCategory.activeOfferPreventOffDuty);
      expect(controller.isOnDuty, isTrue);
    });

    test('active job and offer block logout in AppLogoutCoordinator', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);

      // Active job blocks logout
      final jobProfile = baseProfile.copyWith(activeJobId: 'job_active');
      loc.serverDriverState = makeDriverDoc(jobProfile);
      final resJob = await coordinator.coordinateLogout(profile: jobProfile);
      expect(resJob, LogoutResult.blockedActiveJob);
      expect(auth.signOutCalled, isFalse);

      // Active offer blocks logout
      final offerProfile = baseProfile.copyWith(activeOfferId: 'offer_active');
      loc.serverDriverState = makeDriverDoc(offerProfile);
      final resOffer = await coordinator.coordinateLogout(profile: offerProfile);
      expect(resOffer, LogoutResult.blockedActiveOffer);
      expect(auth.signOutCalled, isFalse);
    });
  });

  group('Gate M4-G: Logout Ordering & Non-Hub Defensive Signout', () {
    test('G4: wrong UID or malformed fresh profile blocks cached OFF logout', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);
      final cached = baseProfile.copyWith(isOnDuty: false);

      loc.serverDriverState = makeDriverDoc(cached)..['uid'] = 'other_uid';
      expect(await coordinator.coordinateLogout(profile: cached), LogoutResult.failedDutyTransition);
      expect(auth.signOutCallCount, 0);

      loc.serverDriverState = makeDriverDoc(cached)..['isOnDuty'] = 'false';
      expect(await coordinator.coordinateLogout(profile: cached), LogoutResult.failedDutyTransition);
      expect(auth.signOutCallCount, 0);
    });

    for (final cachedOn in [false, true]) {
      test('null fresh state blocks cached ${cachedOn ? 'ON' : 'OFF'} logout', () async {
        final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
        final loc = M4AcceptanceLocationService();
        final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);

        final result = await coordinator.coordinateLogout(
          profile: baseProfile.copyWith(isOnDuty: cachedOn),
        );

        expect(result, LogoutResult.failedDutyTransition);
        expect(auth.signOutCallCount, 0);
        expect(loc.operationLog.where((op) =>
            op.startsWith('endDutySessionCall') ||
            op.startsWith('stopForegroundService')), isEmpty);
      });
    }

    test('non-hub logout with server ON performs server end and native stop before signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_non_hub',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );

      final onProfile = baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_non_hub',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      loc.serverDriverState = makeDriverDoc(onProfile);

      final coordinator = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
      );

      final result = await coordinator.coordinateLogout(profile: onProfile);

      expect(result, LogoutResult.success);
      expect(auth.signOutCalled, isTrue);
      expect(loc.operationLog.any((op) => op.contains('endDutySessionCall:sess_non_hub')), isTrue);
      expect(loc.operationLog.any((op) => op.contains('stopForegroundService:sess_non_hub')), isTrue);
      expect(loc.serviceRunning, isFalse);
    });

    test('non-hub logout failure on server end refuses signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.throwOnOffDutyTx = true;

      final onProfile = baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_non_hub_fail',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      loc.serverDriverState = makeDriverDoc(onProfile);

      final coordinator = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
      );

      final result = await coordinator.coordinateLogout(profile: onProfile);

      expect(result, LogoutResult.failedDutyTransition);
      expect(auth.signOutCalled, isFalse);
    });

    test('single-flight concurrency: concurrent calls join the existing in-flight logout', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      auth.pendingSignOutCompleter = Completer<void>();
      loc.serverDriverState = makeDriverDoc(baseProfile);

      final coordinator1 = AppLogoutCoordinator(authService: auth, locationService: loc);
      final coordinator2 = AppLogoutCoordinator(authService: auth, locationService: loc);

      final first = coordinator1.coordinateLogout(profile: baseProfile);
      final second = coordinator2.coordinateLogout(profile: baseProfile);

      // Complete sign-out
      auth.pendingSignOutCompleter!.complete();

      final res1 = await first;
      final res2 = await second;

      expect(res1, LogoutResult.success);
      expect(res2, LogoutResult.success);
      expect(auth.signOutCallCount, 1);
    });
  });

  group('Gate M4-H: Failure / Unknown Presentation & Residual Cleanup', () {
    test('clearError does NOT reset isCleanupRequired or re-enable duty toggle if cleanup needed', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_residual',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.throwOnStopService = Exception('Stop service failed');
      loc.serverDriverState = makeDriverDoc(baseProfile);

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: false));

      await controller.reconcileDutyState();

      expect(controller.isCleanupRequired, isTrue);
      expect(controller.canToggleDuty, isFalse);

      // Clear error presentation banner
      controller.clearError();

      // Residual cleanup requirement and disabled toggle MUST persist
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.canToggleDuty, isFalse);
    });

    test('retryCleanup successfully cleans up native worker and restores canToggleDuty = true', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_retry',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.throwOnStopService = Exception('First stop failed');
      loc.serverDriverState = makeDriverDoc(baseProfile);

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: false));

      await controller.reconcileDutyState();
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.canToggleDuty, isFalse);

      // Clear the simulated exception and retry
      loc.throwOnStopService = null;
      await controller.retryCleanup();

      expect(controller.isCleanupRequired, isFalse);
      expect(controller.canToggleDuty, isTrue);
      expect(loc.serviceRunning, isFalse);
    });
  });

  group('Mandatory Adversarial Regressions (21 Tests)', () {
    // 1. A-STALE-1: cached S1 profile vs fresh/native newer S2 — different session
    test('A-STALE-1: cached S1, fresh server S2, native S2 -> different sessionId, native S2 untouched', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_s2',
        uid: testUid,
        generation: 2,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s2',
        dutyGeneration: 2,
        lifecycleSeq: 2,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      expect(loc.operationLog.any((op) => op.contains('stopForegroundService:sess_s2')), isFalse);
      expect(controller.activeSession?.sessionId, 'sess_s2');
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.isCleanupRequired, isFalse);
    });

    // 2. A-STALE-2: same sessionId, cached lower generation vs fresh/native newer generation
    test('A-STALE-2: same sessionId, cached lower generation, fresh/native newer generation -> native S2 untouched', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_shared',
        uid: testUid,
        generation: 2,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_shared',
        dutyGeneration: 2,
        lifecycleSeq: 2,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_shared',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      expect(loc.operationLog.any((op) => op.contains('stopForegroundService')), isFalse);
      expect(controller.activeSession?.generation, 2);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
    });

    // 3. A-STALE-3: same UID/session/generation, stale wrong lifecycleSeq vs current exact worker
    test('A-STALE-3: same UID/session/generation, stale profile wrong lifecycleSeq, fresh/native current lifecycleSeq -> native untouched', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_same',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_same',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_same',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      expect(loc.operationLog.any((op) => op.contains('stopForegroundService')), isFalse);
      expect(controller.activeSession?.lifecycleSeq, 2);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
    });

    // 4. A-READ-FAIL: profile/native conflict + fresh server read throws
    test('A-READ-FAIL: profile/native conflict + fresh server read throws -> no stop, reconciliation failed/unknown, controls disabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_s2',
        uid: testUid,
        generation: 2,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.throwOnFetchServerState = true;

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_s1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      expect(loc.operationLog.any((op) => op.contains('stopForegroundService')), isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.canToggleDuty, isFalse);
    });

    // 5. B-LIFECYCLE-1: current worker L2, incoming same uid/session/gen but L1 + workerReady=true -> NOT READY
    test('B-LIFECYCLE-1: current worker L2, incoming same uid/session/gen but L1 + workerReady=true -> NOT READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      loc.mockLifecycleSeq = 2;
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.activeSession?.lifecycleSeq, 2);

      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: controller.activeSession!.sessionId,
        dutyGeneration: controller.activeSession!.generation,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.starting);
    });

    // 6. B-LIFECYCLE-2: current exact L2 + workerReady=true -> READY
    test('B-LIFECYCLE-2: current exact L2 + workerReady=true -> READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.mockLifecycleSeq = 2;
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: controller.activeSession!.sessionId,
        dutyGeneration: controller.activeSession!.generation,
        lifecycleSeq: 2,
        workerReady: true,
      ));

      expect(controller.isReady, isTrue);
      expect(controller.trackingHealth, TrackingHealth.healthy);
    });

    // 7. B-NULL: workerReady null/missing -> NOT READY
    test('B-NULL: workerReady null/missing -> NOT READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.mockLifecycleSeq = 2;
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: controller.activeSession!.sessionId,
        dutyGeneration: controller.activeSession!.generation,
        lifecycleSeq: 2,
        workerReady: null,
      ));

      expect(controller.isReady, isFalse);
    });

    // 8. E-LOGOUT-GOON: hold go-on before native start, start logout barrier, release go-on => 0 native start, 0 server start
    test('E-LOGOUT-GOON: hold go-on before native start, start logout barrier, release go-on -> 0 native start, 0 server start', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final holdCompleter = Completer<void>();
      loc.pendingBeforePrepareActivation = holdCompleter;

      final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 10));

      controller.beginLogoutBarrier(testUid);
      holdCompleter.complete();
      final result = await goOnFuture;

      expect(result, isFalse);
      expect(loc.operationLog.where((op) => op.startsWith('startForegroundService')).length, 0);
      expect(loc.operationLog.where((op) => op.startsWith('startDutySessionCall')).length, 0);
    });

    // 9. E-OFF-GOON: hold go-on, go-off supersedes it, release -> no stale activation
    test('E-OFF-GOON: hold go-on, go-off supersedes it, release -> no stale activation', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final holdCompleter = Completer<void>();
      loc.pendingBeforeStartService = holdCompleter;

      final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 10));

      final goOffFuture = controller.requestGoOffDuty();

      holdCompleter.complete();
      final goOnRes = await goOnFuture;
      await goOffFuture;

      expect(goOnRes, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    });

    // 10. E-UID: hold UID-A operation, switch auth to UID-B, release A -> B remains unchanged
    test('E-UID: hold UID-A operation, switch auth to UID-B, release A -> B remains unchanged', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser('driver_A'));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(uid: 'driver_A'));

      final holdCompleter = Completer<void>();
      loc.pendingBeforeStartService = holdCompleter;

      final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 10));

      auth.emitUser(f.FakeUser('driver_B'));
      controller.updateProfile(baseProfile.copyWith(uid: 'driver_B', isOnDuty: false));

      holdCompleter.complete();
      final res = await goOnFuture;

      expect(res, isFalse);
      expect(controller.boundUid, 'driver_B');
      expect(controller.isOnDuty, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    });

    // 11. E-PROFILE-1: exact newer OFF confirmed, late prior ON snapshot -> stays OFF
    test('E-PROFILE-1: exact newer OFF confirmed, late prior ON snapshot -> stays OFF', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: false));

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.isOnDuty, isTrue);

      await controller.requestGoOffDuty();
      expect(controller.isOnDuty, isFalse);

      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_older',
        dutyGeneration: 1,
      ));

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isOnDuty, isFalse);
    });

    // 12. E-PROFILE-2: current exact L2, late same-gen L1 workerReady=true -> not READY
    test('E-PROFILE-2: current exact L2, late same-gen L1 workerReady=true -> not READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.mockLifecycleSeq = 2;
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: controller.activeSession!.sessionId,
        dutyGeneration: controller.activeSession!.generation,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      expect(controller.isReady, isFalse);
    });

    // 13. E-PROFILE-3: current UID B, late UID A profile -> ignored/fenced
    test('E-PROFILE-3: current UID B, late UID A profile -> ignored/fenced', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser('driver_B'));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(uid: 'driver_B', isOnDuty: false));

      controller.updateProfile(baseProfile.copyWith(uid: 'driver_A', isOnDuty: true));

      expect(controller.currentProfile?.uid, 'driver_B');
      expect(controller.isOnDuty, isFalse);
    });

    // 14. D4-EXACT: local session null, durable owner exact S1/G/L exists -> exact native stop called with real tuple
    test('D4-EXACT: local session null, durable owner exact S1/G/L exists -> exact native stop called with real tuple', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_exact_d4',
        uid: testUid,
        generation: 3,
        lifecycleSeq: 4,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_exact_d4',
        dutyGeneration: 3,
        lifecycleSeq: 4,
      ));

      final success = await controller.requestGoOffDuty();

      expect(success, isTrue);
      expect(loc.operationLog.any((op) => op.contains('stopForegroundService:sess_exact_d4')), isTrue);
    });

    // 15. D4-READ-FAIL: local session null, durable-owner read throws -> no clean-success result, cleanup visible
    test('D4-READ-FAIL: local session null, durable-owner read throws -> no clean-success result, cleanup visible', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.throwOnGetDurableOwner = Exception('Durable owner read failure');

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: true));

      final success = await controller.requestGoOffDuty();

      expect(success, isFalse);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
    });

    // 16. D4-STOP-FAIL: exact durable owner found, stop fails -> OFF + cleanupRequired
    test('D4-STOP-FAIL: exact durable owner found, stop fails -> OFF + cleanupRequired', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_fail_stop',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.throwOnStopService = Exception('Stop service crash');

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_fail_stop',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      final success = await controller.requestGoOffDuty();

      expect(success, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isCleanupRequired, isTrue);
    });

    // 17. G-FRESH-1: cached OFF, fresh server ON -> teardown occurs before signOut
    test('G-FRESH-1: cached OFF, fresh server ON -> teardown occurs before signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_fresh_on',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_fresh_on',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);
      final res = await coordinator.coordinateLogout(profile: baseProfile.copyWith(isOnDuty: false));

      expect(res, LogoutResult.success);
      expect(loc.operationLog.any((op) => op.startsWith('endDutySessionCall')), isTrue);
      expect(loc.operationLog.any((op) => op.startsWith('stopForegroundService')), isTrue);
      expect(auth.signOutCallCount, 1);
    });

    // 18. G-FRESH-2: cached OFF, fresh server ON + active job -> logout blocked, no signOut
    test('G-FRESH-2: cached OFF, fresh server ON + active job -> logout blocked, no signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_job',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        activeJobId: 'job_active_123',
      ));

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);
      final res = await coordinator.coordinateLogout(profile: baseProfile.copyWith(isOnDuty: false));

      expect(res, LogoutResult.blockedActiveJob);
      expect(auth.signOutCallCount, 0);
    });

    // 19. G-FRESH-3: cached OFF, fresh server ON + active offer -> logout blocked, no signOut
    test('G-FRESH-3: cached OFF, fresh server ON + active offer -> logout blocked, no signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_offer',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        activeOfferId: 'offer_active_456',
      ));

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);
      final res = await coordinator.coordinateLogout(profile: baseProfile.copyWith(isOnDuty: false));

      expect(res, LogoutResult.blockedActiveOffer);
      expect(auth.signOutCallCount, 0);
    });

    // 20. G-FRESH-4: fresh server read throws -> no signOut
    test('G-FRESH-4: fresh server read throws -> no signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.throwOnFetchServerState = true;

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);
      final res = await coordinator.coordinateLogout(profile: baseProfile.copyWith(isOnDuty: false));

      expect(res, LogoutResult.failedDutyTransition);
      expect(auth.signOutCallCount, 0);
    });

    // 21. G-SF-1: two concurrent same-UID logout -> one effective teardown/signout
    test('G-SF-1: two concurrent same-UID logout -> one effective teardown/signout', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      auth.pendingSignOutCompleter = Completer<void>();
      loc.serverDriverState = makeDriverDoc(baseProfile);

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);
      final f1 = coordinator.coordinateLogout(profile: baseProfile.copyWith(isOnDuty: false));
      final f2 = coordinator.coordinateLogout(profile: baseProfile.copyWith(isOnDuty: false));

      auth.pendingSignOutCompleter!.complete();
      final r1 = await f1;
      final r2 = await f2;

      expect(r1, LogoutResult.success);
      expect(r2, LogoutResult.success);
      expect(auth.signOutCallCount, 1);
    });

    // 22. G-SF-2: concurrent UID A and UID B logout -> separate operations, each acts only on own UID
    test('G11B: stale UID-A native read failure cannot release shared controller UID-B barrier', () async {
      const uidA = 'g11b_uid_a';
      const uidB = 'g11b_uid_b';
      final auth = M4AcceptanceAuthService(f.FakeUser(uidA));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      final coordinator = AppLogoutCoordinator(
        authService: auth, locationService: loc, dutyController: controller,
      );
      final readA = Completer<void>();
      final readB = Completer<void>();
      loc.heldDurableOwnerReads.addAll([readA, readB]);
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(uid: uidA));

      final logoutA = coordinator.coordinateLogout();
      while (loc.durableOwnerReadsStarted < 1) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      expect(controller.isLogoutInProgress, isTrue);

      auth.emitUser(f.FakeUser(uidB));
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(uid: uidB));
      final logoutB = coordinator.coordinateLogout();
      while (loc.durableOwnerReadsStarted < 2) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      var bCompleted = false;
      logoutB.then((_) => bCompleted = true);

      readA.completeError(StateError('A native owner read failed'));
      expect(await logoutA, LogoutResult.failedDutyTransition);
      expect(bCompleted, isFalse);
      expect(controller.isLogoutInProgress, isTrue);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.errorCategory, isNull);
      expect(auth.signOutCallCount, 0);

      readB.complete();
      expect(await logoutB, LogoutResult.success);
      expect(auth.signOutCallCount, 1);
      expect(controller.isLogoutInProgress, isFalse);
    });

    test('G11C: stale same-UID barrier lease cannot release newer lease', () {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final controller = DutyController(
        locationService: M4AcceptanceLocationService(), authService: auth,
      );
      final oldLease = controller.beginLogoutBarrier(testUid);
      final newLease = controller.beginLogoutBarrier(testUid);
      controller.endLogoutBarrier(oldLease);
      expect(controller.isLogoutInProgress, isTrue);
      controller.endLogoutBarrier(newLease);
      expect(controller.isLogoutInProgress, isFalse);
    });

    test('G-SF-2: concurrent UID A and UID B logout -> separate operations, each acts only on own UID', () async {
      final authA = M4AcceptanceAuthService(f.FakeUser('uid_A'));
      final authB = M4AcceptanceAuthService(f.FakeUser('uid_B'));
      final locA = M4AcceptanceLocationService();
      final locB = M4AcceptanceLocationService();
      locA.serverDriverState = makeDriverDoc(baseProfile.copyWith(uid: 'uid_A'));
      locB.serverDriverState = makeDriverDoc(baseProfile.copyWith(uid: 'uid_B'));

      final coordinatorA = AppLogoutCoordinator(authService: authA, locationService: locA);
      final coordinatorB = AppLogoutCoordinator(authService: authB, locationService: locB);

      final fA = coordinatorA.coordinateLogout(profile: baseProfile.copyWith(uid: 'uid_A', isOnDuty: false));
      final fB = coordinatorB.coordinateLogout(profile: baseProfile.copyWith(uid: 'uid_B', isOnDuty: false));

      final rA = await fA;
      final rB = await fB;

      expect(rA, LogoutResult.success);
      expect(rB, LogoutResult.success);
      expect(authA.signOutCallCount, 1);
      expect(authB.signOutCallCount, 1);
    });

    // 23. G-SF-3: UID A failure then retry -> retry allowed, stale single-flight cleared
    test('G-SF-3: UID A failure then retry -> retry allowed, stale single-flight cleared', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.throwOnFetchServerState = true;

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc);
      final res1 = await coordinator.coordinateLogout(profile: baseProfile.copyWith(isOnDuty: false));
      expect(res1, LogoutResult.failedDutyTransition);

      // Clear error and retry
      loc.throwOnFetchServerState = false;
      loc.serverDriverState = makeDriverDoc(baseProfile);
      final res2 = await coordinator.coordinateLogout(profile: baseProfile.copyWith(isOnDuty: false));
      expect(res2, LogoutResult.success);
      expect(auth.signOutCallCount, 1);
    });

    // 24. G-BARRIER-1: go-on held before native start, logout begins, release -> no native start/server start
    test('G-BARRIER-1: go-on held before native start, logout begins, release -> no native start/server start', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final holdCompleter = Completer<void>();
      loc.pendingBeforePrepareActivation = holdCompleter;

      final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 10));

      controller.beginLogoutBarrier(testUid);
      holdCompleter.complete();

      final res = await goOnFuture;
      expect(res, isFalse);
      expect(loc.operationLog.where((op) => op.startsWith('startForegroundService')).isEmpty, isTrue);
    });

    // 25. G-BARRIER-2: logout barrier already active, new go-on -> immediate rejection/no activation call
    test('G-BARRIER-2: logout barrier already active, new go-on -> immediate rejection', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      controller.beginLogoutBarrier(testUid);
      final res = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      expect(res, isFalse);
      expect(loc.operationLog.where((op) => op.startsWith('prepareDutyActivation')).isEmpty, isTrue);
    });

    // 26. G-BARRIER-3: controller barrier cleanup truthful, does not revive superseded work
    test('G-BARRIER-3: controller barrier cleanup truthful, does not revive superseded work', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final barrier = controller.beginLogoutBarrier(testUid);
      controller.endLogoutBarrier(barrier);

      expect(controller.isOnDuty, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.canToggleDuty, isTrue);
    });

    // 27. H-READ-1: start from READY, service-state read throws during reconciliation -> not READY, reconciliation failed, toggle disabled
    test('H-READ-1: start from READY, service-state read throws during reconciliation -> not READY, reconciliation failed, toggle disabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_h1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_h1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_h1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));
      await controller.reconcileDutyState();
      expect(controller.isReady, isTrue);

      // Now service-state read throws
      loc.throwOnIsServiceRunning = Exception('Dead native channel');
      await controller.reconcileDutyState();

      expect(controller.isReady, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.canToggleDuty, isFalse);
    });

    // 28. H-READ-2: start from READY, durable-owner read throws during reconciliation -> not READY, reconciliation failed, toggle disabled
    test('H-READ-2: start from READY, durable-owner read throws during reconciliation -> not READY, reconciliation failed, toggle disabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_h2',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_h2',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_h2',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));
      await controller.reconcileDutyState();
      expect(controller.isReady, isTrue);

      // Now durable owner read throws
      loc.throwOnGetDurableOwner = Exception('SharedPreferences I/O error');
      await controller.reconcileDutyState();

      expect(controller.isReady, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.canToggleDuty, isFalse);
    });
  });

  group('Milestone 4 Second Frozen-Contract Acceptance Re-verification Suite', () {
    test('A-NULL-1: cached profile lifecycleSeq=null, native L2, fresh server says L2 -> adopts exact L2', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_a_null_1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 2;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_a_null_1',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      // Cached profile has lifecycleSeq = null
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_a_null_1',
        dutyGeneration: 1,
        lifecycleSeq: null,
      ));

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.activeSession?.lifecycleSeq, 2);
      expect(controller.activeLifecycleSeq, 2);
      expect(controller.isReady, isTrue);
      expect(loc.serviceRunning, isTrue);
    });

    test('A-NULL-2: cached profile lifecycleSeq=null, native L2, fresh server still null -> no adoption, not READY, no destructive stop', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_a_null_2',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 2;
      // Fresh server read also has lifecycleSeq = null
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_a_null_2',
        dutyGeneration: 1,
        lifecycleSeq: null,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_a_null_2',
        dutyGeneration: 1,
        lifecycleSeq: null,
      ));

      await controller.reconcileDutyState();

      // Must NOT adopt as exact active worker
      expect(controller.activeSession, isNull);
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      // Must NOT destructively stop the native worker
      expect(loc.serviceRunning, isTrue);
      expect(loc.durableOwnerRecord, isNotNull);
    });

    test('A-NULL-3: cached profile lifecycleSeq=null, native L2, fresh read fails -> no destructive stop, unknown/failed', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_a_null_3',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 2;
      loc.throwOnFetchServerState = true;

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_a_null_3',
        dutyGeneration: 1,
        lifecycleSeq: null,
      ));

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.isReady, isFalse);
      expect(loc.serviceRunning, isTrue);
      expect(loc.durableOwnerRecord, isNotNull);
    });

    test('A-NULL-4: cached L1, native L2, fresh L2 -> adopts L2, not L1', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_a_null_4',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 2;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_a_null_4',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      // Cached profile has lifecycleSeq = 1
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_a_null_4',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.activeSession?.lifecycleSeq, 2);
      expect(controller.activeLifecycleSeq, 2);
      expect(controller.isReady, isTrue);
    });

    test('B-NULL-1: exact worker, workerReady=null -> NOT READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_b_null_1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null_1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: null,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null_1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: null,
      ));

      await controller.reconcileDutyState();

      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.starting);
      expect(controller.currentProfile?.workerReady, isNull);
    });

    test('B-NULL-2: exact worker, workerReady absent -> NOT READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_b_null_2',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;
      final serverMap = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null_2',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ))..remove('workerReady');
      loc.serverDriverState = serverMap;

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null_2',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.starting);
    });

    test('B-NULL-3: exact worker, workerReady=false -> NOT READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_b_null_3',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null_3',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: false,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null_3',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: false,
      ));

      await controller.reconcileDutyState();

      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.starting);
    });

    test('B-NULL-4: exact worker, workerReady=true -> READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_b_null_4',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null_4',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null_4',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      await controller.reconcileDutyState();

      expect(controller.isReady, isTrue);
      expect(controller.trackingHealth, TrackingHealth.healthy);
    });

    test('C/E-PRESTART-UID: UID-A go-on held in prepare; switch to UID-B; release prepare -> 0 native start, 0 server start, UID-B unchanged', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser('driver_A'));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(uid: 'driver_A'));

      final holdCompleter = Completer<void>();
      loc.pendingBeforePrepareActivation = holdCompleter;

      final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 10));

      // User switches to driver_B
      auth.emitUser(f.FakeUser('driver_B'));
      controller.updateProfile(baseProfile.copyWith(uid: 'driver_B', isOnDuty: false));

      holdCompleter.complete();
      final res = await goOnFuture;

      expect(res, isFalse);
      expect(loc.operationLog.where((op) => op.startsWith('startForegroundService')).length, 0);
      expect(loc.operationLog.where((op) => op.startsWith('startDutySessionCall')).length, 0);
      expect(controller.boundUid, 'driver_B');
      expect(controller.isOnDuty, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.lastError, isNull);
    });

    test('C/E-PRESTART-OFF: go-on held in prepare; go-off becomes winning intent; release prepare -> 0 native start, 0 server start, stays OFF', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final holdCompleter = Completer<void>();
      loc.pendingBeforePrepareActivation = holdCompleter;

      final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 10));

      final goOffFuture = controller.requestGoOffDuty();

      holdCompleter.complete();
      final goOnRes = await goOnFuture;
      await goOffFuture;

      expect(goOnRes, isFalse);
      expect(loc.operationLog.where((op) => op.startsWith('startForegroundService')).length, 0);
      expect(loc.operationLog.where((op) => op.startsWith('startDutySessionCall')).length, 0);
      expect(controller.isOnDuty, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    });

    test('E-POSTWRITE-UID: UID-A go-on reaches server-start; switch to UID-B OFF; release server start -> UID-B remains OFF, not READY, no reconciliationFailed written', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser('driver_A'));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(uid: 'driver_A'));

      final holdCompleter = Completer<void>();
      loc.pendingBeforeStartService = holdCompleter;

      final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 10));

      // Switch to driver_B
      auth.emitUser(f.FakeUser('driver_B'));
      controller.updateProfile(baseProfile.copyWith(uid: 'driver_B', isOnDuty: false));

      holdCompleter.complete();
      final res = await goOnFuture;

      expect(res, isFalse);
      expect(controller.boundUid, 'driver_B');
      expect(controller.isOnDuty, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.isReady, isFalse);
      expect(controller.errorCategory, isNull);
    });

    test('D/H-RETRY-1: initial stop tuple U/S/G/L9 fails -> retryCleanup uses U/S/G/L9', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.mockLifecycleSeq = 9;
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.isOnDuty, isTrue);

      // Make initial stop fail
      loc.throwOnStopService = Exception('Stop timed out');
      await controller.requestGoOffDuty();

      expect(controller.isCleanupRequired, isTrue);
      expect(controller.pendingCleanupSession?.lifecycleSeq, 9);

      // Now clear stop failure for retry
      loc.throwOnStopService = null;
      loc.serviceRunning = false;
      loc.durableOwnerRecord = null;

      final retrySuccess = await controller.retryCleanup();
      expect(retrySuccess, isTrue);
      expect(controller.isCleanupRequired, isFalse);
      final lastStop = loc.stopCalls.last;
      expect(lastStop['expectedLifecycleSeq'], 9);
    });

    test('D/H-RETRY-2: retry stop leaves nativeRunning=true -> retry returns false, cleanupRequired stays true', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      // Make initial stop fail
      loc.throwOnStopService = Exception('Stop failure');
      await controller.requestGoOffDuty();
      expect(controller.isCleanupRequired, isTrue);

      // Retry stop executes without throwing, but service is STILL running
      loc.throwOnStopService = null;
      loc.simulatedStopLeavesServiceRunning = true;

      final retrySuccess = await controller.retryCleanup();
      expect(retrySuccess, isFalse);
      expect(controller.isCleanupRequired, isTrue);
    });

    test('D/H-RETRY-3: retry exact stop succeeds, residue gone -> cleanupRequired false, retry returns true', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      // Initial stop fails
      loc.throwOnStopService = Exception('Stop failure');
      await controller.requestGoOffDuty();
      expect(controller.isCleanupRequired, isTrue);

      // Retry succeeds and residue is gone
      loc.throwOnStopService = null;
      loc.serviceRunning = false;
      loc.durableOwnerRecord = null;

      final retrySuccess = await controller.retryCleanup();
      expect(retrySuccess, isTrue);
      expect(controller.isCleanupRequired, isFalse);
    });

    test('D/H-RESTART: recreated controller discovers U/S/G/L9 residue -> later retry uses exact L9', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_restart_9',
        uid: testUid,
        generation: 3,
        lifecycleSeq: 9,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 9;
      loc.serverDriverState = makeDriverDoc(baseProfile);

      // Fail the startup stop
      loc.throwOnStopService = Exception('Stop failed on cold restart');

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(isOnDuty: false));

      await controller.reconcileDutyState();

      expect(controller.isCleanupRequired, isTrue);
      expect(controller.pendingCleanupSession?.lifecycleSeq, 9);
      expect(controller.pendingCleanupSession?.generation, 3);
      expect(controller.pendingCleanupSession?.sessionId, 'sess_restart_9');

      // Now retry cleanup
      loc.throwOnStopService = null;
      loc.serviceRunning = false;
      loc.durableOwnerRecord = null;

      final retrySuccess = await controller.retryCleanup();
      expect(retrySuccess, isTrue);
      expect(controller.isCleanupRequired, isFalse);

      final lastStop = loc.stopCalls.last;
      expect(lastStop['expectedLifecycleSeq'], 9);
      expect(lastStop['expectedSessionId'], 'sess_restart_9');
      expect(lastStop['expectedGeneration'], 3);
    });

    test('G-DEFAULT-1: real coordinator path, fresh server OFF, native service-state unavailable -> no signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = false;
      loc.durableOwnerRecord = null;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(isOnDuty: false));

      // Native service query throws
      loc.throwOnIsServiceRunning = Exception('Native service query exception');

      final coordinator = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
      );

      final result = await coordinator.coordinateLogout(
        profile: baseProfile.copyWith(isOnDuty: false),
      );

      expect(result, LogoutResult.failedDutyTransition);
      expect(auth.signOutCalled, isFalse);
    });

    test('G-DEFAULT-2: real coordinator path, fresh server OFF, durable-owner unavailable -> no signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = false;
      loc.durableOwnerRecord = null;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(isOnDuty: false));

      // Durable owner check throws
      loc.throwOnGetDurableOwner = Exception('Native durable owner query exception');

      final coordinator = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
      );

      final result = await coordinator.coordinateLogout(
        profile: baseProfile.copyWith(isOnDuty: false),
      );

      expect(result, LogoutResult.failedDutyTransition);
      expect(auth.signOutCalled, isFalse);
    });

    test('G-DEFAULT-3: fresh server OFF, native reads succeed, no service/no owner -> signOut allowed', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = false;
      loc.durableOwnerRecord = null;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(isOnDuty: false));

      final coordinator = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
      );

      final result = await coordinator.coordinateLogout(
        profile: baseProfile.copyWith(isOnDuty: false),
      );

      expect(result, LogoutResult.success);
      expect(auth.signOutCalled, isTrue);
    });

    test('G-DEFAULT-4: fresh server OFF, exact native owner exists -> exact cleanup before signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_g_default_4',
        uid: testUid,
        generation: 2,
        lifecycleSeq: 5,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 5;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(isOnDuty: false));

      final coordinator = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
      );

      final result = await coordinator.coordinateLogout(
        profile: baseProfile.copyWith(isOnDuty: false),
      );

      expect(result, LogoutResult.success);
      expect(auth.signOutCalled, isTrue);
      expect(loc.stopCalls.any((call) =>
          call['expectedSessionId'] == 'sess_g_default_4' &&
          call['expectedLifecycleSeq'] == 5 &&
          call['expectedGeneration'] == 2), isTrue);
    });

    test('G-DEFAULT-5: native residue after stop blocks signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.simulatedStopLeavesServiceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_residue',
        uid: testUid,
        generation: 2,
        lifecycleSeq: 5,
        startedAt: DateTime.now(),
      );
      loc.serverDriverState = makeDriverDoc(baseProfile);

      final result = await AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
      ).coordinateLogout(profile: baseProfile);

      expect(result, LogoutResult.failedDutyTransition);
      expect(loc.stopCalls, hasLength(1));
      expect(auth.signOutCallCount, 0);
    });

    test('G-DEFAULT-6: exact native stop failure blocks signOut', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.throwOnStopService = Exception('Native stop failed');
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_stop_failure',
        uid: testUid,
        generation: 2,
        lifecycleSeq: 5,
        startedAt: DateTime.now(),
      );
      loc.serverDriverState = makeDriverDoc(baseProfile);

      final result = await AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
      ).coordinateLogout(profile: baseProfile);

      expect(result, LogoutResult.failedDutyTransition);
      expect(loc.stopCalls, hasLength(1));
      expect(auth.signOutCallCount, 0);
    });

    test('G-MOUNTED-1: native service read unavailable blocks mounted logout', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serverDriverState = makeDriverDoc(baseProfile);
      loc.throwOnIsServiceRunning = Exception('Native read unavailable');
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final result = await AppLogoutCoordinator(
        authService: auth,
        dutyController: controller,
      ).coordinateLogout(profile: baseProfile);

      expect(result, LogoutResult.failedDutyTransition);
      expect(auth.signOutCallCount, 0);
    });

    test('G-MOUNTED-2: residual native worker blocks mounted logout', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serverDriverState = makeDriverDoc(baseProfile);
      loc.serviceRunning = true;
      loc.simulatedStopLeavesServiceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_mounted_residue',
        uid: testUid,
        generation: 2,
        lifecycleSeq: 5,
        startedAt: DateTime.now(),
      );
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile);

      final result = await AppLogoutCoordinator(
        authService: auth,
        dutyController: controller,
      ).coordinateLogout(profile: baseProfile);

      expect(result, LogoutResult.failedDutyTransition);
      expect(loc.stopCalls, hasLength(1));
      expect(auth.signOutCallCount, 0);
    });
  });

  group('Milestone 4 Third Frozen-Contract Acceptance Re-verification Suite', () {
    // 1. A/B-EPOCH-ADVANCE-1
    test('A/B-EPOCH-ADVANCE-1: controller READY for L1, native advances to L2, fresh server still L1 ready -> isReady=false, TrackingHealth!=healthy, mismatch recognized', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_epoch_1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      await controller.reconcileDutyState();
      expect(controller.isReady, isTrue);
      expect(controller.trackingHealth, TrackingHealth.healthy);

      // Now native advances to L2
      loc.mockLifecycleSeq = 2;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_epoch_1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      // Fresh server read still reports L1, workerReady = true
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      await controller.reconcileDutyState();

      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, isNot(TrackingHealth.healthy));
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.errorCategory, HubErrorCategory.reconciliationFailed);
      // Mismatch recognized, zero native stops of newer worker
      expect(loc.serviceRunning, isTrue);
    });

    // 2. A/B-EPOCH-ADVANCE-2
    test('A/B-EPOCH-ADVANCE-2: same setup, but fresh server advances to L2 with workerReady=false -> adopt L2, STARTING, not READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_epoch_2',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 1;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_2',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_2',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));
      await controller.reconcileDutyState();
      expect(controller.isReady, isTrue);

      // Now native advances to L2
      loc.mockLifecycleSeq = 2;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_epoch_2',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      // Fresh server advances to L2, but workerReady is false
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_2',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: false,
      ));

      await controller.reconcileDutyState();

      expect(controller.activeSession?.lifecycleSeq, 2);
      expect(controller.activeLifecycleSeq, 2);
      expect(controller.trackingHealth, TrackingHealth.starting);
      expect(controller.isReady, isFalse);
    });

    // 3. A/B-EPOCH-ADVANCE-3
    test('A/B-EPOCH-ADVANCE-3: fresh server L2 workerReady=true, native L2 -> READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_epoch_3',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.mockLifecycleSeq = 2;
      loc.serverDriverState = makeDriverDoc(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_3',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: true,
      ));

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_3',
        dutyGeneration: 1,
        lifecycleSeq: 1, // Cached profile is L1
        workerReady: true,
      ));

      await controller.reconcileDutyState();

      expect(controller.activeSession?.lifecycleSeq, 2);
      expect(controller.activeLifecycleSeq, 2);
      expect(controller.trackingHealth, TrackingHealth.healthy);
      expect(controller.isReady, isTrue);
    });

    // 4. E-FAILED-UID-1
    test('E-FAILED-UID-1: UID-A go-on held at startDutySessionCall, switch to UID-B OFF, A fails -> UID-B remains OFF, not READY, health/error unchanged', () async {
      const uidA = 'driver_m4_uid_a1';
      const uidB = 'driver_m4_uid_b1';
      final auth = M4AcceptanceAuthService(f.FakeUser(uidA));
      final loc = M4AcceptanceLocationService();

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(uid: uidA, isOnDuty: false));

      final aWaitCompleter = Completer<void>();
      loc.pendingBeforeStartDutySessionCall = aWaitCompleter;

      // UID-A starts goOn
      final goOnFutureA = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 20));

      // Switch to UID-B OFF
      auth.emitUser(f.FakeUser(uidB));
      controller.updateProfile(baseProfile.copyWith(
        uid: uidB,
        name: 'Driver B',
        isOnDuty: false,
      ));

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.errorCategory, isNull);
      expect(controller.lastError, isNull);

      // Release A with server start failure
      loc.throwOnStartDutySessionCall = Exception('START_DUTY_SESSION_FAILED backend timeout');
      aWaitCompleter.complete();

      final resA = await goOnFutureA;
      expect(resA, isFalse);

      // UID-B must remain completely unaffected
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.errorCategory, isNull);
      expect(controller.lastError, isNull);
      expect(controller.activeSession, isNull);
    });

    // 5. E-FAILED-UID-2
    test('E-FAILED-UID-2: UID-A go-on held at startDutySessionCall, switch to UID-B OFF, A fails with PlatformException -> no B error/health mutation', () async {
      const uidA = 'driver_m4_uid_a2';
      const uidB = 'driver_m4_uid_b2';
      final auth = M4AcceptanceAuthService(f.FakeUser(uidA));
      final loc = M4AcceptanceLocationService();

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(uid: uidA, isOnDuty: false));

      final aWaitCompleter = Completer<void>();
      loc.pendingBeforeStartDutySessionCall = aWaitCompleter;

      final goOnFutureA = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 20));

      // Switch to UID-B OFF
      auth.emitUser(f.FakeUser(uidB));
      controller.updateProfile(baseProfile.copyWith(
        uid: uidB,
        name: 'Driver B2',
        isOnDuty: false,
      ));

      loc.throwOnStartDutySessionCall = PlatformException(
        code: 'START_DUTY_SESSION_FAILED',
        message: 'Internal server error 500',
      );
      aWaitCompleter.complete();

      final resA = await goOnFutureA;
      expect(resA, isFalse);

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.errorCategory, isNull);
      expect(controller.lastError, isNull);
    });

    // 6. E-FAILED-UID-3
    test('E-FAILED-UID-3: UID-A go-on held at startDutySessionCall, switch to UID-B OFF, A fails and A cleanup fails -> no B state/readiness corruption', () async {
      const uidA = 'driver_m4_uid_a3';
      const uidB = 'driver_m4_uid_b3';
      final auth = M4AcceptanceAuthService(f.FakeUser(uidA));
      final loc = M4AcceptanceLocationService();

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(uid: uidA, isOnDuty: false));

      final aWaitCompleter = Completer<void>();
      loc.pendingBeforeStartDutySessionCall = aWaitCompleter;

      final goOnFutureA = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 20));

      // Switch to UID-B OFF
      auth.emitUser(f.FakeUser(uidB));
      controller.updateProfile(baseProfile.copyWith(
        uid: uidB,
        name: 'Driver B3',
        isOnDuty: false,
      ));

      // Both start call fails AND native cleanup for stale A fails
      loc.throwOnStartDutySessionCall = Exception('Server start failure');
      loc.throwOnStopService = Exception('Native stop I/O error');
      aWaitCompleter.complete();

      final resA = await goOnFutureA;
      expect(resA, isFalse);

      // Still do not overwrite B's normal controller state with A's duty failure
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.errorCategory, isNull);
      expect(controller.lastError, isNull);
      expect(controller.activeSession, isNull);
    });

    // 7. E-SUCCESS-UID regression
    test('E-SUCCESS-UID regression: UID-A go-on held at startDutySessionCall, switch to UID-B OFF, A succeeds -> UID-B remains OFF and unmutated', () async {
      const uidA = 'driver_m4_uid_a4';
      const uidB = 'driver_m4_uid_b4';
      final auth = M4AcceptanceAuthService(f.FakeUser(uidA));
      final loc = M4AcceptanceLocationService();

      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(baseProfile.copyWith(uid: uidA, isOnDuty: false));

      final aWaitCompleter = Completer<void>();
      loc.pendingBeforeStartDutySessionCall = aWaitCompleter;

      final goOnFutureA = controller.requestGoOnDuty(onShowDisclosure: () async => true);
      await Future.delayed(const Duration(milliseconds: 20));

      // Switch to UID-B OFF
      auth.emitUser(f.FakeUser(uidB));
      controller.updateProfile(baseProfile.copyWith(
        uid: uidB,
        name: 'Driver B4',
        isOnDuty: false,
      ));

      // Release A successfully
      aWaitCompleter.complete();

      final resA = await goOnFutureA;
      expect(resA, isFalse);

      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.errorCategory, isNull);
      expect(controller.lastError, isNull);
      expect(controller.activeSession, isNull);
    });
  });

  group('Milestone 4 Fourth Frozen-Contract Acceptance Re-verification Suite', () {
    // Mandatory Reproduction 1
    test('Repro 1: A/B RE-GREEN AFTER EXACT MISMATCH: L1/L2 mismatch -> reconcile fails -> updateProfile(L1 ready) -> still not READY, not healthy, no L1 adoption', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.mockLifecycleSeq = 1;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      final profileL1Ready = baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      );
      controller.updateProfile(profileL1Ready);
      loc.serverDriverState = makeDriverDoc(profileL1Ready);
      await controller.reconcileDutyState();

      // Controller is initially READY for L1
      expect(controller.isReady, isTrue);
      expect(controller.trackingHealth, TrackingHealth.healthy);
      expect(controller.activeSession?.lifecycleSeq, 1);

      // Advance native to L2
      loc.mockLifecycleSeq = 2;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );

      // Fresh server remains L1 ready (use all required DriverProfile.fromMap fields)
      loc.serverDriverState = {
        'uid': testUid,
        'name': baseProfile.name,
        'phone': baseProfile.phone,
        'truckType': baseProfile.truckType.backendValue,
        'vehicleNumber': baseProfile.vehicleNumber,
        'verificationStatus': 'approved',
        'isOnDuty': true,
        'activeDutySessionId': 'sess_1',
        'dutyGeneration': 1,
        'lifecycleSeq': 1,
        'workerReady': true,
      };

      // Run reconciliation
      await controller.reconcileDutyState();

      // Assert post-reconciliation:
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, isNot(TrackingHealth.healthy));
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.activeSession, isNull);
      expect(loc.operationLog.any((op) => op.contains('stopForegroundService')), isFalse);

      // THEN call updateProfile(server L1 ready)
      controller.updateProfile(profileL1Ready);

      // Required:
      expect(controller.isReady, isFalse, reason: 'STILL not READY');
      expect(controller.trackingHealth, isNot(TrackingHealth.healthy), reason: 'STILL not healthy');
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.activeSession, isNull, reason: 'no confirmation manufactured, no L1 adoption');
      expect(controller.canToggleDuty, isFalse, reason: 'toggle disabled while reconciliation unresolved');
    });

    // Mandatory Reproduction 3
    test('Repro 3: UNCERTAIN READ + PROFILE UPDATE: native read throws -> unknown/reconciliationFailed -> updateProfile(cached ready) -> not READY, toggle disabled', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.mockLifecycleSeq = 1;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_1',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      final cachedReadyProfile = baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      );
      controller.updateProfile(cachedReadyProfile);
      loc.serverDriverState = makeDriverDoc(cachedReadyProfile);
      await controller.reconcileDutyState();

      // Start controller READY
      expect(controller.isReady, isTrue);

      // Cause native owner/state read to throw
      loc.throwOnGetDurableOwner = PlatformException(
        code: 'NATIVE_UNAVAILABLE',
        message: 'IPC read failed',
      );

      await controller.reconcileDutyState();

      // Reconciliation must become unknown/reconciliationFailed, not READY, toggle disabled
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.isReady, isFalse);
      expect(controller.canToggleDuty, isFalse);

      // Then deliver cached isOnDuty=true, exact old profile, workerReady=true
      controller.updateProfile(cachedReadyProfile);

      // Required:
      expect(controller.isReady, isFalse, reason: 'not READY');
      expect(controller.canToggleDuty, isFalse, reason: 'toggle remains disabled');
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown, reason: 'uncertainty not healed');
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed, reason: 'reconciliationFailed not cleared');
      expect(controller.activeSession, isNull);
    });

    // Mandatory Reproduction 4
    test('Repro 4: VALID READY PROMOTION: confirmed U/S/G/L2, workerReady false -> true promotes to READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.mockLifecycleSeq = 2;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_2',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      final profileL2NotReady = baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_2',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: false,
      );
      controller.updateProfile(profileL2NotReady);
      loc.serverDriverState = makeDriverDoc(profileL2NotReady);
      await controller.reconcileDutyState();

      // Exact confirmed native/server epoch U/S/G/L2, STARTING, not READY
      expect(controller.activeSession?.sessionId, 'sess_2');
      expect(controller.activeSession?.lifecycleSeq, 2);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      expect(controller.trackingHealth, TrackingHealth.starting);
      expect(controller.isReady, isFalse);

      // Then exact same U/S/G/L2 profile arrives with workerReady=true
      final profileL2Ready = profileL2NotReady.copyWith(workerReady: true);
      controller.updateProfile(profileL2Ready);

      // Required:
      expect(controller.trackingHealth, TrackingHealth.healthy);
      expect(controller.isReady, isTrue);
      expect(controller.canToggleDuty, isTrue);
    });

    // Mandatory Reproduction 5
    test('Repro 5: WRONG-EPOCH READINESS: confirmed L2 worker, incoming wrong epoch + workerReady=true -> not READY', () async {
      final auth = M4AcceptanceAuthService(f.FakeUser(testUid));
      final loc = M4AcceptanceLocationService();
      loc.serviceRunning = true;
      loc.mockLifecycleSeq = 2;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        sessionId: 'sess_2',
        uid: testUid,
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );

      final controller = DutyController(locationService: loc, authService: auth);
      final profileL2 = baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_2',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: false,
      );
      controller.updateProfile(profileL2);
      loc.serverDriverState = makeDriverDoc(profileL2);
      await controller.reconcileDutyState();

      expect(controller.activeSession?.lifecycleSeq, 2);
      expect(controller.isReady, isFalse);

      // 1. Incoming profile with wrong lifecycleSeq (L1) + workerReady=true
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_2',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, isNot(TrackingHealth.healthy));

      // 2. Incoming profile with wrong generation + workerReady=true
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_2',
        dutyGeneration: 99,
        lifecycleSeq: 2,
        workerReady: true,
      ));
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, isNot(TrackingHealth.healthy));

      // 3. Incoming profile with wrong session + workerReady=true
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_wrong',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: true,
      ));
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, isNot(TrackingHealth.healthy));

      // 4. Incoming profile with missing lifecycleSeq + workerReady=true
      controller.updateProfile(baseProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_2',
        dutyGeneration: 1,
        lifecycleSeq: null,
        workerReady: true,
      ));
      expect(controller.isReady, isFalse);
      expect(controller.trackingHealth, isNot(TrackingHealth.healthy));

      // Active session remains confirmed L2
      expect(controller.activeSession?.sessionId, 'sess_2');
      expect(controller.activeSession?.lifecycleSeq, 2);
    });
  });
}
