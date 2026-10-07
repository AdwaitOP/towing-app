import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'duty_controller_test.dart' as f;

// ============================================================================
// SECTION 1: LOGOUT DEFINITIONS (Root 1: F06 / F07)
// ============================================================================

class CensusUser implements User {
  @override
  final String uid;
  CensusUser(this.uid);
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class CensusAuth extends AuthService {
  User? user = CensusUser('A');
  final changes = StreamController<User?>.broadcast(sync: true);
  final signouts = <String?>[];
  void Function()? notification;
  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => changes.stream;
  @override
  Future<void> signOut() async {
    signouts.add(user?.uid);
    user = null;
    changes.add(null);
    notification?.call();
  }
}

class LogoutGate {
  final entered = Completer<void>(), released = Completer<void>();
  final bool fail;
  LogoutGate({this.fail = false});
  Future<void> wait() async {
    entered.complete();
    await released.future;
    if (fail) throw StateError('CENSUS_HELD_FAILURE');
  }
}

class CensusLogoutLocation extends DriverLocationService {
  final gates = <String, LogoutGate>{};
  final visits = <String, int>{};
  final stops = <DutySession>[], ends = <DutySession>[];
  final leases = <NativeCleanupAcquisition>[];
  bool serverOn = false;
  @override
  Future<bool> isLocationServiceEnabled() async => true;
  @override
  Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async => LocationPermissionStatus.granted;
  LogoutGate? gate(String kind) {
    final n = visits.update(kind, (v) => v + 1, ifAbsent: () => 1);
    return gates['$kind:$n'];
  }
  Future<T> read<T>(String kind, Future<T> Function() actual) async {
    final selected = gate(kind);
    final value = await actual();
    if (selected != null) await selected.wait();
    return value;
  }
  @override
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(String op, String uid) async {
    final lease = await super.beginCleanupAcquisition(op, uid);
    leases.add(lease);
    await gate('acquire')?.wait();
    return lease;
  }
  @override
  Future<bool> validateCleanupAcquisition(NativeCleanupAcquisition lease) =>
      read('validate', () => super.validateCleanupAcquisition(lease));
  @override
  Future<void> releaseCleanupAcquisition(NativeCleanupAcquisition lease) async {
    await gate('release')?.wait();
    await super.releaseCleanupAcquisition(lease);
  }
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async {
    final value = serverData(uid, serverOn);
    await gate('server')?.wait();
    return value;
  }
  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() =>
      read('owner', super.getDurableOwnerRecord);
  @override
  Future<DutySession?> getDurableSession() => read('session', super.getDurableSession);
  @override
  Future<bool> isForegroundServiceRunning() => read('running', super.isForegroundServiceRunning);
  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    ends.add(DutySession(uid: uid, sessionId: sessionId, generation: generation!, lifecycleSeq: lifecycleSeq));
    await gate('end')?.wait();
    serverOn = false;
  }
  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    stops.add(DutySession(
      uid: expectedUid!,
      sessionId: expectedSessionId,
      generation: expectedGeneration!,
      lifecycleSeq: expectedLifecycleSeq,
    ));
    await gate('stop')?.wait();
    await super.stopForegroundService(
      expectedUid: expectedUid,
      expectedSessionId: expectedSessionId,
      expectedGeneration: expectedGeneration,
      expectedLifecycleSeq: expectedLifecycleSeq,
    );
  }
}

Map<String, dynamic> serverData(String uid, bool on) => {
  'uid': uid,
  'name': 'Census Driver',
  'phone': '+919876543210',
  'truckType': 'flatbed',
  'vehicleNumber': 'MH 12 AB 1234',
  'verificationStatus': 'approved',
  'isOnDuty': on,
  if (on) 'activeDutySessionId': 'S',
  if (on) 'dutyGeneration': 2,
  if (on) 'lifecycleSeq': 7,
};

const logoutOldSession = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 7);
const logoutNewerSession = DutySession(uid: 'A', sessionId: 'S', generation: 3, lifecycleSeq: 8);

