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
// CONSTANTS & HELPERS
// ============================================================================
const oldTuple = ['A', 'S', 2, 7];
const replacements = <List<Object>>[
  ['B', 'T', 3, 8],
  ['A', 'S', 3, 8],
  ['A', 'S', 2, 8],
];

List<Object?> tuple(DutySession? s) =>
    s == null ? [] : [s.uid, s.sessionId, s.generation, s.lifecycleSeq];

DutySession session(List<Object> t) => DutySession(
      uid: t[0] as String,
      sessionId: t[1] as String,
      generation: t[2] as int,
      lifecycleSeq: t[3] as int,
    );

DurableDutyOwnerRecord record(List<Object> t) => DurableDutyOwnerRecord(
      uid: t[0] as String,
      sessionId: t[1] as String,
      generation: t[2] as int,
      lifecycleSeq: t[3] as int,
      state: 'ACTIVE',
      startedAt: DateTime.utc(2026, 10, 3),
    );

Map<String, dynamic> profileData(List<Object> t,
        {bool on = true, bool approved = true}) =>
    {
      'uid': t[0],
      'name': 'Independent Driver',
      'phone': '+919876543210',
      'truckType': 'flatbed',
      'vehicleNumber': 'KA01AB1234',
      'verificationStatus': approved ? 'approved' : 'rejected',
      'isOnDuty': on,
      'activeDutySessionId': on ? t[1] : null,
      'dutyGeneration': t[2],
      'lifecycleSeq': on ? t[3] : null,
      'workerReady': false,
    };

Map<String, dynamic> serverData(String uid, {bool on = true}) => {
      'uid': uid,
      'name': 'Independent Driver',
      'phone': '+919876543210',
      'truckType': 'flatbed',
      'vehicleNumber': 'KA01AB1234',
      'verificationStatus': 'approved',
      'isOnDuty': on,
      'activeDutySessionId': on ? 'S' : null,
      'dutyGeneration': 2,
      'lifecycleSeq': on ? 7 : null,
      'workerReady': false,
    };

class AuditUser implements User {
  @override
  final String uid;
  AuditUser(this.uid);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class AuditAuth extends AuthService {
  final stream = StreamController<User?>.broadcast(sync: true);
  User? user = AuditUser('A');
  final signouts = <String?>[];

  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => stream.stream;

  void select(String? uid) {
    user = uid == null ? null : AuditUser(uid);
    stream.add(user);
  }

  void change(String uid) => select(uid);

  @override
  Future<void> signOut() async {
    signouts.add(user?.uid);
    user = null;
    stream.add(null);
  }
}

class HeldReceipt {
  final String boundary;
  final bool throws;
  final hit = Completer<Object?>();
  final released = Completer<void>();
  Object? sample;
  HeldReceipt(this.boundary, {this.throws = false});

  Future<T> deliver<T>(String key, T sample) async {
    if (boundary != key || hit.isCompleted) return sample;
    this.sample = sample;
    hit.complete(sample);
    await released.future;
    if (throws) throw PlatformException(code: 'AUDIT_HELD_FAILURE', details: key);
    return sample;
  }

  void resume() {
    if (!released.isCompleted) released.complete();
  }
}

// Independent MethodChannel authority model.
class ChannelAuthority {
  DurableDutyOwnerRecord? owner;
  bool running = false;
  int epoch = 0;
  int sequence = 0;
  HeldReceipt? heldStart;
  int starts = 0;
  int serial = 0;
  final leases = <String, Map<String, dynamic>>{};

