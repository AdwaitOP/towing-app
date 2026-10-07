import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';

// ============================================================================
// CONSTANTS & REPLACEMENT FORMS
// ============================================================================
const oldSession = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 7);
const oldResumed = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 9);

const replacementForms = <DutySession>[
  DutySession(uid: 'B', sessionId: 'T', generation: 3, lifecycleSeq: 8), // Form 1: other UID
  DutySession(uid: 'A', sessionId: 'S', generation: 3, lifecycleSeq: 8), // Form 2: same UID new Gen
  DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 8), // Form 3: same UID/Gen new Seq
];

List<Object?>? sessionTuple(DutySession? s) =>
    s == null ? null : [s.uid, s.sessionId, s.generation, s.lifecycleSeq];

// ============================================================================
// TEST HARNESS ADAPTERS
// ============================================================================
class RegressionUser implements User {
  @override
  final String uid;
  RegressionUser(this.uid);
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class RegressionAuth extends AuthService {
  User? user = RegressionUser('A');
  final changes = StreamController<User?>.broadcast(sync: true);
  final signouts = <String?>[];

  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => changes.stream;

  void switchTo(String? uid) {
    user = uid == null ? null : RegressionUser(uid);
    changes.add(user);
  }

  @override
  Future<void> signOut() async {
    signouts.add(user?.uid);
    user = null;
    changes.add(null);
  }
}

class HoldGate {
  final entered = Completer<void>();
  final release = Completer<void>();
  final String? failureCode;
  HoldGate({this.failureCode});

  Future<void> wait() async {
    entered.complete();
    await release.future;
    if (failureCode != null) throw PlatformException(code: failureCode!);
  }
}

class RegressionLocationService extends DriverLocationService {
  final counts = <String, int>{};
  final holds = <String, HoldGate>{};
  final calls = <Map<String, dynamic>>[];
  final stops = <DutySession>[];
  final ends = <DutySession>[];
  final leases = <NativeCleanupAcquisition>[];

  Map<String, dynamic> serverData = {
    'uid': 'A',
    'name': 'Driver A',
    'phone': '+919999999999',
    'truckType': 'flatbed',
    'vehicleNumber': 'MH01AA0001',
    'verificationStatus': 'approved',
    'isOnDuty': true,
    'activeDutySessionId': 'S',
    'dutyGeneration': 2,
    'lifecycleSeq': 7,
    'activeJobId': null,
    'activeOfferId': null,
    'workerReady': true,
  };

  bool permissionLost = false;
  bool stopFailure = false;
  int? stopFailureForSeq;
  String stopFailureCode = 'M5_STOP_FAILED';

  Future<T> _sampled<T>(String name, Future<T> Function() action) async {
    final n = counts.update(name, (v) => v + 1, ifAbsent: () => 1);
    final value = await action();
    calls.add({'action': name, 'n': n, 'value': value});
    await holds['$name:$n']?.wait();
    return value;
  }

  Future<void> _before(String name) async {
    final n = counts.update(name, (v) => v + 1, ifAbsent: () => 1);
    calls.add({'action': name, 'n': n});
    await holds['$name:$n']?.wait();
  }

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() =>
      _sampled('owner', NativeOwnershipCoordinator.getDurableOwner);

  @override
  Future<DutySession?> getDurableSession() =>
      _sampled('session', () async {
        final r = await NativeOwnershipCoordinator.getDurableOwner();
        return r == null
            ? null
            : DutySession(
                uid: r.uid,
                sessionId: r.sessionId,
                generation: r.generation,
                lifecycleSeq: r.lifecycleSeq,
              );
      });

  @override
  Future<bool> isForegroundServiceRunning() =>
      _sampled('running', NativeOwnershipCoordinator.isServiceRunning);

  @override
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(String op, String uid) async {
    final lease = await super.beginCleanupAcquisition(op, uid);
    leases.add(lease);
    await _before('acquire');
    return lease;
  }

  @override
  Future<bool> validateCleanupAcquisition(NativeCleanupAcquisition lease) =>
      _sampled('validate', () => super.validateCleanupAcquisition(lease));

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) =>
      _sampled('server', () async => Map<String, dynamic>.from(serverData));

