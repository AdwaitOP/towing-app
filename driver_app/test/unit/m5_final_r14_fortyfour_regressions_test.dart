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
// CONSTANTS & REPLACEMENT FORMS (Matches strict M5 audit contract)
// ============================================================================
const priorSession = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 7);
const priorResumed = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 9);

const accountA = 'final-a';
const accountB = 'final-b';
const c9Original = DutySession(uid: accountA, sessionId: 'final-session-a', generation: 17, lifecycleSeq: 71);
const c9Resumed = DutySession(uid: accountA, sessionId: 'final-session-a', generation: 17, lifecycleSeq: 73);

const successors = <DutySession>[
  DutySession(uid: 'B', sessionId: 'T', generation: 3, lifecycleSeq: 8),
  DutySession(uid: 'A', sessionId: 'S', generation: 3, lifecycleSeq: 8),
  DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 8),
];

const c9Replacements = <DutySession>[
  DutySession(uid: accountB, sessionId: 'final-session-b', generation: 23, lifecycleSeq: 79),
  DutySession(uid: accountA, sessionId: 'final-session-a', generation: 18, lifecycleSeq: 79),
  DutySession(uid: accountA, sessionId: 'final-session-a', generation: 17, lifecycleSeq: 79),
];

List<Object?>? idTuple(DutySession? s) =>
    s == null ? null : [s.uid, s.sessionId, s.generation, s.lifecycleSeq];

DurableDutyOwnerRecord makeRecord(DutySession s) => DurableDutyOwnerRecord(
  sessionId: s.sessionId,
  uid: s.uid,
  generation: s.generation,
  lifecycleSeq: s.lifecycleSeq!,
  state: 'ACTIVE',
  startedAt: DateTime.utc(2026, 10, 3),
);

// ============================================================================
// TEST HARNESSES
// ============================================================================
class TestUser implements User {
  @override
  final String uid;
  TestUser(this.uid);
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class TestAuthDouble extends AuthService {
  User? user = TestUser('A');
  final changes = StreamController<User?>.broadcast(sync: true);
  final signouts = <String?>[];

  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => changes.stream;

  void switchTo(String? uid) {
    user = uid == null ? null : TestUser(uid);
    changes.add(user);
  }

  @override
  Future<void> signOut() async {
    signouts.add(user?.uid);
    user = null;
    changes.add(null);
  }
}

class ReceiptBarrier {
  final sampled = Completer<void>();
  final resume = Completer<void>();
  final bool fail;
  final String? failureCode;
  ReceiptBarrier({this.fail = false, this.failureCode});

  Future<void> suspend() async {
    if (!sampled.isCompleted) sampled.complete();
    await resume.future;
    if (fail) throw PlatformException(code: failureCode ?? 'INDEPENDENT_HELD_REPLY_FAILED');
  }
}

class ChannelMockAuthority {
  DurableDutyOwnerRecord? owner;
  int admittedSeq = 0;
  int epoch = 0;
  bool running = false;
  final events = <Map<String, dynamic>>[];