  Future<Object?> handle(MethodCall call) async {
    final args = call.arguments == null
        ? <String, dynamic>{}
        : Map<String, dynamic>.from(call.arguments as Map);
    Object? response;
    switch (call.method) {
      case 'getDurableOwner':
        response = owner?.encode();
        break;
      case 'isServiceRunning':
        response = running;
        break;
      case 'getMonotonicSequence':
        response = sequence;
        break;
      case 'beginCleanupAcquisition':
        if (owner != null && owner!.uid != args['expectedUid']) {
          throw PlatformException(code: 'UID_CONFLICT');
        }
        final token = 'independent-lease-${++serial}';
        final lease = {
          'token': token,
          'operationId': args['operationId'],
          'captured': owner != null,
          'owner': owner?.encode(),
          'epoch': epoch,
        };
        leases[token] = lease;
        response = Map<String, dynamic>.from(lease);
        break;
      case 'validateCleanupAcquisition':
        final lease = leases[args['token']];
        response = lease != null &&
            lease['operationId'] == args['operationId'] &&
            lease['epoch'] == epoch;
        break;
      case 'releaseCleanupAcquisition':
        final lease = leases[args['token']];
        response = lease != null && lease['operationId'] == args['operationId'];
        if (response == true) leases.remove(args['token']);
        break;
      case 'atomicStartService':
        final payload = DurableDutyOwnerRecord.fromJson(
            args['sessionPayloadJson'] as String);
        if (payload.lifecycleSeq <= sequence ||
            args['foregroundTaskOptionsMap']?['callbackHandle'] != 1) {
          response = {'success': false, 'reason': 'invalid_native_start'};
        } else {
          epoch++;
          sequence = payload.lifecycleSeq;
          owner = payload;
          running = true;
          response = {
            'success': true,
            'active': true,
            'state': 'ACTIVE',
            'executionEpoch': epoch,
            'generation': payload.generation,
            'lifecycleSeq': payload.lifecycleSeq,
            'sessionId': payload.sessionId,
          };
        }
        starts++;
        break;
      case 'atomicStopService':
        final exact = owner != null &&
            owner!.uid == args['expectedUid'] &&
            owner!.sessionId == args['expectedSessionId'] &&
            owner!.generation == args['expectedGeneration'] &&
            owner!.lifecycleSeq == args['expectedLifecycleSeq'];
        if (exact) {
          owner = null;
          running = false;
        }
        response = {
          'success': true,
          'stopped': exact,
          'reason': exact ? 'stopped' : 'different_or_absent_owner',
        };
        break;
      default:
        throw MissingPluginException('Unexpected native method ${call.method}');
    }
    if (call.method == 'atomicStartService' && heldStart != null) {
      return heldStart!.deliver('start:$starts', response);
    }
    return response;
  }

  Future<void> start(List<Object> t) async {
    final result = await NativeOwnershipCoordinator.atomicStartService(
      record: record(t),
      foregroundTaskOptionsMap: {'callbackHandle': 1},
    );
    expect(result['success'], true, reason: 'Legal native START must be admitted');
    expect(result['active'], true);
  }

  List<Object?> get currentTuple =>
      owner == null ? [] : [owner!.uid, owner!.sessionId, owner!.generation, owner!.lifecycleSeq];
}

class AuditLocation extends DriverLocationService {
  @override
  void dispose() {}
  final ChannelAuthority native;
  final counts = <String, int>{};
  final calls = <Map<String, Object?>>[];
  final ends = <List<dynamic>>[];
  final stops = <List<dynamic>>[];
  HeldReceipt? held;
  bool failStop = false;
  Map<String, dynamic>? fresh;
  bool denyBackground = false;
  DutyActivationPreparation preparation =
      const DutyActivationPreparation(sessionId: 'S', generation: 2, attemptSeq: 5);
  NativeCleanupAcquisition? acquired;

  AuditLocation(this.native);

  void resetCounters() {
    counts.clear();
    calls.clear();
    ends.clear();
    stops.clear();
  }

  Future<T> receipt<T>(String boundary, T sample, {Object? detail}) async {
    final visit = (counts[boundary] ?? 0) + 1;
    counts[boundary] = visit;
    final key = '$boundary:$visit';
    calls.add({
      'boundary': key,
      'sample': sample is DurableDutyOwnerRecord
          ? sample.toMap()
          : sample is DutySession
              ? tuple(sample)
              : sample.toString(),
      'detail': detail,
    });
    return held == null ? sample : held!.deliver(key, sample);
  }