  @override
  Future<bool> isLocationServiceEnabled() async => true;
  @override
  Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async =>
      permissionLost ? LocationPermissionStatus.denied : LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async => LocationPermissionStatus.granted;
  @override
  Future<DriverPosition?> getCurrentPosition() async =>
      DriverPosition(latitude: 19.0, longitude: 73.0, timestamp: DateTime.utc(2026, 10, 3));

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async =>
      const DutyActivationPreparation(sessionId: 'S', generation: 2, attemptSeq: 9);

  DutySession allocated = oldSession;

  @override
  Future<void> executeGoOnDutyTransaction({required String uid}) async {}

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {}

  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async {
    await _before('activation');
    return {
      'status': 'activated',
      'dutyGeneration': generation ?? 2,
      'lifecycleSeq': lifecycleSeq ?? 7,
      'workerReady': false,
    };
  }

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession)? onAuthorityAllocated,
  }) async {
    final toInstall = allocated;
    onAuthorityAllocated?.call(toInstall);
    await _before('start');
    await installNativeWorker(toInstall);
    return true;
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    final s = DutySession(
      uid: expectedUid ?? 'A',
      sessionId: expectedSessionId,
      generation: expectedGeneration ?? 2,
      lifecycleSeq: expectedLifecycleSeq,
    );
    stops.add(s);
    await _before('stop');
    if (stopFailure && (stopFailureForSeq == null || expectedLifecycleSeq == stopFailureForSeq)) {
      throw PlatformException(code: stopFailureCode);
    }
    await NativeOwnershipCoordinator.atomicStopService(
      expectedUid: expectedUid!,
      expectedSessionId: expectedSessionId,
      expectedGeneration: expectedGeneration!,
      expectedLifecycleSeq: expectedLifecycleSeq!,
    );
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    ends.add(DutySession(
      uid: uid,
      sessionId: sessionId,
      generation: generation ?? 2,
      lifecycleSeq: lifecycleSeq,
    ));
    await _before('end');
    serverData = {...serverData, 'isOnDuty': false};
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    await _before('cancel');
  }
}

Future<void> installNativeWorker(DutySession s) async {
  final res = await NativeOwnershipCoordinator.atomicStartService(
    record: DurableDutyOwnerRecord(
      uid: s.uid,
      sessionId: s.sessionId,
      generation: s.generation,
      lifecycleSeq: s.lifecycleSeq!,
      startedAt: DateTime.utc(2026, 10, 3),
    ),
    foregroundTaskOptionsMap: {'callbackHandle': 999},
  );
  expect(res['success'], true);
  expect(res['active'], true);
}

