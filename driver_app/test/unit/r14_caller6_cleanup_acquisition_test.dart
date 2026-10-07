import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'r14_caller6_logout_ownership_test.dart' as f;
import 'independent_m5_r14_logout_probe_test.dart' as p;

class SeparateServerAuthorityService extends f.LogoutDiscoveryService {
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => {
    ...?await super.fetchServerDriverState(uid),
    'isOnDuty': true,
    'activeDutySessionId': 'server-session',
    'dutyGeneration': 4,
    'lifecycleSeq': 10,
  };
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const old = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 2,
    lifecycleSeq: 7,
  );
  setUp(AppLogoutCoordinator.resetInFlightLogoutForTesting);
  tearDown(AppLogoutCoordinator.resetInFlightLogoutForTesting);
  for (final replacement in [
    const DutySession(
      uid: 'uid-a',
      sessionId: 'session-a',
      generation: 3,
      lifecycleSeq: 8,
    ),
    const DutySession(
      uid: 'uid-a',
      sessionId: 'session-a',
      generation: 2,
      lifecycleSeq: 8,
    ),
    const DutySession(
      uid: 'uid-b',
      sessionId: 'session-b',
      generation: 3,
      lifecycleSeq: 8,
    ),
  ]) {
    test(
      'C6-ACQ replacement inside STOP retains captured selector $replacement',
      () async {
        final auth = f.LogoutAuth();
        final location = f.LogoutDiscoveryService()
          ..currentSession = old
          ..mockLifecycleSeq = 7
          ..serviceRunning = true
          ..holdStop = true;
        addTearDown(auth.dispose);
        final operation = AppLogoutCoordinator(
          authService: auth,
          locationService: location,
        ).coordinateLogout();
        await location.entered.future;
        location.currentSession = replacement;
        location.mockLifecycleSeq = replacement.lifecycleSeq;
        location.released.complete();
        expect(await operation, LogoutResult.failedDutyTransition);
        expect(location.exactStopRequests, [old]);
        expect(location.currentSession, replacement);
        expect(location.serviceRunning, true);
        expect(auth.signedOut, isEmpty);
        expect(location.cleanupLeases, isEmpty);
      },
    );
  }
  test(
    'C6-ACQ no owner captured then owner appears is conflict only',
    () async {
      final auth = f.LogoutAuth();
      final location = f.LogoutDiscoveryService()..heldRead = 'owner';
      addTearDown(auth.dispose);
      final operation = AppLogoutCoordinator(
        authService: auth,
        locationService: location,
      ).coordinateLogout();
      await location.entered.future;
      location.currentSession = old;
      location.serviceRunning = true;
      location.released.complete();
      expect(await operation, LogoutResult.failedDutyTransition);
      expect(location.exactStopRequests, isEmpty);
      expect(location.currentSession, old);
      expect(auth.signedOut, isEmpty);
      expect(location.cleanupLeases, isEmpty);
    },
  );
  test('C6-ACQ mixed discovery never changes acquisition', () async {
    final auth = f.LogoutAuth();
    final location = f.LogoutDiscoveryService()
      ..currentSession = old
      ..mockLifecycleSeq = 7
      ..serviceRunning = true
      ..heldRead = 'session';
    addTearDown(auth.dispose);
    final operation = AppLogoutCoordinator(
      authService: auth,
      locationService: location,
    ).coordinateLogout();
    await location.entered.future;
    const newer = DutySession(
      uid: 'uid-a',
      sessionId: 'session-a',
      generation: 2,
      lifecycleSeq: 8,
    );
    expect(location.cleanupLeases.values.single.owner?.lifecycleSeq, 7);
    location.currentSession = newer;
    location.released.complete();
    expect(await operation, LogoutResult.failedDutyTransition);
    expect(location.exactStopRequests, isEmpty);
    expect(location.currentSession, newer);
    expect(auth.signedOut, isEmpty);
  });
  test(
    'C6-ACQ server END and native STOP use independent captured authorities',
    () async {
      final auth = f.LogoutAuth();
      final location = SeparateServerAuthorityService()
        ..currentSession = old
        ..mockLifecycleSeq = 7
        ..serviceRunning = true;
      addTearDown(auth.dispose);
      expect(
        await AppLogoutCoordinator(
          authService: auth,
          locationService: location,
        ).coordinateLogout(),
        LogoutResult.success,
      );
      expect(location.ends, [
        const DutySession(
          uid: 'uid-a',
          sessionId: 'server-session',
          generation: 4,
          lifecycleSeq: 10,
        ),
      ]);
      expect(location.exactStopRequests, [old]);
      expect(auth.signedOut, ['uid-a']);
    },
  );
  for (final boundary in ['running:2', 'owner:2', 'session:2']) {
    test('C6-ACQ replacement during absence verification $boundary', () async {
      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;
      addTearDown(NativeOwnershipCoordinator.resetTestSimulation);
      await p.install(p.old);
      final auth = p.ProbeAuth();
      addTearDown(auth.changes.close);
      final location = p.ProbeLocation();
      final gate = p.ReadGate(snapshotFirst: true);
      location.gates[boundary] = gate;
      final operation = AppLogoutCoordinator(
        authService: auth,
        locationService: location,
      ).coordinateLogout();
      await gate.entered.future;
      await p.install(p.newer);
      gate.release.complete();
      expect(await operation, LogoutResult.failedDutyTransition);
      expect(location.stops, [p.old]);
      await p.survives(p.newer, auth);
    });
  }
}