  @override
  int? get currentLifecycleSeq => 99;
  @override
  int? get currentGeneration => 99;
  @override
  DutySession? get currentServiceSession => null;

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async =>
      receipt('owner', await NativeOwnershipCoordinator.getDurableOwner());

  @override
  Future<DutySession?> getDurableSession() async {
    final r = await NativeOwnershipCoordinator.getDurableOwner();
    return receipt(
      'session',
      r == null
          ? null
          : DutySession(
              uid: r.uid,
              sessionId: r.sessionId,
              generation: r.generation,
              lifecycleSeq: r.lifecycleSeq,
            ),
    );
  }

  @override
  Future<bool> isForegroundServiceRunning() async =>
      receipt('running', await NativeOwnershipCoordinator.isServiceRunning());

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async =>
      receipt('fresh', fresh == null ? null : Map<String, dynamic>.from(fresh!));

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    final t = [uid, sessionId, generation, lifecycleSeq];
    calls.add({'END': t});
    ends.add(t);
    await receipt('end', true, detail: t);
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    final t = [expectedUid, expectedSessionId, expectedGeneration, expectedLifecycleSeq];
    calls.add({'STOP': t});
    stops.add(t);
    if (failStop) throw PlatformException(code: 'AUDIT_STOP_FAILURE');
    final r = await NativeOwnershipCoordinator.atomicStopService(
      expectedUid: expectedUid!,
      expectedSessionId: expectedSessionId,
      expectedGeneration: expectedGeneration!,
      expectedLifecycleSeq: expectedLifecycleSeq!,
    );
    if (r['success'] != true) throw StateError('Exact native STOP rejected');
    await receipt('stop', true, detail: t);
  }

  @override
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(
      String operationId, String uid) async {
    acquired = await NativeOwnershipCoordinator.beginCleanupAcquisition(
        operationId, uid);
    return receipt('acquire', acquired!);
  }

  @override
  Future<bool> validateCleanupAcquisition(
      NativeCleanupAcquisition lease) async =>
      receipt('validate',
          await NativeOwnershipCoordinator.validateCleanupAcquisition(lease));

  @override
  Future<void> releaseCleanupAcquisition(
      NativeCleanupAcquisition lease) async {
    await receipt('release', true);
    await NativeOwnershipCoordinator.releaseCleanupAcquisition(lease);
  }