// ============================================================================
// MAIN REGRESSION SUITE
// ============================================================================
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    DriverLocationService.resetPendingCleanupTokensForTesting();
    NativeOwnershipCoordinator.resetTestSimulation();
    NativeOwnershipCoordinator.useTestSimulation = true;
  });

  tearDown(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
  });

  // ==========================================================================
  // ROOT 1: NATIVE FINAL-PROOF FRESHNESS (24 CASES)
  // ==========================================================================
  group('Root 1: Native Final-Proof Freshness (24 Cases)', () {
    // ------------------------------------------------------------------------
    // Callers 1, 3, 4, 8: Explicit go-off & reconciliation residual paths (12 cases)
    // ------------------------------------------------------------------------
    final absenceCallers = <int, String>{
      1: 'requestGoOffDuty',
      3: 'reconcileDutyState (rejected ON)',
      4: 'reconcileDutyState (server OFF)',
      8: 'reconcileDutyState (permission loss)',
    };

    for (final callerEntry in absenceCallers.entries) {
      final caller = callerEntry.key;
      for (final replacement in replacementForms) {
        test('Caller $caller ${callerEntry.value} stale final proof rejects clean OFF with replacement ${replacement.uid}/G${replacement.generation}/L${replacement.lifecycleSeq}', () async {
          await installNativeWorker(oldSession);
          final auth = RegressionAuth();
          final loc = RegressionLocationService();
          if (caller == 3) loc.serverData['verificationStatus'] = 'rejected';
          if (caller == 4) loc.serverData['isOnDuty'] = false;
          if (caller == 8) loc.permissionLost = true;

          final controller = DutyController(locationService: loc, authService: auth);
          addTearDown(controller.dispose);
          addTearDown(auth.changes.close);
          controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));

          final hold = HoldGate();
          loc.holds['owner:3'] = hold; // Final owner sample in _isNativeAbsent

          final dynamic future = caller == 1 ? controller.requestGoOffDuty() : controller.reconcileDutyState();
          await hold.entered.future.timeout(const Duration(seconds: 4));

          // At hold point: STOP old session completed, simulator durable owner is null
          expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);

          // Legitimate concurrent native START occurs
          await installNativeWorker(replacement);

          // Deliver old sampled null reply
          hold.release.complete();
          final result = await future;

          // Invariant assertions:
          expect(await NativeOwnershipCoordinator.isServiceRunning(), true, reason: 'Replacement must survive');
          final currentOwner = await NativeOwnershipCoordinator.getDurableOwner();
          expect(currentOwner?.uid, replacement.uid);
          expect(currentOwner?.generation, replacement.generation);
          expect(currentOwner?.lifecycleSeq, replacement.lifecycleSeq);

          // FAILS RED ON PRODUCTION: Stale proof must NOT publish clean OFF
          if (caller == 1) {
            expect(result, false, reason: 'requestGoOffDuty must return false when native absence is stale');
          }
          expect(controller.trackingHealth, TrackingHealth.reconciliationFailed, reason: 'Stale absence proof must fail reconciliation');
          expect(controller.isCleanupRequired, true, reason: 'Cleanup required flag must remain active');
        });
      }
    }

    // ------------------------------------------------------------------------
    // Caller 2: Pending cleanup retry (3 cases)
    // ------------------------------------------------------------------------
    for (final replacement in replacementForms) {
      test('Caller 2 retryCleanup stale final proof rejects clean OFF with replacement ${replacement.uid}/G${replacement.generation}/L${replacement.lifecycleSeq}', () async {
        await installNativeWorker(oldSession);
        final auth = RegressionAuth();
        final loc = RegressionLocationService();
        final controller = DutyController(locationService: loc, authService: auth);
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);
        controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));

        // Force cleanup debt via failed go-off
        loc.stopFailure = true;
        expect(await controller.requestGoOffDuty(), false);
        expect(controller.isCleanupRequired, true);
        expect(controller.pendingCleanupSession, oldSession);
        loc.stopFailure = false;
        loc.counts.clear();
        loc.calls.clear();

        final hold = HoldGate();
        loc.holds['owner:2'] = hold; // Final owner sample in retry's _isNativeAbsent

        final pendingRetry = controller.retryCleanup();
        await hold.entered.future.timeout(const Duration(seconds: 4));
        expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);

        // Intervening replacement START
        await installNativeWorker(replacement);
        hold.release.complete();
        final retryResult = await pendingRetry;

        expect(await NativeOwnershipCoordinator.isServiceRunning(), true);
        // FAILS RED ON PRODUCTION: retryCleanup must not return true or clear pending debt
        expect(retryResult, false, reason: 'retryCleanup cannot certify absence from pre-START sampled null');
        expect(controller.isCleanupRequired, true);
        expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      });
    }

    // ------------------------------------------------------------------------
    // Caller 9: Compensation handoff to logout receiver (3 cases)
    // ------------------------------------------------------------------------
    for (final replacement in replacementForms) {
      test('Caller 9 compensation handoff rejects clean OFF on stale final absence with replacement ${replacement.uid}/G${replacement.generation}/L${replacement.lifecycleSeq}', () async {
        final auth = RegressionAuth();
        final loc = RegressionLocationService();
        final controller = DutyController(locationService: loc, authService: auth);
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);
        controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));

        final activationHold = HoldGate();
        loc.holds['activation:1'] = activationHold;

        final goOnFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);
        await activationHold.entered.future.timeout(const Duration(seconds: 4));

        // Start logout barrier while go-on is in flight
        final barrier = controller.beginLogoutBarrier('A');

        // Hold final owner read during compensating cleanup
        final ownerHold = HoldGate();
        loc.holds['owner:2'] = ownerHold;
        activationHold.release.complete();

        await ownerHold.entered.future.timeout(const Duration(seconds: 4));
        expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);

        // Legitimate replacement START
        await installNativeWorker(replacement);
        ownerHold.release.complete();

        final goOnResult = await goOnFuture;
        expect(goOnResult, false);
        expect(await NativeOwnershipCoordinator.isServiceRunning(), true);

        // FAILS RED ON PRODUCTION: Handoff must not publish clean offDuty/off
        expect(controller.trackingHealth.name, isNot('off'), reason: 'Compensation handoff cannot publish clean OFF on stale native proof');
        controller.endLogoutBarrier(barrier);
      });
    }

    // ------------------------------------------------------------------------
    // Callers 5 & 6: Mounted & Unmounted logout final validation (6 cases)
    // ------------------------------------------------------------------------
    for (final mounted in [true, false]) {
      final callerTag = mounted ? 'Caller 5 (mounted)' : 'Caller 6 (unmounted)';
      final holdBoundary = mounted ? 'validate:2' : 'validate:3';

      for (final replacement in replacementForms) {
        test('$callerTag final acquisition validation delivery freshness rejects signOut on replacement ${replacement.uid}/G${replacement.generation}/L${replacement.lifecycleSeq}', () async {
          await installNativeWorker(oldSession);
          final auth = RegressionAuth();
          final loc = RegressionLocationService();
          final controller = mounted ? DutyController(locationService: loc, authService: auth) : null;
          controller?.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));

          final hold = HoldGate();
          loc.holds[holdBoundary] = hold;

          final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc, dutyController: controller);
          final logoutFuture = coordinator.coordinateLogout();

          await hold.entered.future.timeout(const Duration(seconds: 4));
          expect(loc.stops, isNotEmpty);

          // Legitimate replacement START occurs while validation delivery is held
          await installNativeWorker(replacement);
          hold.release.complete();

          final result = await logoutFuture;

          // Invariant assertions:
          expect(await NativeOwnershipCoordinator.isServiceRunning(), true);
          // FAILS RED ON PRODUCTION: Coordinator proceeds to signOut despite invalid acquisition
          expect(auth.signouts, isEmpty, reason: 'Stale native acquisition validation must block signOut');
          expect(result, LogoutResult.failedDutyTransition);
          controller?.dispose();
          await auth.changes.close();
        });
      }
    }
  });

  // ==========================================================================
  // ROOT 2: FINAL LOGOUT OPERATION, LEASE & AUTH OWNERSHIP (3 CASES)
  // ==========================================================================
  group('Root 2: Final Logout Operation, Lease & Auth Ownership (3 Cases)', () {
    test('Mounted Caller 5 newer same-UID logout lease during final validation blocks old signOut', () async {
      await installNativeWorker(oldSession);
      final auth = RegressionAuth();
      final loc = RegressionLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));

      final hold = HoldGate();
      loc.holds['validate:2'] = hold;

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc, dutyController: controller);
      final logoutFuture = coordinator.coordinateLogout();

      await hold.entered.future.timeout(const Duration(seconds: 4));

      // Acquire a newer lease for same UID 'A' during the final await
      final newerLease = controller.beginLogoutBarrier('A');

      hold.release.complete();
      final result = await logoutFuture;

      // FAILS RED ON PRODUCTION: Coordinator lacks post-await lease check, signs out A
      expect(controller.isLogoutBarrierActive(newerLease), true, reason: 'Newer lease must remain active');
      expect(auth.signouts, isEmpty, reason: 'Old logout cannot authorize signOut when newer lease exists');
      expect(result, LogoutResult.failedDutyTransition);

      controller.endLogoutBarrier(newerLease);
      controller.dispose();
      await auth.changes.close();
    });

    test('Mounted Caller 5 Auth A->B switch during final validation cannot signOut B', () async {
      await installNativeWorker(oldSession);
      final auth = RegressionAuth();
      final loc = RegressionLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));

      final hold = HoldGate();
      loc.holds['validate:2'] = hold;

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc, dutyController: controller);
      final logoutFuture = coordinator.coordinateLogout();

      await hold.entered.future.timeout(const Duration(seconds: 4));

      // Auth switches to B during final await
      auth.switchTo('B');

      hold.release.complete();
      final result = await logoutFuture;

      // FAILS RED ON PRODUCTION: Coordinator signs out user B
      expect(auth.signouts, isEmpty, reason: 'Old A continuation cannot sign out successor user B');
      expect(auth.currentUser?.uid, 'B', reason: 'User B must remain authenticated');
      expect(result, LogoutResult.failedDutyTransition);

      controller.dispose();
      await auth.changes.close();
    });

    test('Unmounted Caller 6 Auth A->B switch during final validation cannot signOut B', () async {
      await installNativeWorker(oldSession);
      final auth = RegressionAuth();
      final loc = RegressionLocationService();

      final hold = HoldGate();
      loc.holds['validate:3'] = hold;

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc, dutyController: null);
      final logoutFuture = coordinator.coordinateLogout();

      await hold.entered.future.timeout(const Duration(seconds: 4));

      // Auth switches to B during final await
      auth.switchTo('B');

      hold.release.complete();
      final result = await logoutFuture;

      // FAILS RED ON PRODUCTION: Coordinator signs out user B
      expect(auth.signouts, isEmpty, reason: 'Unmounted A logout cannot sign out successor user B');
      expect(auth.currentUser?.uid, 'B', reason: 'User B must remain authenticated');
      expect(result, LogoutResult.failedDutyTransition);

      await auth.changes.close();
    });
  });

  // ==========================================================================
  // ROOT 3: TYPE-B STALE DIAGNOSTIC OWNERSHIP ACROSS SUCCESSOR (3 CASES)
  // ==========================================================================
  group('Root 3: TYPE-B Stale Diagnostic Ownership Across Successor (3 Cases)', () {
    test('Caller 7 stabilized B OFF with old A residue isolates successor diagnostic', () async {
      final auth = RegressionAuth();
      final loc = RegressionLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      addTearDown(controller.dispose);
      addTearDown(auth.changes.close);

      // Normal go-on for A
      controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));
      expect(await controller.requestGoOnDuty(onShowDisclosure: () async => true), true);

      // Native worker disappears before reconcileDutyState
      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;

      // A disappears, reconcileDutyState begins, START returns oldResumed (L9)
      loc.allocated = oldResumed;
      loc.stopFailure = true;
      loc.stopFailureForSeq = 9;
      loc.stopFailureCode = 'FRESH_EXACT_OLD_STOP_FAILED';

      final startHold = HoldGate();
      loc.holds['start:2'] = startHold;

      final reconcileFuture = controller.reconcileDutyState();
      await startHold.entered.future.timeout(const Duration(seconds: 4));

      // Switch to B, settle OFF, clear diagnostic error
      auth.switchTo('B');
      controller.updateProfile(DriverProfile.fromMap({...loc.serverData, 'uid': 'B', 'isOnDuty': false}, 'B'));
      controller.clearError();
      expect(controller.staleStartCleanupError, isNull);

      // Release START hook; exact old STOP fails and enters catch
      startHold.release.complete();
      await reconcileFuture;

      // FAILS RED ON PRODUCTION: Stale old STOP error is written to B's controller diagnostic
      expect(controller.staleStartCleanupError, isNull, reason: 'Old A residue STOP failure must not pollute settled successor B diagnostic');
    });

    test('Caller 7 stabilized B OFF with newer B lease isolates successor diagnostic', () async {
      final auth = RegressionAuth();
      final loc = RegressionLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      addTearDown(controller.dispose);
      addTearDown(auth.changes.close);

      controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));
      expect(await controller.requestGoOnDuty(onShowDisclosure: () async => true), true);

      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;

      loc.allocated = oldResumed;
      loc.stopFailure = true;
      loc.stopFailureForSeq = 9;
      loc.stopFailureCode = 'FRESH_EXACT_OLD_STOP_FAILED';

      final startHold = HoldGate();
      loc.holds['start:2'] = startHold;

      final reconcileFuture = controller.reconcileDutyState();
      await startHold.entered.future.timeout(const Duration(seconds: 4));

      auth.switchTo('B');
      controller.updateProfile(DriverProfile.fromMap({...loc.serverData, 'uid': 'B', 'isOnDuty': false}, 'B'));
      controller.clearError();

      // Explicit successor operation initiated and settled
      final successorLease = controller.beginLogoutBarrier('B');
      controller.endLogoutBarrier(successorLease);

      startHold.release.complete();
      await reconcileFuture;

      // FAILS RED ON PRODUCTION: Diagnostic contaminated
      expect(controller.staleStartCleanupError, isNull, reason: 'Old A failure must not pollute diagnostic of successor B that ran a newer operation');
    });

    test('Caller 7 held diagnostic owner sample cannot regain authority over active successor B', () async {
      final auth = RegressionAuth();
      final loc = RegressionLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      addTearDown(controller.dispose);
      addTearDown(auth.changes.close);

      controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));
      expect(await controller.requestGoOnDuty(onShowDisclosure: () async => true), true);

      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;

      loc.allocated = oldResumed;
      loc.stopFailure = true;
      loc.stopFailureForSeq = 9;
      loc.stopFailureCode = 'FRESH_DIAGNOSTIC_STOP_FAILED';

      final startHold = HoldGate();
      loc.holds['start:2'] = startHold;
      final reconcileFuture = controller.reconcileDutyState();
      await startHold.entered.future.timeout(const Duration(seconds: 4));

      auth.switchTo('B');
      controller.updateProfile(DriverProfile.fromMap({...loc.serverData, 'uid': 'B', 'isOnDuty': false}, 'B'));
      controller.clearError();

      // Hold exact old stop in compensateStaleStart
      final stopHold = HoldGate(failureCode: 'FRESH_DIAGNOSTIC_STOP_FAILED');
      loc.holds['stop:2'] = stopHold;

      startHold.release.complete();
      await stopHold.entered.future.timeout(const Duration(seconds: 4));

      // B becomes actively on duty with a live native worker while stop is held
      await installNativeWorker(const DutySession(uid: 'B', sessionId: 'T', generation: 3, lifecycleSeq: 10));
      controller.updateProfile(DriverProfile.fromMap({...loc.serverData, 'uid': 'B', 'isOnDuty': true}, 'B'));
      final bLease = controller.beginLogoutBarrier('B');
      controller.endLogoutBarrier(bLease);

      stopHold.release.complete();
      await reconcileFuture;

      expect(controller.staleStartCleanupError, isNull, reason: 'Stale sampled owner read cannot authorize diagnostic publication into active successor B');
    });
  });

  // ==========================================================================
  // POSITIVE CONTROLS (MUST REMAIN GREEN)
  // ==========================================================================
  group('Positive Controls (MUST REMAIN GREEN)', () {
    test('Positive Control 1: Genuine current absence successfully completes and publishes clean OFF', () async {
      await installNativeWorker(oldSession);
      final auth = RegressionAuth();
      final loc = RegressionLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      addTearDown(controller.dispose);
      addTearDown(auth.changes.close);
      controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));

      final result = await controller.requestGoOffDuty();

      expect(result, true);
      expect(controller.trackingHealth, TrackingHealth.off);
      expect(controller.isCleanupRequired, false);
      expect(controller.pendingCleanupSession, isNull);
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
      expect(await NativeOwnershipCoordinator.isServiceRunning(), false);
    });

    test('Positive Control 2: Genuine current logout successfully signs out', () async {
      await installNativeWorker(oldSession);
      final auth = RegressionAuth();
      final loc = RegressionLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));

      final coordinator = AppLogoutCoordinator(authService: auth, locationService: loc, dutyController: controller);
      final result = await coordinator.coordinateLogout();

      expect(result, LogoutResult.success);
      expect(auth.signouts, ['A']);
      expect(auth.currentUser, isNull);
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
      controller.dispose();
      await auth.changes.close();
    });

    test('Positive Control 3: Unauthenticated / no-successor state with genuine residue retains forensic diagnostic', () async {
      final auth = RegressionAuth();
      final loc = RegressionLocationService();
      final controller = DutyController(locationService: loc, authService: auth);
      addTearDown(controller.dispose);
      addTearDown(auth.changes.close);

      controller.updateProfile(DriverProfile.fromMap(loc.serverData, 'A'));
      expect(await controller.requestGoOnDuty(onShowDisclosure: () async => true), true);

      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;

      loc.allocated = oldResumed;
      loc.stopFailure = true;
      loc.stopFailureForSeq = 9;
      loc.stopFailureCode = 'FRESH_CURRENT_FORENSIC_FAILURE';

      final startHold = HoldGate();
      loc.holds['start:2'] = startHold;
      final reconcileFuture = controller.reconcileDutyState();
      await startHold.entered.future.timeout(const Duration(seconds: 4));

      // Auth is dropped completely: no successor UID, no profile, no logout barrier
      auth.switchTo(null);

      startHold.release.complete();
      await reconcileFuture;

      // MUST REMAIN GREEN: Forensic diagnostic is preserved when unauthenticated
      expect(controller.staleStartCleanupError, isNotNull);
      expect(controller.staleStartCleanupError, contains('FRESH_CURRENT_FORENSIC_FAILURE'));
    });
  });
}
