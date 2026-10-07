import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'duty_controller_test.dart' as f;

// Independent exact server and native ledgers. A mutable lifecycle getter tracks
// replacement state, while START's allocated object remains the stale epoch.
class CapturedEpochLocationService extends f.TestLocationService {
  final entered = Completer<void>(), released = Completer<void>();
  final ends = <DutySession>[],
      cancellations = <DutySession>[],
      activations = <DutySession>[];
  DutySession? serverOwner, requestedStart;
  bool hold = true,
      holdNative = false,
      rejectEnd = false,
      activationThrows = false;
  final events = <String>[];
  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    requestedStart = session;
    final started = await super.startForegroundService(
      session: session,
      notificationTitle: notificationTitle,
      notificationText: notificationText,
      onAuthorityAllocated: onAuthorityAllocated,
    );
    if (holdNative) {
      entered.complete();
      await released.future;
    }
    return started;
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
    final selector = DutySession(
      uid: uid,
      sessionId: sessionId,
      generation: generation!,
      lifecycleSeq: lifecycleSeq,
    );
    activations.add(selector);
    serverOwner = selector;
    if (hold) {
      entered.complete();
      await released.future;
    }
    if (activationThrows) throw StateError('held activation response failed');
    return {
      'status': 'activated',
      'dutyGeneration': generation,
      'lifecycleSeq': lifecycleSeq,
      'workerReady': false,
    };
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    final selector = DutySession(
      uid: uid,
      sessionId: sessionId,
      generation: generation!,
      lifecycleSeq: lifecycleSeq,
    );
    ends.add(selector);
    events.add('end');
    if (serverOwner != selector) {
      if (rejectEnd) throw StateError('exact server END fenced');
      return;
    }
    serverOwner = null;
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    cancellations.add(
      DutySession(
        uid: uid,
        sessionId: sessionId,
        generation: generation!,
        lifecycleSeq: lifecycleSeq,
      ),
    );
    events.add('cancel');
    if (serverOwner == cancellations.last) serverOwner = null;
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    events.add('stop');
    expect(expectedUid, isNotNull);
    expect(expectedGeneration, isNotNull);
    expect(expectedLifecycleSeq, isNotNull);
    await super.stopForegroundService(
      expectedUid: expectedUid,
      expectedSessionId: expectedSessionId,
      expectedGeneration: expectedGeneration,
      expectedLifecycleSeq: expectedLifecycleSeq,
    );
  }

  void replace(DutySession value) {
    serverOwner = currentSession = value;
    mockLifecycleSeq = value.lifecycleSeq;
    nextPreparedGeneration = value.generation;
    serviceRunning = true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const exact = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 2,
    lifecycleSeq: 7,
  );
  const newer = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 2,
    lifecycleSeq: 8,
  );
  const newerGen = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 3,
    lifecycleSeq: 1,
  );
  const other = DutySession(
    uid: 'uid-b',
    sessionId: 'session-b',
    generation: 3,
    lifecycleSeq: 8,
  );
  const off = DriverProfile(
    uid: 'uid-a',
    name: 'Driver A',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 AB 1234',
    verificationStatus: 'approved',
    isOnDuty: false,
  );
  late f.TestAuthService auth;
  late CapturedEpochLocationService location;
  late DutyController controller;
  setUp(() {
    auth = f.TestAuthService(f.FakeUser(exact.uid));
    location = CapturedEpochLocationService()
      ..allocatedLifecycleSeq = 7
      ..mockLifecycleSeq = 7
      ..nextPreparedGeneration = 2
      ..nextPreparedSessionId = exact.sessionId
      ..currentPos = DriverPosition(
        latitude: 18.5,
        longitude: 73.8,
        timestamp: DateTime.utc(2026, 10, 1),
      );
    controller = f.FixtureDutyController(
      locationService: location,
      authService: auth,
    );
    controller.updateProfile(off);
  });
  tearDown(() {
    controller.dispose();
    auth.dispose();
  });
  Future<bool> goOn() =>
      controller.requestGoOnDuty(onShowDisclosure: () async => true);
  void selectorsAndSurvival(DutySession replacement) {
    expect(location.ends, [exact]);
    expect(location.exactStopRequests, [exact]);
    expect(location.ends.single, location.exactStopRequests.single);
    expect(location.cancellations, isEmpty);
    expect(location.serverOwner, replacement);
    expect(location.currentSession, replacement);
    expect(location.serviceRunning, isTrue);
    expect(controller.isLogoutInProgress, isTrue);
  }

  for (final entry in <String, DutySession>{
    'R14-C9-1 exact held activation L7 then logout and replacement L8': newer,
    'R14-C9-2 same UID session generation differs only in lifecycle': newer,
    'R14-C9-3 replacement generation G3/L1': newerGen,
    'R14-C9-4 different UID replacement': other,
  }.entries) {
    test(entry.key, () async {
      final result = goOn();
      await location.entered.future;
      controller.beginLogoutBarrier(exact.uid);
      location.replace(entry.value);
      location.released.complete();
      expect(await result, isFalse);
      selectorsAndSurvival(entry.value);
      expect(location.events, ['end', 'stop']);
    });
  }
  test('R14-C9-5 fenced END L7 never falls back to replacement L8', () async {
    location.rejectEnd = true;
    final result = goOn();
    await location.entered.future;
    controller.beginLogoutBarrier(exact.uid);
    location.replace(newer);
    location.released.complete();
    expect(await result, isFalse);
    selectorsAndSurvival(newer);
    expect(location.ends.length, 1);
  });
  test('R14-C9-6 allocated L7 survives pre-start/current getter L1', () async {
    location.mockLifecycleSeq = 1;
    final result = goOn();
    await location.entered.future;
    expect(location.requestedStart?.lifecycleSeq, isNull);
    expect(location.activations, [exact]);
    controller.beginLogoutBarrier(exact.uid);
    location.replace(newer);
    location.released.complete();
    expect(await result, isFalse);
    selectorsAndSurvival(newer);
  });
  test(
    'R14-C9-7 current go-on retains allocated L7 without compensation',
    () async {
      location.hold = false;
      location.mockLifecycleSeq = 1;
      expect(await goOn(), isTrue);
      expect(controller.activeSession, exact);
      expect(controller.activeLifecycleSeq, 7);
      expect(location.activations, [exact]);
      expect(location.serverOwner, exact);
      expect(location.ends, isEmpty);
      expect(location.exactStopRequests, isEmpty);
      expect(location.cancellations, isEmpty);
    },
  );
  test(
    'R14-C9-8 stale completion preserves replacement state and newer logout lease',
    () async {
      final result = goOn();
      await location.entered.future;
      final oldLease = controller.beginLogoutBarrier(exact.uid);
      auth.emitUser(f.FakeUser(other.uid));
      await Future<void>.delayed(Duration.zero);
      // Auth switching independently performs its own exact old-owner STOP.
      // Assert it, then isolate the stale continuation's destructive actions.
      expect(location.exactStopRequests, [exact]);
      location.exactStopRequests.clear();
      location.events.clear();
      final lease = controller.beginLogoutBarrier(other.uid);
      location.replace(other);
      final state = controller.authoritativeDutyState,
          health = controller.trackingHealth,
          error = controller.lastError,
          active = controller.activeSession,
          pending = controller.pendingCleanupSession;
      location.released.complete();
      expect(await result, isFalse);
      selectorsAndSurvival(other);
      expect(controller.authoritativeDutyState, state);
      expect(controller.trackingHealth, health);
      expect(controller.lastError, same(error));
      expect(controller.activeSession, active);
      expect(controller.pendingCleanupSession, pending);
      controller.endLogoutBarrier(oldLease);
      expect(controller.isLogoutInProgress, isTrue);
      controller.endLogoutBarrier(lease);
      expect(controller.isLogoutInProgress, isFalse);
    },
  );
  for (final path in ['stale-native-start', 'held-activation-error']) {
    test('R14-C9 cancellation uses allocated epoch: $path', () async {
      location.holdNative = path == 'stale-native-start';
      location.activationThrows = path == 'held-activation-error';
      final result = goOn();
      await location.entered.future;
      controller.beginLogoutBarrier(exact.uid);
      location.replace(newer);
      location.released.complete();
      expect(await result, isFalse);
      expect(location.ends, isEmpty);
      expect(location.cancellations, [exact]);
      expect(location.exactStopRequests, [exact]);
      expect(location.cancellations.single, location.exactStopRequests.single);
      expect(location.serverOwner, newer);
      expect(location.currentSession, newer);
      expect(location.serviceRunning, isTrue);
    });
  }
}