  @override
  Future<bool> isLocationServiceEnabled() => receipt('services', true);
  @override
  Future<LocationPermissionStatus> checkPermission() =>
      receipt('foreground', LocationPermissionStatus.granted);
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() =>
      receipt('background',
          denyBackground ? LocationPermissionStatus.denied : LocationPermissionStatus.granted);
  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async =>
      LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async =>
      LocationPermissionStatus.granted;
  @override
  Future<bool> hasRequiredPermissions() async => !denyBackground;
  @override
  Future<DriverPosition?> getCurrentPosition() async =>
      DriverPosition(latitude: 12, longitude: 77, timestamp: DateTime.utc(2026, 10, 3));
  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async =>
      receipt('prepare', preparation);

  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async {
    final t = [uid, sessionId, generation, lifecycleSeq, attemptSeq];
    calls.add({'activate': t});
    await receipt('activate', true, detail: t);
    return {
      'status': 'activated',
      'dutyGeneration': generation,
      'lifecycleSeq': lifecycleSeq,
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
    final allocated = session.copyWith(lifecycleSeq: 7);
    await native.start(tuple(allocated).cast<Object>());
    onAuthorityAllocated?.call(allocated);
    return receipt('startReply', true);
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    final t = [uid, sessionId, generation, lifecycleSeq, attemptSeq];
    calls.add({'CANCEL': t});
    await receipt('cancel', true, detail: t);
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    calls.add({'OFF': uid});
    await receipt('off', true);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class Fixture {
  final ChannelAuthority native = ChannelAuthority();
  final AuditAuth auth = AuditAuth();
  late final AuditLocation location = AuditLocation(native);
  late final DutyController controller = DutyController(
    locationService: location,
    authService: auth,
  );
  int notifications = 0;

  Future<void> setup(int caller, {bool worker = true}) async {
    NativeOwnershipCoordinator.resetTestSimulation();
    expect(NativeOwnershipCoordinator.useTestSimulation, false);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, native.handle);
    if (worker) await native.start(oldTuple);
    location.fresh = profileData(oldTuple, on: caller != 4, approved: caller != 3);
    location.denyBackground = caller == 8;
    controller.updateProfile(DriverProfile.fromMap(location.fresh!, 'A'));
    controller.addListener(() => notifications++);
    if (caller == 2) {
      // Establish cleanup debt by failing STOP once
      location.failStop = true;
      expect(await controller.requestGoOffDuty(), false);
      expect(tuple(controller.pendingCleanupSession), oldTuple);
      location.failStop = false;
    }
    location.resetCounters();
    notifications = 0;
  }

  Future<Object?> run(int caller) async {
    if (caller == 1) return controller.requestGoOffDuty();
    if (caller == 2) return controller.retryCleanup();
    await controller.reconcileDutyState();
    return null;
  }

  Future<void> close() async {
    location.held?.resume();
    native.heldStart?.resume();
    controller.dispose();
    await auth.stream.close();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
    NativeOwnershipCoordinator.resetTestSimulation();
  }
}

int finalOwner(int c) => c == 2 ? 2 : 3;

Future<Object?> settled(Future<Object?> pending) async {
  try {
    return await pending;
  } catch (e) {
    return {'thrown': e.toString()};
  }
}

// ============================================================================
// MAIN TEST SUITE (27 FAILURES FROM M5 AUDIT 20261003)
// ============================================================================
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // --------------------------------------------------------------------------
  // ROOT C (15 cases): Callers 1, 2, 3, 4, 8 with held START reply
  // --------------------------------------------------------------------------
  for (final c in [1, 2, 3, 4, 8]) {
    for (var r = 0; r < replacements.length; r++) {
      final name = 'MATRIX C$c native START committed reply held replacement$r';
      test(name, () async {
        final f = Fixture();
        await f.setup(c);
        final proof = HeldReceipt('owner:${finalOwner(c)}');
        f.location.held = proof;

        try {
          final old = f.run(c);
          await proof.hit.future.timeout(const Duration(seconds: 2));

          final start = HeldReceipt('start:2');
          f.native.heldStart = start;
          final newer = f.native.start(replacements[r]);
          await start.hit.future.timeout(const Duration(seconds: 2));

          expect(f.native.currentTuple, replacements[r]);
          expect(f.native.running, true);
          expect(f.native.epoch, 2);
          expect(NativeOwnershipCoordinator.currentEpoch, 1);

          proof.resume();
          final result = await settled(old);
          start.resume();
          await newer;

          expect(f.native.currentTuple, replacements[r]);
          expect(f.native.running, true);
          if (c == 1 || c == 2) expect(result, false);
          expect(f.controller.isCleanupRequired, true);
          expect(f.controller.trackingHealth, TrackingHealth.reconciliationFailed);
        } finally {
          await f.close();
        }
      });
    }
  }

  // --------------------------------------------------------------------------
  // ROOT C (6 cases): Callers 5 & 6 (Mounted & Unmounted Logout) held START reply
  // --------------------------------------------------------------------------
  for (final mounted in [true, false]) {
    for (var form = 0; form < 3; form++) {
      final name =
          'MATRIX C${mounted ? 5 : 6} active replacement$form held START acknowledgement';
      test(name, () async {
        final native = ChannelAuthority();
        final auth = AuditAuth();
        final loc = AuditLocation(native);
        NativeOwnershipCoordinator.resetTestSimulation();
        DriverLocationService.resetPendingCleanupTokensForTesting();
        AppLogoutCoordinator.resetInFlightLogoutForTesting();
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, native.handle);

        await native.start(oldTuple);
        loc.fresh = serverData('A');
        DutyController? controller;
        if (mounted) {
          controller = DutyController(locationService: loc, authService: auth);
          controller.updateProfile(DriverProfile.fromMap(loc.fresh!, 'A'));
        }
        final logout = AppLogoutCoordinator(
          authService: auth,
          locationService: loc,
          dutyController: controller,
        );

        final finalProof = HeldReceipt('validate:${mounted ? 3 : 4}');
        loc.held = finalProof;

        try {
          final future = logout.coordinateLogout(
            profile: DriverProfile.fromMap(loc.fresh!, 'A'),
          );
          await finalProof.hit.future.timeout(const Duration(seconds: 2));

          final start = HeldReceipt('start:2');
          native.heldStart = start;
          final replacementReply = native.start(replacements[form]);
          await start.hit.future.timeout(const Duration(seconds: 2));

          final cachedBeforeDelivery = NativeOwnershipCoordinator.currentEpoch;
          final nativeBeforeDelivery = native.epoch;
          expect(cachedBeforeDelivery, 1);
          expect(nativeBeforeDelivery, 2);
          expect(native.running, true);
          expect(native.currentTuple, replacements[form]);

          finalProof.resume();
          final outcome = await future;
          start.resume();
          await replacementReply;

          expect(native.currentTuple, replacements[form]);
          expect(native.running, true);
          expect(loc.ends, [['A', 'S', 2, 7]]);
          expect(loc.stops, [['A', 'S', 2, 7]]);
          expect(auth.signouts, isEmpty,
              reason: 'Native ACTIVE replacement must invalidate final absence before signOut');
          expect(outcome, LogoutResult.failedDutyTransition);
        } finally {
          controller?.dispose();
          await auth.stream.close();
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
          NativeOwnershipCoordinator.resetTestSimulation();
          AppLogoutCoordinator.resetInFlightLogoutForTesting();
        }
      });
    }
  }