Future<void> installNative(DutySession tuple) async {
  final result = await NativeOwnershipCoordinator.atomicStartService(
    record: DurableDutyOwnerRecord(
      uid: tuple.uid,
      sessionId: tuple.sessionId,
      generation: tuple.generation,
      lifecycleSeq: tuple.lifecycleSeq!,
      startedAt: DateTime.utc(2026, 10, 2),
    ),
    foregroundTaskOptionsMap: {'callbackHandle': 1},
  );
  expect(result['success'], true);
}

Future<Map<String, dynamic>> logoutSnapshot(CensusAuth auth, DutyController? c) async => {
  'auth': auth.user?.uid,
  'signouts': [...auth.signouts],
  'owner': (await NativeOwnershipCoordinator.getDurableOwner())?.toMap(),
  'running': await NativeOwnershipCoordinator.isServiceRunning(),
  if (c != null) 'controller': controllerSnapshot(c),
};

Map<String, dynamic> controllerSnapshot(DutyController c) => {
  'duty': c.authoritativeDutyState.name,
  'health': c.trackingHealth.name,
  'pending': c.pendingCleanupSession?.toString(),
  'error': c.lastError?.toString(),
  'cleanup': c.isCleanupRequired,
  'loading': c.isLoading,
  'logout': c.isLogoutInProgress,
  'active': c.activeSession?.toString(),
  'bound': c.boundUid,
};

// ============================================================================
// SECTION 2: CONTROLLER / LOCATION DEFINITIONS (Roots 2, 3, 4)
// ============================================================================

const sessionA = DutySession(uid: 'A', sessionId: 'census-S', generation: 2, lifecycleSeq: 7);

DriverProfile makeProfile(String uid, {bool on = true, int gen = 2, int seq = 7}) =>
    DriverProfile(
      uid: uid,
      name: 'Census Driver',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH01AB1234',
      verificationStatus: 'approved',
      isOnDuty: on,
      activeDutySessionId: on ? 'census-S' : null,
      dutyGeneration: gen,
      lifecycleSeq: on ? seq : null,
      workerReady: on,
    );

Map<String, dynamic> makeServerData(DriverProfile p) => {
  'uid': p.uid,
  'name': p.name,
  'phone': p.phone,
  'truckType': 'flatbed',
  'vehicleNumber': p.vehicleNumber,
  'verificationStatus': p.verificationStatus,
  'isOnDuty': p.isOnDuty,
  'activeDutySessionId': p.activeDutySessionId,
  'dutyGeneration': p.dutyGeneration,
  'lifecycleSeq': p.lifecycleSeq,
  'workerReady': p.workerReady,
  'activeJobId': p.activeJobId,
};

DurableDutyOwnerRecord makeRecord(DutySession d) => DurableDutyOwnerRecord(
  uid: d.uid,
  sessionId: d.sessionId,
  generation: d.generation,
  lifecycleSeq: d.lifecycleSeq!,
  startedAt: DateTime.utc(2026, 10, 2),
);

Map<String, Object?> controllerState(DutyController c) => {
  'uid': c.currentProfile?.uid,
  'profile': c.currentProfile,
  'duty': c.authoritativeDutyState,
  'health': c.trackingHealth,
  'desired': c.desiredDutyState,
  'ready': c.isReady,
  'loading': c.isLoading,
  'reconciling': c.isReconciling,
  'error': c.lastError,
  'errorCategory': c.errorCategory,
  'cleanup': c.isCleanupRequired,
  'pending': c.pendingCleanupSession,
  'cancellation': c.pendingCancellation,
  'active': c.activeSession,
  'seq': c.activeLifecycleSeq,
  'logout': c.isLogoutInProgress,
};

Map<String, Object?> snap(DutyController c) => {
  ...controllerState(c),
  'diagnostic': c.staleStartCleanupError,
  'cleanupCode': c.cleanupErrorCode,
  'cancelCode': c.cancellationErrorCode,
};

