import 'dart:async';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';

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

class Gate {
  final entered = Completer<void>(), released = Completer<void>();
  final bool fail;
  Gate({this.fail = false});
  Future<void> wait() async {
    entered.complete();
    await released.future;
    if (fail) throw StateError('CENSUS_HELD_FAILURE');
  }
}

class CensusLocation extends DriverLocationService {
  final gates = <String, Gate>{};
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

  Gate? gate(String kind) {
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
    ends.add(DutySession(
      uid: uid,
      sessionId: sessionId,
      generation: generation!,
      lifecycleSeq: lifecycleSeq,
    ));
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

const oldSession = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 7);
const otherSession = DutySession(uid: 'B', sessionId: 'B-S', generation: 3, lifecycleSeq: 8);
const newerSession = DutySession(uid: 'A', sessionId: 'S', generation: 3, lifecycleSeq: 8);

Future<void> installSession(DutySession tuple) async {
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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Batch 1 Groups B & C (F05–F07) Logout Reentrancy & Native Absence Regressions', () {
    late CensusAuth auth;
    late CensusLocation loc;
    DutyController? controller;

    setUp(() async {
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;
      DriverLocationService.resetPendingCleanupTokensForTesting();
      auth = CensusAuth();
      loc = CensusLocation();
      controller = null;
      await installSession(oldSession);
    });

    tearDown(() async {
      controller?.dispose();
      await auth.changes.close();
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
      NativeOwnershipCoordinator.resetTestSimulation();
    });

    test('F05: C5 final success notification replaces same-UID lease before coordinator clear/signout', () async {
      controller = DutyController(locationService: loc, authService: auth);
      LogoutBarrierLease? replacementLease;
      var installed = false;
      controller!.addListener(() {
        if (!installed &&
            controller!.authoritativeDutyState == AuthoritativeDutyState.offDuty &&
            controller!.trackingHealth == TrackingHealth.off &&
            controller!.isLogoutInProgress) {
          installed = true;
          replacementLease = controller!.beginLogoutBarrier('A');
        }
      });
      final result = await AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
        dutyController: controller,
      ).coordinateLogout();

      expect(installed, true);
      expect(auth.signouts, isEmpty, reason: 'old logout lease lost at notify may not sign out newer logout');
      expect(controller!.isLogoutInProgress, true);
      expect(replacementLease, isNotNull);
      expect(result, LogoutResult.failedDutyTransition);
    });

    for (final mounted in [true, false]) {
      test('F06/F07: C${mounted ? 5 : 6} final absence reply predates same-UID epoch replacement (mounted=$mounted)', () async {
        if (mounted) controller = DutyController(locationService: loc, authService: auth);
        final boundary = mounted ? 'session:2' : 'running:3';
        final held = Gate();
        loc.gates[boundary] = held;
        final stale = AppLogoutCoordinator(
          authService: auth,
          locationService: loc,
          dutyController: controller,
        ).coordinateLogout();

        await held.entered.future;
        await installSession(newerSession);
        held.released.complete();
        final result = await stale;

        expect(auth.signouts, isEmpty, reason: 'replacement native authority is not global absence');
        expect(result, LogoutResult.failedDutyTransition);
        expect((await NativeOwnershipCoordinator.getDurableOwner())?.lifecycleSeq, 8);
        expect(await NativeOwnershipCoordinator.isServiceRunning(), true);
      });
    }

    test('C6 stale acquisition release preserves newer same-UID acquisition', () async {
      final held = Gate();
      loc.gates['release:1'] = held;
      final stale = AppLogoutCoordinator(authService: auth, locationService: loc).coordinateLogout();
      await held.entered.future;
      final newerLease = await NativeOwnershipCoordinator.beginCleanupAcquisition('new-receiver', 'A');
      held.released.complete();
      expect(await stale, LogoutResult.success);
      expect(await NativeOwnershipCoordinator.validateCleanupAcquisition(newerLease), true);
      expect(await NativeOwnershipCoordinator.validateCleanupAcquisition(loc.leases.single), false);
      await NativeOwnershipCoordinator.releaseCleanupAcquisition(newerLease);
    });

    for (final mounted in [false, true]) {
      test('C${mounted ? 5 : 6} normal exact residual cleanup succeeds and signs out', () async {
        if (mounted) controller = DutyController(locationService: loc, authService: auth);
        loc.serverOn = true;
        expect(
          await AppLogoutCoordinator(
            authService: auth,
            locationService: loc,
            dutyController: controller,
          ).coordinateLogout(),
          LogoutResult.success,
        );
        expect(loc.stops, [oldSession]);
        expect(loc.ends, [oldSession]);
        expect(auth.signouts, ['A']);
        expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
        expect(await NativeOwnershipCoordinator.isServiceRunning(), false);
      });
    }
  });
}