  Future<Object?> dispatch(MethodCall call) async {
    final args = Map<String, dynamic>.from(call.arguments as Map? ?? {});
    if (call.method == 'getDurableOwner') return owner?.encode();
    if (call.method == 'isServiceRunning') return running;
    if (call.method == 'validateCleanupAcquisition') return true;
    if (call.method == 'releaseCleanupAcquisition') return true;
    if (call.method == 'atomicStartService') {
      final raw = args['sessionPayloadJson'] as String? ?? '';
      final requested = raw.isNotEmpty
          ? DurableDutyOwnerRecord.fromJson(raw)
          : DurableDutyOwnerRecord(
              sessionId: args['sessionId'] as String,
              uid: args['uid'] as String,
              generation: args['dutyGeneration'] as int,
              lifecycleSeq: args['lifecycleSeq'] as int,
              startedAt: DateTime.utc(2026, 10, 3),
            );
      final callback = (args['foregroundTaskOptionsMap'] as Map?)?['callbackHandle'];
      if (callback is! int || callback == 0 || requested.lifecycleSeq <= admittedSeq) {
        return {'success': false, 'active': false, 'reason': 'invalid_or_stale_start'};
      }
      admittedSeq = requested.lifecycleSeq;
      owner = requested;
      running = true;
      events.add({
        'method': 'START',
        'selector': [requested.uid, requested.sessionId, requested.generation, requested.lifecycleSeq],
      });
      return {
        'success': true,
        'active': true,
        'state': 'ACTIVE',
        'generation': requested.generation,
        'lifecycleSeq': requested.lifecycleSeq,
        'executionEpoch': ++epoch,
      };
    }
    if (call.method == 'atomicStopService') {
      final exact = owner == null ||
          (owner!.uid == args['expectedUid'] &&
              owner!.sessionId == args['expectedSessionId'] &&
              owner!.generation == args['expectedGeneration'] &&
              owner!.lifecycleSeq == args['expectedLifecycleSeq']);
      events.add({
        'method': 'STOP',
        'selector': [
          args['expectedUid'],
          args['expectedSessionId'],
          args['expectedGeneration'],
          args['expectedLifecycleSeq'],
        ],
        'exactCurrent': exact,
      });
      if (exact) {
        owner = null;
        running = false;
      }
      return {'success': exact, 'stopped': exact, 'reason': exact ? 'stopped' : 'epoch_mismatch'};
    }
    throw MissingPluginException('Unmodelled method: ${call.method}');
  }
}

Future<void> admitReplacement(DutySession s) async {
  final result = await NativeOwnershipCoordinator.atomicStartService(
    record: makeRecord(s),
    foregroundTaskOptionsMap: {'callbackHandle': 91827},
  );
  expect(result['success'], true);
  expect(result['active'], true);
}

Map<String, dynamic> makeDriverProfile(String uid, {DutySession? epoch, bool on = true, bool approved = true}) => {
  'uid': uid,
  'name': 'Independent Auditor',
  'phone': '+919999999999',
  'truckType': 'flatbed',
  'vehicleNumber': 'MH01 AA0001',
  'verificationStatus': approved ? 'approved' : 'rejected',
  'isOnDuty': on,
  'activeDutySessionId': on ? (epoch?.sessionId ?? 'S') : null,
  'dutyGeneration': epoch?.generation ?? 2,
  'lifecycleSeq': on ? (epoch?.lifecycleSeq ?? 7) : null,
  'workerReady': on && (epoch != null),
  'activeJobId': null,
  'activeOfferId': null,
};

Map<String, dynamic> snapController(DutyController c) => {
  'duty': c.authoritativeDutyState.name,
  'health': c.trackingHealth.name,
  'desired': c.desiredDutyState.name,
  'ready': c.isReady,
  'cleanup': c.isCleanupRequired,
  'pending': idTuple(c.pendingCleanupSession),
  'active': idTuple(c.activeSession),
  'loading': c.isLoading,
  'reconciling': c.isReconciling,
  'logout': c.isLogoutInProgress,
  'error': c.lastErrorCode,
  'cleanupError': c.cleanupErrorCode,
  'diagnostic': c.staleStartCleanupError,
  'category': c.errorCategory?.name,
};

class CommonLocationService extends DriverLocationService {
  final visits = <String, int>{};
  final barriers = <String, ReceiptBarrier>{};
  final log = <Map<String, dynamic>>[];
  final ends = <DutySession>[];
  final stops = <DutySession>[];
  final cancels = <Map<String, dynamic>>[];
  final activeServers = <String, DutySession?>{};
  Map<String, dynamic> server = makeDriverProfile('A');
  bool denyBackground = false;
  bool rejectEnd = false;
  bool rejectStop = false;
  bool rejectStart = false;
  bool rejectCancel = false;
  String stopFailureCode = 'FINAL_AUDIT_STOP_FAILED';
  DutyActivationPreparation preparation = const DutyActivationPreparation(
    sessionId: 'pending-final-audit',
    generation: 2,
    attemptSeq: 3,
  );
  int allocatedLifecycleSeq = 7;
  NativeCleanupAcquisition? acquisition;

  ReceiptBarrier next(String action, [String? failure]) {
    final key = '$action:${(visits[action] ?? 0) + 1}';
    final gate = ReceiptBarrier(fail: failure != null, failureCode: failure);
    barriers[key] = gate;
    return gate;
  }

  Future<T> track<T>(String operation, Future<T> Function() sample) async {
    final visit = visits.update(operation, (v) => v + 1, ifAbsent: () => 1);
    final result = await sample();
    log.add({'operation': operation, 'visit': visit});
    await barriers['$operation:$visit']?.suspend();
    return result;
  }

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() =>
      track('owner', NativeOwnershipCoordinator.getDurableOwner);

  @override
  Future<DutySession?> getDurableSession() => track('session', () async {
    final stored = await NativeOwnershipCoordinator.getDurableOwner();
    return stored == null
        ? null
        : DutySession(
            uid: stored.uid,
            sessionId: stored.sessionId,
            generation: stored.generation,
            lifecycleSeq: stored.lifecycleSeq,
          );
  });

  @override
  Future<bool> isForegroundServiceRunning() =>
      track('running', NativeOwnershipCoordinator.isServiceRunning);

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) =>
      track('fresh', () async => Map<String, dynamic>.from(server));

  @override
  Future<bool> isLocationServiceEnabled() => track('services', () async => true);

  @override
  Future<LocationPermissionStatus> checkPermission() =>
      track('foreground', () async => LocationPermissionStatus.granted);

  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() => track(
        'background',
        () async => denyBackground
            ? LocationPermissionStatus.denied
            : LocationPermissionStatus.granted,
      );

  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async =>
      LocationPermissionStatus.granted;

  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async =>
      LocationPermissionStatus.granted;

