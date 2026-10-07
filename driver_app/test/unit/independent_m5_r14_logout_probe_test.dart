import 'package:flutter/foundation.dart';
import 'dart:async';

import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';

class ProbeUser implements User {
  @override
  final String uid;
  ProbeUser(this.uid);
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class ProbeAuth extends AuthService {
  User? user = ProbeUser('A');
  final changes = StreamController<User?>.broadcast();
  final signouts = <String?>[];
  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => changes.stream;
  @override
  Future<void> signOut() async {
    signouts.add(user?.uid);
    user = null;
  }
}

class ReadGate {
  final entered = Completer<void>();
  final release = Completer<void>();
  final bool snapshotFirst;
  ReadGate({this.snapshotFirst = false});
  Future<void> wait() async {
    entered.complete();
    await release.future;
  }
}

// Only server responses and scheduling are stubbed. Native discovery and STOP
// use the CURRENT production DriverLocationService and native model adapter.
class ProbeLocation extends DriverLocationService {
  final gates = <String, ReadGate>{};
  final visits = <String, int>{};
  final stops = <DutySession>[];
  final ends = <DutySession>[];
  bool serverOn = false;
  int serverReads = 0;
  ReadGate? nextGate(String kind) {
    final visit = visits.update(kind, (v) => v + 1, ifAbsent: () => 1);
    return gates['$kind:$visit'];
  }
  Future<T> read<T>(String kind, Future<T> Function() actual) async {
    final gate = nextGate(kind);
    if (gate == null) return actual();
    if (gate.snapshotFirst) {
      final snapshot = await actual();
      await gate.wait();
      return snapshot;
    }
    await gate.wait();
    return actual();
  }
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async {
    serverReads++;
    return {
      'uid': uid,
      'name': 'Independent Audit Driver',
      'phone': '+919876543210',
      'truckType': 'flatbed',
      'vehicleNumber': 'MH 12 AB 1234',
      'isOnDuty': serverOn,
      'verificationStatus': 'approved',
      if (serverOn) 'activeDutySessionId': 'S',
      if (serverOn) 'dutyGeneration': 2,
      if (serverOn) 'lifecycleSeq': 7,
    };
  }
  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() =>
      read('owner', super.getDurableOwnerRecord);
  @override
  Future<DutySession?> getDurableSession() =>
      read('session', super.getDurableSession);
  @override
  Future<bool> isForegroundServiceRunning() =>
      read('running', super.isForegroundServiceRunning);
  @override
  Future<void> endDutySessionCall({required String uid,
    required String sessionId, int? generation, int? lifecycleSeq}) async {
    ends.add(DutySession(uid: uid, sessionId: sessionId,
      generation: generation!, lifecycleSeq: lifecycleSeq));
    await nextGate('end')?.wait();
    serverOn = false;
  }
  @override
  Future<void> stopForegroundService({String? expectedUid,
    required String expectedSessionId, int? expectedGeneration,
    int? expectedLifecycleSeq}) async {
    stops.add(DutySession(uid: expectedUid!, sessionId: expectedSessionId,
      generation: expectedGeneration!, lifecycleSeq: expectedLifecycleSeq));
    await nextGate('stop')?.wait();
    await super.stopForegroundService(expectedUid: expectedUid,
      expectedSessionId: expectedSessionId,
      expectedGeneration: expectedGeneration,
      expectedLifecycleSeq: expectedLifecycleSeq);
  }
}

const old = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 7);
const other = DutySession(uid: 'B', sessionId: 'B-S', generation: 3, lifecycleSeq: 8);
const newer = DutySession(uid: 'A', sessionId: 'S', generation: 3, lifecycleSeq: 8);

Future<void> install(DutySession epoch) async {
  final result = await NativeOwnershipCoordinator.atomicStartService(
    record: DurableDutyOwnerRecord(uid: epoch.uid, sessionId: epoch.sessionId,
      generation: epoch.generation, lifecycleSeq: epoch.lifecycleSeq!,
      startedAt: DateTime.utc(2026, 10, 1)),
    foregroundTaskOptionsMap: {'callbackHandle': 1});
  expect(result['success'], true);
}