  // --------------------------------------------------------------------------
  // ROOT C (2 cases): Callers 5 & 6 fresh isolate current native exact absence
  // --------------------------------------------------------------------------
  for (final mounted in [true, false]) {
    final name =
        'MATRIX C${mounted ? 5 : 6} fresh isolate current native exact absence';
    test(name, () async {
      final native = ChannelAuthority();
      final auth = AuditAuth();
      final loc = AuditLocation(native);
      NativeOwnershipCoordinator.resetTestSimulation();
      DriverLocationService.resetPendingCleanupTokensForTesting();
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, native.handle);

      // Reconstructed state: native admits P at epoch 1, but Dart isolate is fresh (cache 0)
      await native.handle(MethodCall('atomicStartService', {
        'sessionId': 'S',
        'uid': 'A',
        'dutyGeneration': 2,
        'lifecycleSeq': 7,
        'sessionPayloadJson': record(oldTuple).encode(),
        'foregroundTaskOptionsMap': {'callbackHandle': 1},
      }));
      expect(NativeOwnershipCoordinator.currentEpoch, 0);
      expect(native.epoch, 1);

      loc.fresh = serverData('A');
      DutyController? controller;
      if (mounted) {
        controller = DutyController(locationService: loc, authService: auth);
        controller.updateProfile(DriverProfile.fromMap(loc.fresh!, 'A'));
      }
      final logout = AppLogoutCoordinator(
        authService: auth,
        locationService: loc,
        dutyController: controller,
      );

      try {
        final outcome = await logout.coordinateLogout(
          profile: DriverProfile.fromMap(loc.fresh!, 'A'),
        );
        expect(loc.ends, [['A', 'S', 2, 7]]);
        expect(loc.stops, [['A', 'S', 2, 7]]);
        expect(native.owner, null);
        expect(native.running, false);
        expect(outcome, LogoutResult.success,
            reason: 'Genuine current absence must remain usable after reconstruction');
        expect(auth.signouts, ['A']);
      } finally {
        controller?.dispose();
        await auth.stream.close();
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
        NativeOwnershipCoordinator.resetTestSimulation();
        AppLogoutCoordinator.resetInFlightLogoutForTesting();
      }
    });
  }

  // --------------------------------------------------------------------------
  // ROOT C (3 cases): Caller 9 production admitted START held reply freshness
  // --------------------------------------------------------------------------
  for (var i = 0; i < 3; i++) {
    final name =
        'MATRIX C9 production admitted START held reply freshness replacement$i';
    test(name, () async {
      final native = ChannelAuthority();
      final auth = AuditAuth();
      final loc = AuditLocation(native);
      NativeOwnershipCoordinator.resetTestSimulation();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, native.handle);

      loc.fresh = profileData(oldTuple, on: false);
      final controller = DutyController(
        locationService: loc,
        authService: auth,
      );
      controller.updateProfile(DriverProfile.fromMap(loc.fresh!, 'A'));

      final activation = HeldReceipt('activate:1');
      final absent = HeldReceipt('owner:2');
      loc.held = activation;

      try {
        final op = controller.requestGoOnDuty(onShowDisclosure: () async => true);
        await activation.hit.future.timeout(const Duration(seconds: 2));

        // Logout barrier triggers compensation
        controller.beginLogoutBarrier('A');
        loc.held = absent;
        activation.resume();
        await absent.hit.future.timeout(const Duration(seconds: 2));

        // Start replacement in native with held reply
        final start = HeldReceipt('start:2');
        native.heldStart = start;
        final replacementReply = native.start(replacements[i]);
        await start.hit.future.timeout(const Duration(seconds: 2));

        expect(native.currentTuple, replacements[i]);
        expect(NativeOwnershipCoordinator.currentEpoch, 1);
        expect(native.epoch, 2);

        absent.resume();
        final opResult = await op;
        expect(opResult, false);

        start.resume();
        await replacementReply;

        expect(native.currentTuple, replacements[i]);
        expect(native.running, true);
        expect(controller.isCleanupRequired, true,
            reason: 'current replacement invalidates old absence');
        expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      } finally {
        controller.dispose();
        await auth.stream.close();
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
        NativeOwnershipCoordinator.resetTestSimulation();
      }
    });
  }

  // --------------------------------------------------------------------------
  // ROOT B (1 case): Reentrant clear final notification new A lease
  // --------------------------------------------------------------------------
  test('MATRIX B reentrant clear final notification new A lease', () async {
    final native = ChannelAuthority();
    final auth = AuditAuth();
    final loc = AuditLocation(native);
    NativeOwnershipCoordinator.resetTestSimulation();
    DriverLocationService.resetPendingCleanupTokensForTesting();
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, native.handle);

    await native.start(oldTuple);
    loc.fresh = serverData('A');
    final controller = DutyController(locationService: loc, authService: auth);
    controller.updateProfile(DriverProfile.fromMap(loc.fresh!, 'A'));
    final logout = AppLogoutCoordinator(
      authService: auth,
      locationService: loc,
      dutyController: controller,
    );

    var offNotifications = 0;
    var installed = false;
    LogoutBarrierLease? successor;
    controller.addListener(() {
      if (!installed &&
          controller.authoritativeDutyState.name == 'offDuty' &&
          controller.trackingHealth.name == 'off') {
        offNotifications++;
        if (offNotifications == 2) {
          installed = true;
          successor = controller.beginLogoutBarrier('A');
        }
      }
    });

    try {
      final outcome = await logout.coordinateLogout(
        profile: DriverProfile.fromMap(loc.fresh!, 'A'),
      );
      expect(installed, true);
      expect(successor, isNotNull);
      expect(controller.isLogoutBarrierActive(successor!), true);
      expect(auth.signouts, isEmpty);
      expect(auth.user?.uid, 'A');
      expect(outcome, LogoutResult.failedDutyTransition);
    } finally {
      controller.dispose();
      await auth.stream.close();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
      NativeOwnershipCoordinator.resetTestSimulation();
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
    }
  });
}