  @override
  Future<DriverPosition?> getCurrentPosition() async =>
      DriverPosition(latitude: 19, longitude: 73, timestamp: DateTime.utc(2026, 10, 3));

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    await track('prepare', () async => preparation);
    return preparation;
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
    final exact = DutySession(uid: uid, sessionId: sessionId, generation: generation ?? 0, lifecycleSeq: lifecycleSeq);
    activeServers[uid] = exact;
    await track('activate', () async => exact);
    return {'status': 'activated', 'workerReady': false, 'dutyGeneration': generation, 'lifecycleSeq': lifecycleSeq};
  }

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession)? onAuthorityAllocated,
  }) async {
    final exact = session.copyWith(lifecycleSeq: allocatedLifecycleSeq);
    await admitReplacement(exact);
    onAuthorityAllocated?.call(exact);
    await track('start', () async => exact);
    if (rejectStart) throw PlatformException(code: 'FINAL_AUDIT_START_FAILED');
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
      uid: expectedUid ?? '',
      sessionId: expectedSessionId,
      generation: expectedGeneration ?? 0,
      lifecycleSeq: expectedLifecycleSeq,
    );
    stops.add(s);
    log.add({
      'operation': 'STOP',
      'selector': [expectedUid, expectedSessionId, expectedGeneration, expectedLifecycleSeq],
    });
    await track('stop', () async => s);
    if (rejectStop) throw PlatformException(code: stopFailureCode);
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
    final s = DutySession(uid: uid, sessionId: sessionId, generation: generation ?? 0, lifecycleSeq: lifecycleSeq);
    ends.add(s);
    log.add({'operation': 'END', 'selector': [uid, sessionId, generation, lifecycleSeq]});
    await track('end', () async {
      if (rejectEnd) throw PlatformException(code: 'FINAL_AUDIT_END_FAILED');
      server = {...server, 'isOnDuty': false};
      activeServers[uid] = null;
      return true;
    });
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    log.add({'operation': 'OFF_TRANSACTION', 'uid': uid});
    await track('off', () async => true);
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    cancels.add({
      'uid': uid,
      'sessionId': sessionId,
      'generation': generation,
      'lifecycleSeq': lifecycleSeq,
      'attemptSeq': attemptSeq,
    });
    log.add({
      'operation': 'CANCEL',
      'selector': [uid, sessionId, generation, lifecycleSeq, attemptSeq],
    });
    if (rejectCancel) throw PlatformException(code: 'FINAL_AUDIT_CANCEL_FAILED');
    await track('cancel', () async => true);
  }

  @override
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(String operationId, String uid) async {
    final lease = await super.beginCleanupAcquisition(operationId, uid);
    acquisition = lease;
    return track('acquire', () async => lease);
  }

  @override
  Future<bool> validateCleanupAcquisition(NativeCleanupAcquisition lease) async =>
      track('validate', () => super.validateCleanupAcquisition(lease));

  @override
  Future<void> releaseCleanupAcquisition(NativeCleanupAcquisition lease) async {
    log.add({'operation': 'RELEASE', 'token': lease.token});
    await super.releaseCleanupAcquisition(lease);
  }
}

Future<({Future<void> work, ReceiptBarrier start})> interruptedResume(
  DutyController controller,
  CommonLocationService loc,
) async {
  controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountA, epoch: c9Original, on: false), accountA));
  loc.allocatedLifecycleSeq = c9Original.lifecycleSeq!;
  loc.preparation = DutyActivationPreparation(
    sessionId: c9Original.sessionId,
    generation: c9Original.generation,
    attemptSeq: 1,
  );
  expect(await controller.requestGoOnDuty(onShowDisclosure: () async => true), true);

  await NativeOwnershipCoordinator.atomicStopService(
    expectedUid: c9Original.uid,
    expectedSessionId: c9Original.sessionId,
    expectedGeneration: c9Original.generation,
    expectedLifecycleSeq: c9Original.lifecycleSeq!,
  );

  loc.allocatedLifecycleSeq = c9Resumed.lifecycleSeq!;
  loc.server = makeDriverProfile(accountA, epoch: c9Original, on: true);
  controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountA, epoch: c9Original, on: true), accountA));

  final startGate = loc.next('start');
  final work = controller.reconcileDutyState();
  await startGate.sampled.future.timeout(const Duration(seconds: 5));
  return (work: work, start: startGate);
}

