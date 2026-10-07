import 'dart:async';
import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';

// Written from current production source during this independent audit.
// Production controllers, logout coordinator, Dart adapter and exact atomic
// ownership simulator execute directly; no prior probe is imported.
class AuditUser implements User {
  AuditUser(this.uid);
  @override
  final String uid;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class AuditAuth extends AuthService {
  AuditAuth(String uid) : user = AuditUser(uid);
  User? user;
  final events = StreamController<User?>.broadcast(sync: true);
  int signOutCalls = 0;
  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => events.stream;
  void switchUid(String uid) {
    user = AuditUser(uid);
    events.add(user);
  }
  @override
  Future<void> signOut() async {
    signOutCalls++;
    user = null;
    events.add(null);
  }
}

DurableDutyOwnerRecord owner(String uid, {String sid = 'S1', int gen = 7, int seq = 11}) =>
    DurableDutyOwnerRecord(uid: uid, sessionId: sid, generation: gen,
        lifecycleSeq: seq, startedAt: DateTime.utc(2026, 10, 1));

DutySession session(DurableDutyOwnerRecord o) => DutySession(
    uid: o.uid, sessionId: o.sessionId, generation: o.generation,
    lifecycleSeq: o.lifecycleSeq);

DriverProfile profile(String uid, {bool on = false, String status = 'approved',
    String? job, String? offer, DurableDutyOwnerRecord? epoch}) => DriverProfile(
    uid: uid, name: 'Independent audit', phone: '+919876543210',
    truckType: TruckType.flatbed, vehicleNumber: 'MH01AA1234',
    isOnDuty: on, verificationStatus: status, activeJobId: job,
    activeOfferId: offer, activeDutySessionId: epoch?.sessionId,
    dutyGeneration: epoch?.generation, lifecycleSeq: epoch?.lifecycleSeq,
    workerReady: on);

Map<String, dynamic> server(DriverProfile p) => {
  'uid': p.uid, 'name': p.name, 'phone': p.phone,
  'truckType': p.truckType.backendValue, 'vehicleNumber': p.vehicleNumber,
  'isOnDuty': p.isOnDuty, 'verificationStatus': p.verificationStatus,
  'activeJobId': p.activeJobId, 'activeOfferId': p.activeOfferId,
  'activeDutySessionId': p.activeDutySessionId, 'dutyGeneration': p.dutyGeneration,
  'lifecycleSeq': p.lifecycleSeq, 'workerReady': p.workerReady,
};

Future<void> install(DurableDutyOwnerRecord o) async {
  final r = await NativeOwnershipCoordinator.atomicStartService(record: o,
      foregroundTaskOptionsMap: {'callbackHandle': 1});
  expect(r['success'], isTrue);
}

class AuditLocation extends DriverLocationService {
  final stops = <List<Object?>>[];
  final ends = <List<Object?>>[];
  final cancels = <List<Object?>>[];
  int acquisitions = 0;
  int releases = 0;
  int ownerReads = 0;
  bool serviceEnabled = true;
  Object? startError;
  Object? activationError;
  Object? stopError;
  int? stopErrorCall;
  Object? endError;
  bool stopNoop = false;
  Future<void> Function()? beforeStop;
  Future<void> Function()? beforeEnd;
  Future<void> Function()? beforeActivate;
  Future<void> Function()? afterAcquire;
  Future<DurableDutyOwnerRecord?> Function(int read)? ownerHook;
  Map<String, dynamic> Function(String uid)? serverData;
  Future<Map<String, dynamic>?> Function(String uid)? serverHook;
  @override
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(String op, String uid) async {
    acquisitions++;
    final lease = await super.beginCleanupAcquisition(op, uid);
    await afterAcquire?.call();
    return lease;
  }
  @override
  Future<void> releaseCleanupAcquisition(NativeCleanupAcquisition lease) async {
    releases++;
    await super.releaseCleanupAcquisition(lease);
  }
  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    ownerReads++;
    return ownerHook == null ? super.getDurableOwnerRecord() : ownerHook!(ownerReads);
  }
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async =>
      serverHook != null ? serverHook!(uid) : serverData?.call(uid) ?? server(profile(uid));
  @override
  Future<void> endDutySessionCall({required String uid, required String sessionId,
      int? generation, int? lifecycleSeq}) async {
    ends.add([uid, sessionId, generation, lifecycleSeq]);
    await beforeEnd?.call();
    if (endError != null) throw endError!;
  }
  @override
  Future<void> stopForegroundService({String? expectedUid,
      required String expectedSessionId, int? expectedLifecycleSeq,
      int? expectedGeneration}) async {
    stops.add([expectedUid, expectedSessionId, expectedGeneration, expectedLifecycleSeq]);
    final callIndex = stops.length;
    await beforeStop?.call();
    if (stopError != null && (stopErrorCall == null || stopErrorCall == callIndex)) {
      throw stopError!;
    }
    if (stopNoop) return;
    await super.stopForegroundService(expectedUid: expectedUid,
        expectedSessionId: expectedSessionId, expectedGeneration: expectedGeneration,
        expectedLifecycleSeq: expectedLifecycleSeq);
  }
  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;
  @override
  Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async => LocationPermissionStatus.granted;
  @override
  Future<DriverPosition?> getCurrentPosition() async => DriverPosition(
      latitude: 19, longitude: 73, timestamp: DateTime.utc(2026, 10, 1));
  @override
  Future<DutyActivationPreparation> prepareDutyActivation({required String uid,
      String? clientRequestId}) async => const DutyActivationPreparation(
          sessionId: 'S1', generation: 7, attemptSeq: 3);
  @override
  Future<bool> startForegroundService({required DutySession session,
      String? notificationTitle, String? notificationText,
      void Function(DutySession authority)? onAuthorityAllocated}) async {
    final o = owner(session.uid, sid: session.sessionId, gen: session.generation);
    onAuthorityAllocated?.call(session.copyWith(lifecycleSeq: o.lifecycleSeq));
    await install(o);
    if (startError != null) throw startError!;
    return true;
  }
  @override
  Future<Map<String, dynamic>> startDutySessionCall({required String uid,
      required String sessionId, required DriverPosition initialLocation,
      int? lifecycleSeq, int? generation, int? attemptSeq}) async {
    await beforeActivate?.call();
    if (activationError != null) throw activationError!;
    return {'status': 'activated', 'dutyGeneration': generation,
      'lifecycleSeq': lifecycleSeq, 'workerReady': false};
  }
  @override
  Future<void> cancelDutyActivationCall({required String uid,
      required String sessionId, int? generation, int? lifecycleSeq,
      int? attemptSeq}) async {
    cancels.add([uid, sessionId, generation, lifecycleSeq, attemptSeq]);
  }
}