class CensusLocation extends f.TestLocationService {
  final calls = <String, int>{};
  final events = <String>[];
  final ends = <DutySession>[];
  final cancels = <Map<String, Object?>>[];
  final activations = <DutySession>[];
  DriverProfile fresh = makeProfile('A');
  DutySession? serverAuthority;
  Map<String, Object?>? preparedAuthority;
  String? gate;
  bool failure = false, endFailure = false, cancelFailure = false, stopFailure = false, forcedStartError = false;
  String stopFailureCode = 'CENSUS_STOP_FAILED';
  Future<void> Function()? endContinuation;
  final entered = Completer<void>(), release = Completer<void>();
  String? extraGate;
  Completer<void>? extraEntered, extraRelease;
  bool extraFailure = false;

  Future<void> hit(String operation) async {
    final n = (calls[operation] ?? 0) + 1;
    calls[operation] = n;
    events.add('$operation#$n');
    if (extraGate == '$operation#$n') {
      extraGate = null;
      extraEntered!.complete();
      await extraRelease!.future;
      if (extraFailure) throw PlatformException(code: 'CENSUS_SECOND_${operation}_FAILED');
    }
    if (gate == '$operation#$n') {
      gate = null;
      entered.complete();
      await release.future;
      if (failure) throw PlatformException(code: 'CENSUS_${operation}_FAILED');
    }
  }

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    await hit('owner');
    return currentSession == null ? null : makeRecord(currentSession!);
  }

  @override
  Future<DutySession?> getDurableSession() async {
    await hit('session');
    return currentSession;
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    await hit('running');
    return serviceRunning;
  }

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async {
    await hit('fresh');
    return makeServerData(fresh);
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    final target = DutySession(uid: uid, sessionId: sessionId, generation: generation!, lifecycleSeq: lifecycleSeq);
    ends.add(target);
    await endContinuation?.call();
    await hit('end');
    if (endFailure) throw PlatformException(code: 'CENSUS_END_FAILED');
    if (serverAuthority == target) serverAuthority = null;
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    await hit('transaction');
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    final target = DutySession(
      uid: expectedUid!,
      sessionId: expectedSessionId,
      generation: expectedGeneration!,
      lifecycleSeq: expectedLifecycleSeq,
    );
    exactStopRequests.add(target);
    await hit('stop');
    if (stopFailure) throw PlatformException(code: stopFailureCode);
    if (currentSession == target) {
      currentSession = null;
      serviceRunning = false;
    }
  }

  @override
  Future<bool> isLocationServiceEnabled() async {
    await hit('service');
    return serviceEnabled;
  }

  @override
  Future<LocationPermissionStatus> checkPermission() async {
    await hit('fg');
    return checkPermResult;
  }

  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async {
    await hit('bg');
    return reqBackgroundResult;
  }

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({required String uid, String? clientRequestId}) async {
    await hit('prepare');
    preparedAuthority = {'uid': uid, 'session': sessionA.sessionId, 'generation': 2, 'attempt': 3};
    return DutyActivationPreparation(sessionId: sessionA.sessionId, generation: sessionA.generation, attemptSeq: 3);
  }

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession)? onAuthorityAllocated,
  }) async {
    final exact = session.copyWith(lifecycleSeq: 7);
    currentSession = exact;
    serviceRunning = true;
    onAuthorityAllocated?.call(exact);
    await hit('start');
    if (forcedStartError) throw PlatformException(code: 'CENSUS_START_FAILED');
    return true;
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
    final target = DutySession(uid: uid, sessionId: sessionId, generation: generation!, lifecycleSeq: lifecycleSeq);
    activations.add(target);
    serverAuthority = target;
    await hit('activation');
    return {'status': 'activated', 'dutyGeneration': generation, 'lifecycleSeq': lifecycleSeq, 'workerReady': false};
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    cancels.add({'uid': uid, 'session': sessionId, 'generation': generation, 'seq': lifecycleSeq, 'attempt': attemptSeq});
    await hit('cancel');
    if (cancelFailure) throw PlatformException(code: 'CENSUS_CANCEL_FAILED');
    preparedAuthority = null;
  }
}

