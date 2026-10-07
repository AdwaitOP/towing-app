import 'dart:async';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'duty_controller_test.dart' as f;

class LogoutAuth extends f.TestAuthService {
  LogoutAuth() : super(f.FakeUser('uid-a'));
  final signedOut = <String?>[];
  @override
  Future<void> signOut() async {
    signedOut.add(mockUser?.uid);
    mockUser = null;
  }
}

class LogoutDiscoveryService extends f.TestLocationService {
  String? heldRead, failingRead;
  bool serverOn = false, holdEnd = false, holdStop = false;
  final entered = Completer<void>(), released = Completer<void>();
  final ends = <DutySession>[];
  final events = <String>[];
  bool held = false;
  Future<void> read(String kind) async {
    events.add(kind);
    if (failingRead == kind) throw StateError('native $kind unavailable');
    if (!held && heldRead == kind) {
      held = true;
      entered.complete();
      await released.future;
    }
  }

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => {
    'uid': uid,
    'name': 'Driver',
    'phone': '+919876543210',
    'truckType': 'flatbed',
    'vehicleNumber': 'MH 12 AB 1234',
    'verificationStatus': 'approved',
    'isOnDuty': serverOn,
    if (serverOn) 'activeDutySessionId': 'session-a',
    if (serverOn) 'dutyGeneration': 2,
    if (serverOn) 'lifecycleSeq': 7,
  };
  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    await read('owner');
    return super.getDurableOwnerRecord();
  }

  @override
  Future<DutySession?> getDurableSession() async {
    await read('session');
    return super.getDurableSession();
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    await read('running');
    return serviceRunning;
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    ends.add(
      DutySession(
        uid: uid,
        sessionId: sessionId,
        generation: generation!,
        lifecycleSeq: lifecycleSeq,
      ),
    );
    if (holdEnd) {
      entered.complete();
      await released.future;
    }
    serverOn = false;
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    expect(expectedUid, isNotNull);
    expect(expectedGeneration, isNotNull);
    expect(expectedLifecycleSeq, isNotNull);
    if (holdStop) {
      entered.complete();
      await released.future;
    }
    await super.stopForegroundService(
      expectedUid: expectedUid,
      expectedSessionId: expectedSessionId,
      expectedGeneration: expectedGeneration,
      expectedLifecycleSeq: expectedLifecycleSeq,
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const old = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 2,
    lifecycleSeq: 7,
  );
  const other = DutySession(
    uid: 'uid-b',
    sessionId: 'session-b',
    generation: 3,
    lifecycleSeq: 8,
  );
  const newer = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 3,
    lifecycleSeq: 8,
  );
  late LogoutAuth auth;
  late LogoutDiscoveryService location;
  late AppLogoutCoordinator coordinator;
  setUp(() {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    auth = LogoutAuth();
    location = LogoutDiscoveryService()
      ..currentSession = old
      ..mockLifecycleSeq = 7
      ..serviceRunning = true;
    coordinator = AppLogoutCoordinator(
      authService: auth,
      locationService: location,
    );
  });
  tearDown(() {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    auth.dispose();
  });
  void replace(DutySession epoch) {
    auth.mockUser = f.FakeUser(epoch.uid);
    location.currentSession = epoch;
    location.mockLifecycleSeq = epoch.lifecycleSeq;
    location.serviceRunning = true;
  }

  void survives(DutySession epoch) {
    expect(location.currentSession, epoch);
    expect(location.serviceRunning, isTrue);
    expect(auth.signedOut, isEmpty);
  }

  for (final read in ['owner', 'running', 'session']) {
    test(
      'R14-C6-${read == 'owner' ? 1 : 3} auth replacement during $read discovery',
      () async {
        location.heldRead = read;
        final stale = coordinator.coordinateLogout();
        await location.entered.future;
        replace(other);
        location.released.complete();
        expect(await stale, LogoutResult.failedDutyTransition);
        expect(location.exactStopRequests, isEmpty);
        survives(other);
      },
    );
  }
  test(
    'R14-C6-2 newer same-UID operation replaces old single-flight ownership',
    () async {
      location.heldRead = 'owner';
      final stale = coordinator.coordinateLogout();
      await location.entered.future;
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
      replace(newer);
      final newerLocation = LogoutDiscoveryService()
        ..heldRead = 'owner'
        ..currentSession = newer
        ..mockLifecycleSeq = 8
        ..serviceRunning = true;
      final next = AppLogoutCoordinator(
        authService: auth,
        locationService: newerLocation,
      ).coordinateLogout();
      await newerLocation.entered.future;
      location.released.complete();
      expect(await stale, LogoutResult.failedDutyTransition);
      expect(location.exactStopRequests, isEmpty);
      survives(newer);
      // Old finally must not remove the newer same-UID flight.
      final joined = coordinator.coordinateLogout();
      newerLocation.released.complete();
      expect(await next, LogoutResult.success);
      expect(await joined, LogoutResult.success);
      expect(auth.signedOut, ['uid-a']);
    },
  );
  test(
    'R14-C6-3 mixed owner/session epochs without UID switch fail closed',
    () async {
      location.heldRead = 'session';
      final stale = coordinator.coordinateLogout();
      await location.entered.future;
      location.currentSession = newer;
      location.mockLifecycleSeq = 8;
      location.released.complete();
      expect(await stale, LogoutResult.failedDutyTransition);
      expect(location.exactStopRequests, isEmpty);
      survives(newer);
    },
  );
  test(
    'R14-C6-4 auth replacement while server END holds aborts before STOP',
    () async {
      location.serverOn = true;
      location.holdEnd = true;
      final stale = coordinator.coordinateLogout();
      await location.entered.future;
      replace(other);
      location.released.complete();
      expect(await stale, LogoutResult.failedDutyTransition);
      expect(location.ends, [old]);
      expect(location.exactStopRequests, isEmpty);
      survives(other);
    },
  );
  test(
    'R14-C6-4 replacement inside exact STOP preserves old captured selector',
    () async {
      location.holdStop = true;
      final stale = coordinator.coordinateLogout();
      await location.entered.future;
      replace(other);
      location.released.complete();
      expect(await stale, LogoutResult.failedDutyTransition);
      expect(location.exactStopRequests, [old]);
      survives(other);
    },
  );
  test(
    'R14-C6-5 normal exact unmounted cleanup verifies absence then signs out',
    () async {
      expect(await coordinator.coordinateLogout(), LogoutResult.success);
      expect(location.exactStopRequests, [old]);
      expect(location.currentSession, isNull);
      expect(location.serviceRunning, isFalse);
      expect(auth.signedOut, ['uid-a']);
      expect(
        location.events.where((e) => e == 'owner').length,
        greaterThanOrEqualTo(2),
      );
      expect(
        location.events.where((e) => e == 'session').length,
        greaterThanOrEqualTo(2),
      );
    },
  );
  for (final read in ['owner', 'session', 'running']) {
    test(
      'R14-C6-6 $read discovery fails without guessed STOP or sign-out',
      () async {
        location.failingRead = read;
        expect(
          await coordinator.coordinateLogout(),
          LogoutResult.failedDutyTransition,
        );
        expect(location.exactStopRequests, isEmpty);
        survives(old);
      },
    );
  }
}