Map<String, Object?>? authority(DutySession? s) => s == null ? null : {
  'uid': s.uid, 'sessionId': s.sessionId, 'generation': s.generation,
  'lifecycleSeq': s.lifecycleSeq,
};

Map<String, Object?> state(DutyController c) => {
  'profileUid': c.currentProfile?.uid,
  'authoritativeDutyState': c.authoritativeDutyState.name,
  'trackingHealth': c.trackingHealth.name,
  'error': c.lastErrorCode,
  'errorMessage': c.lastErrorMessage,
  'startupError': c.startupErrorCode,
  'cleanupError': c.cleanupErrorCode,
  'errorCategory': c.errorCategory?.name,
  'cleanupRequired': c.isCleanupRequired,
  'loading': c.isLoading,
  'activeAuthority': authority(c.activeSession),
  'pendingCleanupAuthority': authority(c.pendingCleanupSession),
  'pendingCancellation': c.pendingCancelSessionId,
  'reconciling': c.isReconciling,
  'logout': c.isLogoutInProgress,
  'desiredDutyState': c.desiredDutyState.name,
};

Future<void> flush() async {
  for (var n = 0; n < 8; n++) { await Future<void>.delayed(Duration.zero); }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    NativeOwnershipCoordinator.useTestSimulation = true;
    DriverLocationService.resetPendingCleanupTokensForTesting();
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
  });
  tearDown(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
  });

  test('compensation current startup exception preserves truthful cleanup failure', () async {
    final a = AuditAuth('A');
    final l = AuditLocation()..startError = PlatformException(code: 'STARTUP_A')
      ..stopError = PlatformException(code: 'STOP_A')..stopErrorCall = 1;
    final c = DutyController(locationService: l, authService: a)..updateProfile(profile('A'));
    expect(await c.requestGoOnDuty(onShowDisclosure: () async => true), isFalse);
    expect(c.lastErrorCode, 'STARTUP_A');
    expect(c.cleanupErrorCode, 'STOP_A');
    expect(c.isCleanupRequired, isTrue);
    expect(l.stops, [['A', 'S1', 7, 11]]);
    expect(l.cancels, [['A', 'S1', 7, 11, 3]]);
    c.dispose();
  });

  test('compensation held STOP failure cannot mutate clean replacement UID', () async {
    final a = AuditAuth('A');
    final entered = Completer<void>();
    final release = Completer<void>();
    final l = AuditLocation()..startError = PlatformException(code: 'STARTUP_A')
      ..stopError = PlatformException(code: 'STOP_A')..stopErrorCall = 1;
    l.beforeStop = () async { if (!entered.isCompleted) entered.complete(); await release.future; };
    final c = DutyController(locationService: l, authService: a)..updateProfile(profile('A'));
    addTearDown(c.dispose);
    final old = c.requestGoOnDuty(onShowDisclosure: () async => true);
    await entered.future;
    a.switchUid('B');
    c.updateProfile(profile('B'));
    final before = state(c);
    expect(c.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(c.trackingHealth, TrackingHealth.off);
    expect(c.lastError, isNull);
    expect(c.isCleanupRequired, isFalse);
    release.complete();
    expect(await old, isFalse);
    await flush();
    // The auth listener also stops captured A authority on the UID switch.
    // Both calls carry A's exact epoch; this is a state-isolation failure.
    expect(l.stops, [['A', 'S1', 7, 11], ['A', 'S1', 7, 11]]);
    expect(l.ends, isEmpty);
    expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
    expect(a.currentUser?.uid, 'B');
    // ignore: avoid_print
    print(jsonEncode({'scenario': 'R14 stale startup compensation',
      'before': before, 'after': state(c), 'END': l.ends, 'STOP': l.stops,
      'CANCEL': l.cancels, 'authUid': a.currentUser?.uid, 'nativeOwner': null}));
    // Literal full snapshot comparison catches state, error, cleanup and authority mutation.
    expect(state(c), before, reason: 'stale A compensation must not mutate B');
  });
}