class NativeStarts extends CensusLocation {
  DutySession? nextExact;
  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession)? onAuthorityAllocated,
  }) async {
    final exact = nextExact ?? session.copyWith(lifecycleSeq: 7);
    currentSession = exact;
    serviceRunning = true;
    onAuthorityAllocated?.call(exact);
    await hit('start');
    return true;
  }
}

// Caller 2 helpers
DutySession c2Epoch(String uid, {String sid = 'audit-S', int gen = 2, int seq = 7}) =>
    DutySession(uid: uid, sessionId: sid, generation: gen, lifecycleSeq: seq);

DriverProfile c2Profile(DutySession s, {bool on = true}) => DriverProfile(
  uid: s.uid,
  name: 'Census',
  phone: '+919876543210',
  truckType: TruckType.flatbed,
  vehicleNumber: 'MH01AA1234',
  verificationStatus: 'approved',
  isOnDuty: on,
  activeDutySessionId: s.sessionId,
  dutyGeneration: s.generation,
  lifecycleSeq: s.lifecycleSeq,
  workerReady: on,
);

Map<String, Object?> c2Tuple(DutySession? s) => {
  'uid': s?.uid,
  'sid': s?.sessionId,
  'gen': s?.generation,
  'seq': s?.lifecycleSeq,
};

Map<String, Object?> c2Snapshot(DutyController c) => {
  'uid': c.currentProfile?.uid,
  'duty': c.authoritativeDutyState.name,
  'health': c.trackingHealth.name,
  'desired': c.desiredDutyState.name,
  'ready': c.isReady,
  'loading': c.isLoading,
  'reconciling': c.isReconciling,
  'logout': c.isLogoutInProgress,
  'pending': c2Tuple(c.pendingCleanupSession),
  'cancelUid': c.pendingCancelUid,
  'cancelSid': c.pendingCancelSessionId,
  'cancelGen': c.pendingCancellation?.generation,
  'cancelAttempt': c.pendingCancellation?.attemptSeq,
  'error': c.lastErrorCode,
  'cleanError': c.cleanupErrorCode,
  'cancelError': c.cancellationErrorCode,
  'cleanup': c.isCleanupRequired,
  'active': c2Tuple(c.activeSession),
  'deferred': c.deferredCompensation.length,
};

class C2CensusLocation extends f.TestLocationService {
  Future<void> Function(String)? hook;
  Object? stopError;
  int ownerCount = 0, sessionCount = 0, runningCount = 0;
  final ends = <DutySession>[];

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    final captured = currentSession == null ? null : makeRecord(currentSession!);
    await hook?.call('owner${++ownerCount}');
    return captured;
  }

  @override
  Future<DutySession?> getDurableSession() async {
    final captured = currentSession;
    await hook?.call('session${++sessionCount}');
    return captured;
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    final captured = serviceRunning;
    await hook?.call('running${++runningCount}');
    return captured;
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    ends.add(DutySession(uid: uid, sessionId: sessionId, generation: generation!, lifecycleSeq: lifecycleSeq));
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    final s = DutySession(
      uid: expectedUid!,
      sessionId: expectedSessionId,
      generation: expectedGeneration!,
      lifecycleSeq: expectedLifecycleSeq,
    );
    exactStopRequests.add(s);
    final capturedError = stopError;
    await hook?.call('stop');
    if (capturedError != null) throw capturedError;
    if (currentSession == s) {
      currentSession = null;
      serviceRunning = false;
    }
  }
}

Future<void> c2Debt(DutyController c, C2CensusLocation l, DutySession s, {String code = 'NEW_STOP_FAILED'}) async {
  l.currentSession = s;
  l.serviceRunning = true;
  l.mockLifecycleSeq = s.lifecycleSeq;
  l.stopError = PlatformException(code: code);
  c.updateProfile(c2Profile(s));
  expect(await c.requestGoOffDuty(), false);
  expect(c.pendingCleanupSession, s);
  expect(c.cleanupErrorCode, code);
  l.stopError = null;
}