// ============================================================================
// MAIN REGRESSION SUITE: 44 AUDIT FAILURES + 18 CONTROLS = 62 CASES
// ============================================================================
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
    NativeOwnershipCoordinator.resetTestSimulation();
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    DriverLocationService.resetPendingCleanupTokensForTesting();
  });

  // ==========================================================================
  // ROOT C / F06-F07: PRODUCTION CHANNEL FINAL NATIVE ABSENCE FRESHNESS (24)
  // ==========================================================================
  group('ROOT C: Production-Channel Final Native Absence Freshness (24 Cases)', () {
    // Callers 1, 2, 3, 4, 8 under production channel (15 Cases)
    for (final caller in [1, 2, 3, 4, 8]) {
      for (final next in successors) {
        test('MATRIX C$caller PRODUCTION_CHANNEL final native receipt ${idTuple(next)}', () async {
          NativeOwnershipCoordinator.resetTestSimulation();
          NativeOwnershipCoordinator.useTestSimulation = false;

          final channelAuthority = ChannelMockAuthority();
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, channelAuthority.dispatch);

          final auth = TestAuthDouble();
          final loc = CommonLocationService();
          final controller = DutyController(authService: auth, locationService: loc);
          addTearDown(controller.dispose);
          addTearDown(auth.changes.close);

          // Seed prior native authority
          await admitReplacement(priorSession);
          loc.server = makeDriverProfile('A', on: caller != 4, approved: caller != 3);
          loc.denyBackground = caller == 8;
          controller.updateProfile(DriverProfile.fromMap(makeDriverProfile('A', on: caller != 4), 'A'));

          if (caller == 2) {
            loc.rejectStop = true;
            expect(await controller.requestGoOffDuty(), false);
            expect(idTuple(controller.pendingCleanupSession), idTuple(priorSession));
            loc.rejectStop = false;
            loc.visits.clear();
            loc.log.clear();
          }

          final receiptLabel = caller == 2 ? 'owner:2' : 'owner:3';
          final delayed = ReceiptBarrier();
          loc.barriers[receiptLabel] = delayed;

          Future<Object?> op;
          if (caller == 1) {
            op = controller.requestGoOffDuty();
          } else if (caller == 2) {
            op = controller.retryCleanup();
          } else {
            op = controller.reconcileDutyState().then((_) => null);
          }

          await delayed.sampled.future.timeout(const Duration(seconds: 5));
          expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
          expect(await NativeOwnershipCoordinator.isServiceRunning(), false);

          // Concurrent replacement admitted during held receipt
          await admitReplacement(next);

          delayed.resume.complete();
          final res = await op;

          // Invariant: replacement survives and remains active
          final curOwner = await NativeOwnershipCoordinator.getDurableOwner();
          expect(idTuple(DutySession(uid: curOwner!.uid, sessionId: curOwner.sessionId, generation: curOwner.generation, lifecycleSeq: curOwner.lifecycleSeq)), idTuple(next));
          expect(await NativeOwnershipCoordinator.isServiceRunning(), true);

          // Old cleanup must never borrow replacement selector
          for (final call in loc.stops) {
            expect(call, priorSession);
          }

          // Crucial: Final absence must be proven fresh at publication. Because replacement started, clean OFF must be rejected!
          expect(controller.isCleanupRequired, true);
          expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
          if (caller <= 2) expect(res, false);
        });
      }
    }

    // Callers 5 and 6 (Mounted & Unmounted Logout) under production channel (6 Cases)
    for (final mounted in [true, false]) {
      final boundary = mounted ? 'validate:3' : 'validate:4';
      for (final next in successors) {
        test('MATRIX FINAL C${mounted ? 5 : 6} $boundary native ${next.uid} G${next.generation} L${next.lifecycleSeq}', () async {
          NativeOwnershipCoordinator.resetTestSimulation();
          NativeOwnershipCoordinator.useTestSimulation = true;

          await admitReplacement(priorSession);

          final auth = TestAuthDouble();
          final loc = CommonLocationService();
          final controller = mounted ? DutyController(authService: auth, locationService: loc) : null;
          controller?.updateProfile(DriverProfile.fromMap(makeDriverProfile('A'), 'A'));
          final coordinator = AppLogoutCoordinator(
            authService: auth,
            locationService: loc,
            dutyController: controller,
          );
          addTearDown(() => controller?.dispose());
          addTearDown(auth.changes.close);

          final gate = ReceiptBarrier();
          loc.barriers[boundary] = gate;

          final pending = coordinator.coordinateLogout();
          await gate.sampled.future.timeout(const Duration(seconds: 5));

          // Legitimate replacement starts during held final validation
          await admitReplacement(next);

          gate.resume.complete();
          final result = await pending;

          // Replacement survives
          final curOwner = await NativeOwnershipCoordinator.getDurableOwner();
          expect(idTuple(DutySession(uid: curOwner!.uid, sessionId: curOwner.sessionId, generation: curOwner.generation, lifecycleSeq: curOwner.lifecycleSeq)), idTuple(next));
          expect(await NativeOwnershipCoordinator.isServiceRunning(), true);

          // Sign-out must be blocked!
          expect(auth.signouts, isEmpty, reason: 'Old sampled validation cannot authorize signOut while replacement is ACTIVE');
          expect(result, LogoutResult.failedDutyTransition);
          for (final call in loc.stops) {
            expect(call, priorSession);
          }
          for (final call in loc.ends) {
            expect(call, priorSession);
          }
        });
      }
    }

    // Caller 9 MethodChannel final proof (3 Cases)
    for (var index = 0; index < c9Replacements.length; index++) {
      final successor = c9Replacements[index];
      test('MATRIX C9 MethodChannel final proof replacement $index', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = false;

        final channelAuthority = ChannelMockAuthority();
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, channelAuthority.dispatch);

        final auth = TestAuthDouble();
        auth.switchTo(accountA);
        final loc = CommonLocationService();
        final controller = DutyController(authService: auth, locationService: loc);
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountA), accountA));
        loc.activeServers[accountA] = c9Original;

        final activationGate = ReceiptBarrier();
        loc.barriers['activate:1'] = activationGate;

        loc.preparation = DutyActivationPreparation(
          sessionId: c9Original.sessionId,
          generation: c9Original.generation,
          attemptSeq: 11,
        );
        loc.allocatedLifecycleSeq = c9Original.lifecycleSeq!;

        final oldGoOn = controller.requestGoOnDuty(onShowDisclosure: () async => true);
        await activationGate.sampled.future.timeout(const Duration(seconds: 5));

        final barrier = controller.beginLogoutBarrier(accountA);

        final firstProof = ReceiptBarrier();
        loc.barriers['owner:1'] = firstProof;
        activationGate.resume.complete();
        await firstProof.sampled.future.timeout(const Duration(seconds: 5));

        final finalProof = ReceiptBarrier();
        loc.barriers['owner:2'] = finalProof;
        firstProof.resume.complete();
        await finalProof.sampled.future.timeout(const Duration(seconds: 5));

        expect(channelAuthority.owner, isNull);
        // Start successor before old null receipt delivers
        await admitReplacement(successor);

        finalProof.resume.complete();
        expect(await oldGoOn, false);

        expect(channelAuthority.owner?.uid, successor.uid);
        expect(channelAuthority.running, true);
        expect(controller.isCleanupRequired, true);
        expect(controller.trackingHealth, isNot(TrackingHealth.off));

        controller.endLogoutBarrier(barrier);
      });
    }
  });

  // ==========================================================================
  // ROOT B: LOGOUT POST-AWAIT PUBLICATION OWNERSHIP (15 DISTINCT CASES)
  // ==========================================================================
  group('ROOT B: Logout Post-Await Publication Ownership (15 Distinct Cases)', () {
    // 9 Success Continuation Cases: Auth switches to B while old read held; B state must be preserved
    final successBoundaries = [
      'running:4', 'owner:4', 'validate:1',
      'running:5', 'owner:5', 'validate:2',
      'running:6', 'owner:6', 'validate:3',
    ];

    for (final boundary in successBoundaries) {
      test('MATRIX continuation C5 $boundary Auth B success', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        await admitReplacement(priorSession);

        final auth = TestAuthDouble();
        final loc = CommonLocationService();
        final controller = DutyController(authService: auth, locationService: loc);
        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile('A'), 'A'));
        final coordinator = AppLogoutCoordinator(
          authService: auth,
          locationService: loc,
          dutyController: controller,
        );
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        final gate = ReceiptBarrier();
        loc.barriers[boundary] = gate;

        final pending = coordinator.coordinateLogout();
        await gate.sampled.future.timeout(const Duration(seconds: 5));

        // Switch to UID B while held
        auth.switchTo('B');
        await Future<void>.delayed(Duration.zero);
        final before = snapController(controller);

        gate.resume.complete();
        final result = await pending;

        expect(auth.signouts, isEmpty);
        expect(auth.currentUser?.uid, 'B');
        expect(result, LogoutResult.failedDutyTransition);

        // Crucial: B's ordinary state must NOT be mutated to offDuty/off by A's old completion!
        final after = snapController(controller)..remove('logout');
        final stableBefore = Map<String, dynamic>.from(before)..remove('logout');
        expect(after, stableBefore, reason: 'Old final continuation cannot clear successor B ordinary state');
      });
    }

    // 6 Failure Continuation Cases: held read throws error; B health must NOT become reconciliationFailed
    final failureBoundaries = [
      'running:4', 'owner:4',
      'running:5', 'owner:5',
      'running:6', 'owner:6',
    ];

    for (final boundary in failureBoundaries) {
      test('MATRIX continuation C5 $boundary Auth B failure', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        await admitReplacement(priorSession);

        final auth = TestAuthDouble();
        final loc = CommonLocationService();
        final controller = DutyController(authService: auth, locationService: loc);
        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile('A'), 'A'));
        final coordinator = AppLogoutCoordinator(
          authService: auth,
          locationService: loc,
          dutyController: controller,
        );
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        final gate = ReceiptBarrier(fail: true);
        loc.barriers[boundary] = gate;

        final pending = coordinator.coordinateLogout();
        await gate.sampled.future.timeout(const Duration(seconds: 5));

        // Switch to UID B while held
        auth.switchTo('B');
        await Future<void>.delayed(Duration.zero);
        final before = snapController(controller);

        gate.resume.complete();
        final result = await pending;

        expect(auth.signouts, isEmpty);
        expect(auth.currentUser?.uid, 'B');
        expect(result, LogoutResult.failedDutyTransition);

        // Crucial: B's health must NOT be set to reconciliationFailed by A's old catch handler!
        final after = snapController(controller)..remove('logout');
        final stableBefore = Map<String, dynamic>.from(before)..remove('logout');
        expect(after, stableBefore, reason: 'Old failed read catch cannot mutate successor B health to reconciliationFailed');
      });
    }
  });

  // ==========================================================================
  // ROOT D / F09: FAILED SERVER END DEBT RETAINED THROUGH HANDOFF & RETRY (3)
  // ==========================================================================
  group('ROOT D / F09: Failed Server END Debt Retention (3 Cases)', () {
    for (var index = 0; index < c9Replacements.length; index++) {
      final successor = c9Replacements[index];
      test('MATRIX C9 failed END retains debt replacement $index', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        final auth = TestAuthDouble();
        auth.switchTo(accountA);
        final loc = CommonLocationService();
        final controller = DutyController(authService: auth, locationService: loc);
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountA), accountA));
        loc.activeServers[accountA] = c9Original;
        loc.preparation = DutyActivationPreparation(
          sessionId: c9Original.sessionId,
          generation: c9Original.generation,
          attemptSeq: 11,
        );
        loc.allocatedLifecycleSeq = c9Original.lifecycleSeq!;

        // 1st END fails
        loc.rejectEnd = true;

        final activationGate = ReceiptBarrier();
        loc.barriers['activate:1'] = activationGate;

        final oldGoOn = controller.requestGoOnDuty(onShowDisclosure: () async => true);
        await activationGate.sampled.future.timeout(const Duration(seconds: 5));

        final barrier = controller.beginLogoutBarrier(accountA);

        final firstProof = ReceiptBarrier();
        loc.barriers['owner:1'] = firstProof;
        activationGate.resume.complete();
        await firstProof.sampled.future.timeout(const Duration(seconds: 5));

        final finalProof = ReceiptBarrier();
        loc.barriers['owner:2'] = finalProof;
        firstProof.resume.complete();
        await finalProof.sampled.future.timeout(const Duration(seconds: 5));

        // Start replacement natively
        await admitReplacement(successor);

        finalProof.resume.complete();
        expect(await oldGoOn, false);

        expect(loc.activeServers[accountA], c9Original);
        expect(controller.isCleanupRequired, true);

        // Replacement owner cleans its own worker
        await NativeOwnershipCoordinator.atomicStopService(
          expectedUid: successor.uid,
          expectedSessionId: successor.sessionId,
          expectedGeneration: successor.generation,
          expectedLifecycleSeq: successor.lifecycleSeq!,
        );

        controller.endLogoutBarrier(barrier);

        // Retry 1: END fails again
        loc.rejectEnd = true;
        await controller.retryCleanup();
        expect(loc.activeServers[accountA], c9Original);
        expect(controller.isCleanupRequired, true);

        // Retry 2: END fails again
        loc.rejectEnd = true;
        await controller.retryCleanup();
        expect(loc.activeServers[accountA], c9Original);
        expect(controller.isCleanupRequired, true);

        // Retry 3: END succeeds
        loc.rejectEnd = false;
        await controller.retryCleanup();
        expect(loc.activeServers[accountA], isNull);
        expect(controller.isCleanupRequired, false);

        // Total 4 calls to END with c9Original
        expect(loc.ends, [c9Original, c9Original, c9Original, c9Original]);
        for (final stop in loc.stops) {
          expect(stop, c9Original);
        }
      });
    }
  });

  // ==========================================================================
  // ROOT E / F10: TYPE-B STALE DIAGNOSTIC PUBLICATION ISOLATION (2 CASES)
  // ==========================================================================
  group('ROOT E / F10: Stale TYPE-B Diagnostic Publication Isolation (2 Cases)', () {
    for (final form in ['residueB', 'releasedB']) {
      test('MATRIX E stabilized B ordinary ownership without error dismissal $form', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        final auth = TestAuthDouble();
        auth.switchTo(accountA);
        final loc = CommonLocationService();
        final controller = DutyController(authService: auth, locationService: loc);
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        final pending = await interruptedResume(controller, loc);

        auth.switchTo(accountB);
        await Future<void>.delayed(Duration.zero);
        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountB, on: false), accountB));

        if (form == 'releasedB') {
          final lease = controller.beginLogoutBarrier(accountB);
          controller.endLogoutBarrier(lease);
        }

        final stopGate = loc.next('stop', 'FINAL_TYPE_B_RESIDUE');
        loc.stopFailureCode = 'FINAL_TYPE_B_RESIDUE';

        pending.start.resume.complete();
        await stopGate.sampled.future.timeout(const Duration(seconds: 5));

        final before = snapController(controller);
        var notes = 0;
        controller.addListener(() => notes++);

        stopGate.resume.complete();
        await pending.work;

        final after = snapController(controller);

        // Crucial: TYPE-B stale error cannot enter the successor B public diagnostic!
        expect(after['diagnostic'], before['diagnostic'], reason: 'TYPE-B stale error cannot enter successor public diagnostic');
        expect(after['diagnostic'], isNull);
        expect(notes, 0);
      });
    }
  });

  // ==========================================================================
  // POSITIVE CONTROLS (18 CASES MUST REMAIN GREEN)
  // ==========================================================================
  group('POSITIVE CONTROLS (18 Cases)', () {
    // 5 Controls: Callers 1, 2, 3, 4, 8 legitimate END STOP current absence
    for (final caller in [1, 2, 3, 4, 8]) {
      test('CONTROL C$caller legitimate END STOP current absence', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        await admitReplacement(priorSession);

        final auth = TestAuthDouble();
        final loc = CommonLocationService();
        loc.server = makeDriverProfile('A', on: caller != 4, approved: caller != 3);
        loc.denyBackground = caller == 8;
        final controller = DutyController(authService: auth, locationService: loc);
        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile('A', on: caller != 4), 'A'));
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        if (caller == 2) {
          loc.rejectStop = true;
          expect(await controller.requestGoOffDuty(), false);
          loc.rejectStop = false;
        }

        Future<Object?> op;
        if (caller == 1) {
          op = controller.requestGoOffDuty();
        } else if (caller == 2) {
          op = controller.retryCleanup();
        } else {
          op = controller.reconcileDutyState().then((_) => null);
        }

        final res = await op;
        expect(controller.trackingHealth, TrackingHealth.off);
        expect(controller.isCleanupRequired, false);
        expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
        if (caller <= 2) expect(res, true);
      });
    }

    // 2 Controls: Callers 5, 6 genuine current logout
    for (final mounted in [true, false]) {
      test('CONTROL C${mounted ? 5 : 6} genuine current logout', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        await admitReplacement(priorSession);

        final auth = TestAuthDouble();
        final loc = CommonLocationService();
        final controller = mounted ? DutyController(authService: auth, locationService: loc) : null;
        controller?.updateProfile(DriverProfile.fromMap(makeDriverProfile('A'), 'A'));
        final coordinator = AppLogoutCoordinator(
          authService: auth,
          locationService: loc,
          dutyController: controller,
        );
        addTearDown(() => controller?.dispose());
        addTearDown(auth.changes.close);

        final result = await coordinator.coordinateLogout();
        expect(result, LogoutResult.success);
        expect(auth.signouts, ['A']);
        expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
        expect(await NativeOwnershipCoordinator.isServiceRunning(), false);
      });
    }

    // 2 Controls: Caller 9 genuine absence transport simulation=true and simulation=false
    for (final sim in [true, false]) {
      test('CONTROL C9 genuine absence transport simulation=$sim', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = sim;

        ChannelMockAuthority? channelAuth;
        if (!sim) {
          channelAuth = ChannelMockAuthority();
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, channelAuth.dispatch);
        }

        final auth = TestAuthDouble();
        auth.switchTo(accountA);
        final loc = CommonLocationService();
        final controller = DutyController(authService: auth, locationService: loc);
        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountA), accountA));
        loc.activeServers[accountA] = c9Original;
        loc.preparation = DutyActivationPreparation(
          sessionId: c9Original.sessionId,
          generation: c9Original.generation,
          attemptSeq: 11,
        );
        loc.allocatedLifecycleSeq = c9Original.lifecycleSeq!;

        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        final activationGate = ReceiptBarrier();
        loc.barriers['activate:1'] = activationGate;

        final old = controller.requestGoOnDuty(onShowDisclosure: () async => true);
        await activationGate.sampled.future.timeout(const Duration(seconds: 5));

        controller.beginLogoutBarrier(accountA);
        activationGate.resume.complete();

        expect(await old, false);
        expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
        expect(controller.trackingHealth, TrackingHealth.off);
        expect(controller.isCleanupRequired, false);
        expect(loc.ends, [c9Original]);
        expect(loc.stops, [c9Original]);
      });
    }

    // 3 Controls: Callers 1, 3, 8 failed END never dispatches STOP
    for (final caller in [1, 3, 8]) {
      test('CONTROL C$caller failed END never dispatches STOP', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        await admitReplacement(priorSession);

        final auth = TestAuthDouble();
        final loc = CommonLocationService();
        loc.rejectEnd = true;
        loc.server = makeDriverProfile('A', on: true, approved: caller != 3);
        loc.denyBackground = caller == 8;
        final controller = DutyController(authService: auth, locationService: loc);
        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile('A'), 'A'));
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        if (caller == 1) {
          await controller.requestGoOffDuty();
        } else {
          try {
            await controller.reconcileDutyState();
          } catch (_) {}
        }

        expect(loc.stops, isEmpty);
        expect(controller.authoritativeDutyState, AuthoritativeDutyState.onDuty);
      });
    }

    // 2 Controls: Callers 1, 2 failed STOP retains exact native debt
    for (final caller in [1, 2]) {
      test('CONTROL C$caller failed STOP retains exact native debt', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        await admitReplacement(priorSession);

        final auth = TestAuthDouble();
        final loc = CommonLocationService();
        loc.rejectStop = true;
        final controller = DutyController(authService: auth, locationService: loc);
        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile('A'), 'A'));
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        if (caller == 1) {
          expect(await controller.requestGoOffDuty(), false);
        } else {
          expect(await controller.requestGoOffDuty(), false);
          expect(await controller.retryCleanup(), false);
        }

        expect(controller.isCleanupRequired, true);
        expect(controller.pendingCleanupSession, priorSession);
        expect(await NativeOwnershipCoordinator.isServiceRunning(), true);
      });
    }

    // 1 Control: Caller 2 old failure cannot replace completed same-tuple O2 retry
    test('CONTROL C2 old failure cannot replace completed same-tuple O2 retry', () async {
      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;

      await admitReplacement(priorSession);

      final auth = TestAuthDouble();
      final loc = CommonLocationService();
      final controller = DutyController(authService: auth, locationService: loc);
      controller.updateProfile(DriverProfile.fromMap(makeDriverProfile('A'), 'A'));
      addTearDown(controller.dispose);
      addTearDown(auth.changes.close);

      // Create debt
      loc.rejectStop = true;
      expect(await controller.requestGoOffDuty(), false);
      loc.rejectStop = false;
      loc.visits.clear();

      final oldProof = ReceiptBarrier(fail: true);
      loc.barriers['owner:1'] = oldProof;

      final oldOp = controller.retryCleanup();
      await oldProof.sampled.future.timeout(const Duration(seconds: 5));

      // Newer retry completes successfully
      expect(await controller.retryCleanup(), true);
      final completed = snapController(controller);
      var notes = 0;
      controller.addListener(() => notes++);

      oldProof.resume.complete();
      expect(await oldOp, false);

      expect(snapController(controller), completed);
      expect(notes, 0);
    });

    // 2 Controls: Root D repeated END receiverB=true and receiverB=false
    for (final viaB in [true, false]) {
      test('CONTROL Root D repeated END receiverB=$viaB', () async {
        NativeOwnershipCoordinator.resetTestSimulation();
        NativeOwnershipCoordinator.useTestSimulation = true;

        final auth = TestAuthDouble();
        auth.switchTo(accountA);
        final loc = CommonLocationService();
        final controller = DutyController(authService: auth, locationService: loc);
        addTearDown(controller.dispose);
        addTearDown(auth.changes.close);

        controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountA), accountA));
        loc.activeServers[accountA] = c9Original;
        loc.preparation = DutyActivationPreparation(
          sessionId: c9Original.sessionId,
          generation: c9Original.generation,
          attemptSeq: 11,
        );
        loc.allocatedLifecycleSeq = c9Original.lifecycleSeq!;

        loc.rejectEnd = true;
        final held = ReceiptBarrier();
        loc.barriers['activate:1'] = held;

        final initial = controller.requestGoOnDuty(onShowDisclosure: () async => true);
        await held.sampled.future.timeout(const Duration(seconds: 5));

        LogoutBarrierLease? lease;
        if (viaB) {
          auth.switchTo(accountB);
          await Future<void>.delayed(Duration.zero);
          controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountB, on: false), accountB));
        } else {
          lease = controller.beginLogoutBarrier(accountA);
        }

        held.resume.complete();
        expect(await initial, false);
        expect(controller.deferredCompensation, hasLength(1));

        if (viaB) {
          final countBefore = loc.ends.length;
          expect(await controller.retryCleanup(), true);
          expect(loc.ends.length, countBefore);
          auth.switchTo(accountA);
          await Future<void>.delayed(Duration.zero);
          controller.clearOwnedAuthority();
          controller.updateProfile(DriverProfile.fromMap(makeDriverProfile(accountA, on: false), accountA));
        } else {
          controller.endLogoutBarrier(lease!);
        }

        // Retry 1: still fails
        expect(await controller.retryCleanup(), false);
        expect(controller.deferredCompensation.single.serverDebt, true);

        // Retry 2: END succeeds
        loc.rejectEnd = false;
        expect(await controller.retryCleanup(), true);
        expect(controller.deferredCompensation, isEmpty);
        expect(controller.isCleanupRequired, false);
      });
    }

    // 1 Control: Root E null Auth permits scoped forensic diagnostic
    test('CONTROL Type-B null Auth permits scoped forensic diagnostic', () async {
      NativeOwnershipCoordinator.resetTestSimulation();
      NativeOwnershipCoordinator.useTestSimulation = true;

      final auth = TestAuthDouble();
      auth.switchTo(accountA);
      final loc = CommonLocationService();
      final controller = DutyController(authService: auth, locationService: loc);
      addTearDown(controller.dispose);
      addTearDown(auth.changes.close);

      final pending = await interruptedResume(controller, loc);

      // Null Auth
      auth.switchTo(null);
      await Future<void>.delayed(Duration.zero);

      final stopGate = loc.next('stop', 'FINAL_FORENSIC_RESIDUE');
      loc.stopFailureCode = 'FINAL_FORENSIC_RESIDUE';

      pending.start.resume.complete();
      await stopGate.sampled.future.timeout(const Duration(seconds: 5));
      stopGate.resume.complete();
      await pending.work;

      // Forensic diagnostic recorded when Auth is null!
      expect(controller.staleStartCleanupError, contains('FINAL_FORENSIC_RESIDUE'));
    });
  });
}