Future<void> survives(DutySession epoch, ProbeAuth auth) async {
  final owner = await NativeOwnershipCoordinator.getDurableOwner();
  expect(owner?.uid, epoch.uid, reason: 'replacement owner UID survives');
  expect(owner?.sessionId, epoch.sessionId);
  expect(owner?.generation, epoch.generation);
  expect(owner?.lifecycleSeq, epoch.lifecycleSeq);
  expect(await DriverLocationService().getDurableSession(), epoch);
  expect(await NativeOwnershipCoordinator.isServiceRunning(), true);
  expect(await NativeOwnershipCoordinator.getWorkerPayload(), isNotNull);
  expect(auth.signouts, isEmpty);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ProbeAuth auth;
  late ProbeLocation location;
  setUp(() async {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    NativeOwnershipCoordinator.resetTestSimulation();
    DriverLocationService.resetPendingCleanupTokensForTesting();
    NativeOwnershipCoordinator.useTestSimulation = true;
    auth = ProbeAuth();
    location = ProbeLocation();
    await install(old);
  });
  tearDown(() async {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    NativeOwnershipCoordinator.resetTestSimulation();
    await auth.changes.close();
  });

  for (final boundary in ['owner:1', 'running:1', 'session:1', 'end:1',
    'stop:1', 'running:2', 'owner:2', 'session:2']) {
    test('fresh R14-C6 A to B replacement at $boundary', () async {
      final gate = ReadGate(snapshotFirst: boundary == 'session:1' ||
        boundary == 'session:2');
      location.gates[boundary] = gate;
      location.serverOn = boundary == 'end:1';
      final operation = AppLogoutCoordinator(authService: auth,
        locationService: location).coordinateLogout();
      await gate.entered.future;
      auth.user = ProbeUser('B');
      await install(other);
      gate.release.complete();
      final result = await operation;
      debugPrint('TRACE $boundary result=$result stops=${location.stops} '
        'auth=${auth.user?.uid}');
      expect(result, LogoutResult.failedDutyTransition);
      expect(location.stops.where((s) => s.uid == 'B'), isEmpty);
      await survives(other, auth);
      expect(auth.user?.uid, 'B');
    });
  }

  for (final mounted in [false, true]) {
    test('fresh R14-C6 same UID operation supersession mounted=$mounted', () async {
      final oldGate = ReadGate();
      final newGate = ReadGate();
      location.gates['owner:1'] = oldGate;
      location.gates['owner:2'] = newGate;
      final controller = mounted ? DutyController(locationService: location,
        authService: auth) : null;
      addTearDown(() => controller?.dispose());
      final coordinator = AppLogoutCoordinator(authService: auth,
        locationService: location, dutyController: controller);
      final a1 = coordinator.coordinateLogout();
      await oldGate.entered.future;
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
      await install(newer);
      final a2 = coordinator.coordinateLogout();
      await newGate.entered.future;
      oldGate.release.complete();
      expect(await a1, LogoutResult.failedDutyTransition);
      expect(location.stops, isEmpty);
      await survives(newer, auth);
      if (mounted) expect(controller!.isLogoutInProgress, true);
      final reads = location.serverReads;
      final joined = coordinator.coordinateLogout();
      expect(location.serverReads, reads, reason: 'A1 did not remove A2 flight');
      newGate.release.complete();
      expect(await a2, LogoutResult.success);
      expect(await joined, LogoutResult.success);
      expect(location.stops, [newer]);
      expect(auth.signouts, ['A']);
    });
  }

  test('fresh R14-C6 newer native epoch during owner discovery cannot be adopted', () async {
    final gate = ReadGate();
    location.gates['owner:1'] = gate;
    final operation = AppLogoutCoordinator(authService: auth,
      locationService: location).coordinateLogout();
    await gate.entered.future;
    await install(newer);
    gate.release.complete();
    final result = await operation;
    final owner = await NativeOwnershipCoordinator.getDurableOwner();
    final running = await NativeOwnershipCoordinator.isServiceRunning();
    debugPrint('TRACE same UID native replacement result=$result '
      'stops=${location.stops} owner=${owner?.toMap()} running=$running '
      'signouts=${auth.signouts}');
    expect(location.stops.where((s) => s == newer), isEmpty,
      reason: 'post-await discovery is current state, not stale cleanup authority');
    await survives(newer, auth);
    expect(result, LogoutResult.failedDutyTransition);
  });
}