// ============================================================================
// MAIN TEST SUITE: 8 INDEPENDENT AUDIT REPRODUCTIONS
// ============================================================================

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ROOT 1: Final Native Absence Freshness (F06 / F07)', () {
    late CensusAuth auth;
    late CensusLogoutLocation loc;
    DutyController? controller;

    setUp(() async {
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;
      DriverLocationService.resetPendingCleanupTokensForTesting();
      auth = CensusAuth();
      loc = CensusLogoutLocation();
      controller = null;
      await installNative(logoutOldSession);
    });

    tearDown(() async {
      controller?.dispose();
      await auth.changes.close();
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
      NativeOwnershipCoordinator.resetTestSimulation();
    });

    test('POST C5 late final coordinator owner:4 (Mounted Logout)', () async {
      controller = DutyController(locationService: loc, authService: auth);
      final boundary = 'owner:4';
      final held = LogoutGate();
      loc.gates[boundary] = held;

      final stale = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
        dutyController: controller,
      ).coordinateLogout();

      await held.entered.future.timeout(const Duration(seconds: 8));
      expect(loc.stops, [logoutOldSession]);
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
      expect(await NativeOwnershipCoordinator.isServiceRunning(), false);

      // Concurrent replacement starts G3/L8
      await installNative(logoutNewerSession);

      held.released.complete();
      final result = await stale;

      expect((await NativeOwnershipCoordinator.getDurableOwner())?.generation, 3);
      expect((await NativeOwnershipCoordinator.getDurableOwner())?.lifecycleSeq, 8);
      expect(await NativeOwnershipCoordinator.isServiceRunning(), true);
      expect(loc.stops, [logoutOldSession]);

      // Assertions from audit evidence: sign-out MUST be blocked!
      expect(auth.signouts, isEmpty, reason: 'live replacement is incompatible with stale absence sign-out');
      expect(auth.user?.uid, 'A');
      expect(result, LogoutResult.failedDutyTransition);
      expect(controller!.authoritativeDutyState, AuthoritativeDutyState.unknown);
    });

    test('POST C6 late final coordinator owner:4 (Unmounted Logout)', () async {
      final boundary = 'owner:4';
      final held = LogoutGate();
      loc.gates[boundary] = held;

      final stale = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
        dutyController: null,
      ).coordinateLogout();

      await held.entered.future.timeout(const Duration(seconds: 8));
      expect(loc.stops, [logoutOldSession]);
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
      expect(await NativeOwnershipCoordinator.isServiceRunning(), false);

      // Concurrent replacement starts G3/L8
      await installNative(logoutNewerSession);

      held.released.complete();
      final result = await stale;

      expect((await NativeOwnershipCoordinator.getDurableOwner())?.generation, 3);
      expect((await NativeOwnershipCoordinator.getDurableOwner())?.lifecycleSeq, 8);
      expect(await NativeOwnershipCoordinator.isServiceRunning(), true);
      expect(loc.stops, [logoutOldSession]);

      // Assertions from audit evidence: sign-out MUST be blocked!
      expect(auth.signouts, isEmpty, reason: 'live replacement is incompatible with stale absence sign-out');
      expect(auth.user?.uid, 'A');
      expect(result, LogoutResult.failedDutyTransition);
    });
  });

  group('ROOT 2: Failed Exact Server END Cleanup-Debt Retention / Retry (F09)', () {
    test('F09 exact retention and replay receiver=B repeatedFailure=true', () async {
      final auth = f.TestAuthService(f.FakeUser('A'));
      final loc = CensusLocation()..mockLifecycleSeq = 7;
      loc.currentPos = DriverPosition(latitude: 19, longitude: 73, timestamp: DateTime.utc(2026, 10, 2));
      final c = DutyController(locationService: loc, authService: auth);
      addTearDown(c.dispose);
      addTearDown(auth.dispose);

      c.updateProfile(makeProfile('A', on: false));
      loc.gate = 'activation#1';
      loc.endFailure = true;

      final old = c.requestGoOnDuty(onShowDisclosure: () async => true);
      await loc.entered.future.timeout(const Duration(seconds: 5));

      auth.emitUser(f.FakeUser('B'));
      await Future<void>.delayed(Duration.zero);
      c.updateProfile(makeProfile('B', on: false));

      final before = snap(c);
      var notes = 0;
      c.addListener(() => notes++);
      loc.release.complete();
      expect(await old, false);

      expect(snap(c), before);
      expect(notes, 0);
      expect(c.deferredCompensation.length, 1);
      final debt = c.deferredCompensation.single;
      expect(debt.source.uid, 'A');
      expect(debt.session, sessionA);
      expect(debt.serverDebt, true);
      expect(debt.serverEnded, false);

      // B retry issues no calls for A and retains debt
      final calls = loc.ends.length + loc.cancels.length;
      expect(await c.retryCleanup(), true);
      expect(loc.ends.length + loc.cancels.length, calls);
      expect(c.deferredCompensation.length, 1);

      // Switch back to A
      auth.emitUser(f.FakeUser('A'));
      await Future<void>.delayed(Duration.zero);
      c.clearOwnedAuthority();
      c.updateProfile(makeProfile('A', on: false));

      // Retry 1: fails again (repeatedFailure=true)
      final retry1 = await c.retryCleanup();
      expect(retry1, false);

      // Retry 2: end succeeds
      loc.endFailure = false;
      final callsBefore = loc.ends.length;
      final retry2 = await c.retryCleanup();
      expect(retry2, true);
      expect(
        loc.ends.length,
        callsBefore + 1,
        reason: 'a failed exact server cleanup retry must retain selectors for a later successful retry',
      );

      expect(loc.serverAuthority, isNull);
      expect(c.deferredCompensation, isEmpty);
      expect(c.isCleanupRequired, false);
      expect(loc.ends.every((s) => s == sessionA), true);
    });

    test('F09 exact retention and replay receiver=sameUIDlease repeatedFailure=true', () async {
      final auth = f.TestAuthService(f.FakeUser('A'));
      final loc = CensusLocation()..mockLifecycleSeq = 7;
      loc.currentPos = DriverPosition(latitude: 19, longitude: 73, timestamp: DateTime.utc(2026, 10, 2));
      final c = DutyController(locationService: loc, authService: auth);
      addTearDown(c.dispose);
      addTearDown(auth.dispose);

      c.updateProfile(makeProfile('A', on: false));
      loc.gate = 'activation#1';
      loc.endFailure = true;

      final old = c.requestGoOnDuty(onShowDisclosure: () async => true);
      await loc.entered.future.timeout(const Duration(seconds: 5));

      final lease = c.beginLogoutBarrier('A');
      final before = snap(c);
      var notes = 0;
      c.addListener(() => notes++);
      loc.release.complete();
      expect(await old, false);

      expect(snap(c), before);
      expect(c.deferredCompensation.length, 1);
      final debt = c.deferredCompensation.single;
      expect(debt.source.uid, 'A');
      expect(debt.session, sessionA);
      expect(debt.serverDebt, true);
      expect(debt.serverEnded, false);

      // End logout barrier
      c.endLogoutBarrier(lease);

      // Retry 1: fails again (repeatedFailure=true)
      final retry1 = await c.retryCleanup();
      expect(retry1, false);

      // Retry 2: end succeeds
      loc.endFailure = false;
      final callsBefore = loc.ends.length;
      final retry2 = await c.retryCleanup();
      expect(retry2, true);
      expect(
        loc.ends.length,
        callsBefore + 1,
        reason: 'a failed exact server cleanup retry must retain selectors for a later successful retry',
      );

      expect(loc.serverAuthority, isNull);
      expect(c.deferredCompensation, isEmpty);
      expect(c.isCleanupRequired, false);
      expect(loc.ends.every((s) => s == sessionA), true);
    });
  });

  group('ROOT 3: Type-B Stale Diagnostic Publication Isolation (F10)', () {
    test('F10 stale STOP failure cannot publish diagnostic into BcleanOff', () async {
      final auth = f.TestAuthService(f.FakeUser('A'));
      final loc = NativeStarts()..mockLifecycleSeq = 7;
      loc.currentPos = DriverPosition(latitude: 19, longitude: 73, timestamp: DateTime.utc(2026, 10, 2));
      final c = DutyController(locationService: loc, authService: auth);
      addTearDown(c.dispose);
      addTearDown(auth.dispose);

      c.updateProfile(makeProfile('A', on: false));
      expect(await c.requestGoOnDuty(onShowDisclosure: () async => true), true);

      loc.currentSession = null;
      loc.serviceRunning = false;
      c.updateProfile(makeProfile('A'));
      loc.fresh = makeProfile('A');

      loc.gate = 'start#2';
      final old = c.reconcileDutyState();
      await loc.entered.future.timeout(const Duration(seconds: 5));

      // Successor: UID B clean off
      auth.emitUser(f.FakeUser('B'));
      await Future<void>.delayed(Duration.zero);
      c.updateProfile(makeProfile('B', on: false));

      final held = Completer<void>(), released = Completer<void>();
      loc.currentSession = sessionA;
      loc.serviceRunning = true;
      loc.extraGate = 'stop#${(loc.calls['stop'] ?? 0) + 1}';
      loc.extraEntered = held;
      loc.extraRelease = released;
      loc.extraFailure = true;

      loc.release.complete();
      await held.future.timeout(const Duration(seconds: 5));

      loc.currentSession = null;
      loc.serviceRunning = false;

      final before = snap(c);
      var notes = 0;
      c.addListener(() => notes++);
      released.complete();
      await old;

      expect(
        c.staleStartCleanupError,
        before['diagnostic'],
        reason: 'operation ownership remains stale even without an active logout lease or a different UID native worker',
      );
      expect(snap(c), before);
      expect(notes, 0);
    });

    test('F10 stale STOP failure cannot publish diagnostic into sameUIDreleasedLease', () async {
      final auth = f.TestAuthService(f.FakeUser('A'));
      final loc = NativeStarts()..mockLifecycleSeq = 7;
      loc.currentPos = DriverPosition(latitude: 19, longitude: 73, timestamp: DateTime.utc(2026, 10, 2));
      final c = DutyController(locationService: loc, authService: auth);
      addTearDown(c.dispose);
      addTearDown(auth.dispose);

      c.updateProfile(makeProfile('A', on: false));
      expect(await c.requestGoOnDuty(onShowDisclosure: () async => true), true);

      loc.currentSession = null;
      loc.serviceRunning = false;
      c.updateProfile(makeProfile('A'));
      loc.fresh = makeProfile('A');

      loc.gate = 'start#2';
      final old = c.reconcileDutyState();
      await loc.entered.future.timeout(const Duration(seconds: 5));

      // Successor: same UID begins and releases a logout lease
      final lease = c.beginLogoutBarrier('A');
      c.endLogoutBarrier(lease);

      final held = Completer<void>(), released = Completer<void>();
      loc.currentSession = sessionA;
      loc.serviceRunning = true;
      loc.extraGate = 'stop#${(loc.calls['stop'] ?? 0) + 1}';
      loc.extraEntered = held;
      loc.extraRelease = released;
      loc.extraFailure = true;

      loc.release.complete();
      await held.future.timeout(const Duration(seconds: 5));

      loc.nextExact = const DutySession(uid: 'A', sessionId: 'census-S', generation: 3, lifecycleSeq: 8);
      expect(await loc.startForegroundService(session: loc.nextExact!), true);

      final before = snap(c);
      var notes = 0;
      c.addListener(() => notes++);
      released.complete();
      await old;

      expect(
        c.staleStartCleanupError,
        before['diagnostic'],
        reason: 'operation ownership remains stale even without an active logout lease or a different UID native worker',
      );
      expect(snap(c), before);
      expect(notes, 0);
      expect(loc.currentSession, loc.nextExact);
      expect(loc.serviceRunning, true);
    });

    test('F10 stale STOP failure cannot publish diagnostic into sameUIDordinaryGoOff', () async {
      final auth = f.TestAuthService(f.FakeUser('A'));
      final loc = NativeStarts()..mockLifecycleSeq = 7;
      loc.currentPos = DriverPosition(latitude: 19, longitude: 73, timestamp: DateTime.utc(2026, 10, 2));
      final c = DutyController(locationService: loc, authService: auth);
      addTearDown(c.dispose);
      addTearDown(auth.dispose);

      c.updateProfile(makeProfile('A', on: false));
      expect(await c.requestGoOnDuty(onShowDisclosure: () async => true), true);

      loc.currentSession = null;
      loc.serviceRunning = false;
      c.updateProfile(makeProfile('A'));
      loc.fresh = makeProfile('A');

      loc.gate = 'start#2';
      final old = c.reconcileDutyState();
      await loc.entered.future.timeout(const Duration(seconds: 5));

      // Successor: same UID enqueues ordinary go-off
      final newOff = c.requestGoOffDuty();

      final held = Completer<void>(), released = Completer<void>();
      loc.currentSession = sessionA;
      loc.serviceRunning = true;
      loc.extraGate = 'stop#${(loc.calls['stop'] ?? 0) + 1}';
      loc.extraEntered = held;
      loc.extraRelease = released;
      loc.extraFailure = true;

      loc.release.complete();
      await held.future.timeout(const Duration(seconds: 5));

      loc.nextExact = const DutySession(uid: 'A', sessionId: 'census-S', generation: 3, lifecycleSeq: 8);
      expect(await loc.startForegroundService(session: loc.nextExact!), true);

      final before = snap(c);
      var notes = 0;
      c.addListener(() => notes++);
      released.complete();
      await old;
      await newOff;

      expect(
        c.staleStartCleanupError,
        before['diagnostic'],
        reason: 'operation ownership remains stale even without an active logout lease or a different UID native worker',
      );
    });
  });

  group('ROOT 4: Older Cleanup Proof vs Newer Completed Retry (F01–F04 / C2)', () {
    test('F01-F04 newer same-debt concurrent retry success survives older absence-read failure', () async {
      final auth = f.TestAuthService(f.FakeUser('A'));
      final loc = C2CensusLocation();
      final c = DutyController(locationService: loc, authService: auth);
      addTearDown(c.dispose);
      addTearDown(auth.dispose);

      await c2Debt(c, loc, c2Epoch('A'), code: 'INITIAL_STOP_FAILED');
      loc.ownerCount = loc.sessionCount = loc.runningCount = 0;

      final held = Completer<void>(), release = Completer<void>();
      var gated = false;
      loc.hook = (operation) async {
        if (operation == 'owner1' && !gated) {
          gated = true;
          held.complete();
          await release.future;
          throw PlatformException(code: 'OLD_ABSENCE_READ_FAILED');
        }
      };

      final old = c.retryCleanup();
      await held.future.timeout(const Duration(seconds: 5));
      expect(loc.currentSession, isNull);
      expect(loc.serviceRunning, false);

      loc.hook = null;
      // Newer retry completes successfully
      expect(await c.retryCleanup(), true);

      final before = c2Snapshot(c);
      var notes = 0;
      c.addListener(() => notes++);

      // Release older retry's held absence read with failure
      release.complete();
      await old;
      final after = c2Snapshot(c);

      expect(
        after,
        before,
        reason: 'the older absence proof continuation cannot overwrite the newer completed retry',
      );
      expect(notes, 0);
    });
  });
}
