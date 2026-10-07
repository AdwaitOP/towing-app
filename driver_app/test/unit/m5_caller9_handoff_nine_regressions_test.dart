import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';

final stamp = DateTime.utc(2026, 10, 5);
const p = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 7);
const replacements = [
  DutySession(uid: 'B', sessionId: 'T', generation: 3, lifecycleSeq: 8),
  DutySession(uid: 'A', sessionId: 'S', generation: 3, lifecycleSeq: 8),
  DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 8),
];

class AuditUser implements User {
  @override
  final String uid;
  AuditUser(this.uid);
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

class AuditAuth extends AuthService {
  User? user = AuditUser('A');
  final events = StreamController<User?>.broadcast(sync: true);
  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => events.stream;
  void publish(String? uid) {
    user = uid == null ? null : AuditUser(uid);
    events.add(user);
  }
}

class Hold {
  final String action;
  final int visit;
  final arrived = Completer<void>();
  final release = Completer<void>();
  bool throws = false;
  Hold(this.action, this.visit);
}

class Scheduler {
  final holds = <Hold>[];
  final visits = <String, int>{};
  void Function(String, int)? afterDelivery;
  Hold hold(String action, [int visit = 1]) {
    final h = Hold(action, visit);
    holds.add(h);
    return h;
  }

  Future<T> deliver<T>(String action, T sample) async {
    final n = (visits[action] ?? 0) + 1;
    visits[action] = n;
    for (final h in List<Hold>.of(holds)) {
      if (h.action == action && h.visit == n) {
        h.arrived.complete();
        await h.release.future;
        if (h.throws) {
          throw PlatformException(
            code: 'LIVE_AUDIT_$action',
            message: 'Held receipt failure',
          );
        }
      }
    }
    afterDelivery?.call(action, n);
    return sample;
  }

  void reset() {
    visits.clear();
    holds.clear();
  }
}

class NativeModel {
  final Scheduler scheduler;
  DurableDutyOwnerRecord? owner;
  bool running = false;
  int epoch = 0;
  int highestLifecycle = 0;
  int nextLifecycle = 7;
  final calls = <Map<String, dynamic>>[];
  NativeModel(this.scheduler);

  void attach() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(NativeOwnershipCoordinator.channel,
            (call) async {
      final a = Map<String, dynamic>.from((call.arguments as Map?) ?? {});
      calls.add({
        'method': call.method,
        'args': a,
        'counterAtDispatch': NativeOwnershipCoordinator.hasStartInFlight,
      });
      switch (call.method) {
        case 'atomicStartService':
          if (a['lifecycleSeq'] is! int ||
              (a['lifecycleSeq'] as int) <= highestLifecycle) {
            return {
              'success': false,
              'reason': 'independent_monotonic_sequence_rejected'
            };
          }
          highestLifecycle = a['lifecycleSeq'];
          owner = DurableDutyOwnerRecord(
            uid: a['uid'],
            sessionId: a['sessionId'],
            generation: a['dutyGeneration'],
            lifecycleSeq: a['lifecycleSeq'],
            startedAt: stamp,
          );
          running = true;
          epoch++;
          return scheduler.deliver('nativeStart', {
            'success': true,
            'active': true,
            'lifecycleSeq': owner!.lifecycleSeq,
            'executionEpoch': epoch,
          });
        case 'atomicStopService':
          final o = owner;
          final matches = o != null &&
              o.uid == a['expectedUid'] &&
              o.sessionId == a['expectedSessionId'] &&
              o.generation == a['expectedGeneration'] &&
              o.lifecycleSeq == a['expectedLifecycleSeq'];
          if (matches) {
            owner = null;
            running = false;
          }
          return {'success': true, 'stopped': matches};
        case 'getDurableOwner':
          return owner?.encode();
        case 'isServiceRunning':
          return running;
        case 'getMonotonicSequence':
          return nextLifecycle;
        default:
          throw StateError('Unhandled production native method ${call.method}');
      }
    });
  }

  Future<Map<String, dynamic>> start(DutySession s) =>
      NativeOwnershipCoordinator.atomicStartService(
        record: DurableDutyOwnerRecord(
          uid: s.uid,
          sessionId: s.sessionId,
          generation: s.generation,
          lifecycleSeq: s.lifecycleSeq!,
          startedAt: stamp,
        ),
        foregroundTaskOptionsMap: {'callbackHandle': 1},
      );
}

class AuditLocation extends LocationService {
  final Scheduler scheduler;
  final NativeModel native;
  DutySession? server;
  int endFailures = 0;
  final endCalls = <List<dynamic>>[];
  final stopCalls = <List<dynamic>>[];
  AuditLocation(this.scheduler, this.native);

  @override
  int? get currentGeneration => native.owner?.generation;
  @override
  int? get currentLifecycleSeq => native.owner?.lifecycleSeq;
  @override
  DutySession? get currentServiceSession =>
      native.owner == null ? null : asSession(native.owner!);
  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async =>
      scheduler.deliver('owner', await NativeOwnershipCoordinator.getDurableOwner());
  @override
  Future<DutySession?> getDurableSession() async => scheduler.deliver(
      'session', native.owner == null ? null : asSession(native.owner!));
  @override
  Future<bool> isForegroundServiceRunning() async => scheduler.deliver(
      'running', await NativeOwnershipCoordinator.isServiceRunning());
  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession)? onAuthorityAllocated,
  }) async {
    final allocated = session.copyWith(lifecycleSeq: native.nextLifecycle++);
    final result = await native.start(allocated);
    if (result['success'] == true) onAuthorityAllocated?.call(allocated);
    return scheduler.deliver('start', result['success'] == true);
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    stopCalls.add([expectedUid, expectedSessionId, expectedGeneration, expectedLifecycleSeq]);
    await scheduler.deliver('stopBefore', true);
    await NativeOwnershipCoordinator.atomicStopService(
      expectedUid: expectedUid!,
      expectedSessionId: expectedSessionId,
      expectedGeneration: expectedGeneration!,
      expectedLifecycleSeq: expectedLifecycleSeq!,
    );
    await scheduler.deliver('stop', true);
  }

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    return scheduler.deliver(
        'prepare', const DutyActivationPreparation(sessionId: 'S', generation: 2, attemptSeq: 5));
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
    server = DutySession(uid: uid, sessionId: sessionId, generation: generation!, lifecycleSeq: lifecycleSeq);
    return scheduler.deliver('activate', {
      'status': 'activated',
      'workerReady': false,
      'lifecycleSeq': lifecycleSeq,
    });
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    endCalls.add([uid, sessionId, generation, lifecycleSeq]);
    await scheduler.deliver('end', true);
    if (endFailures > 0) {
      endFailures--;
      throw PlatformException(code: 'LIVE_END_DEBT');
    }
    if (server?.uid == uid &&
        server?.sessionId == sessionId &&
        server?.generation == generation &&
        server?.lifecycleSeq == lifecycleSeq) {
      server = null;
    }
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    await scheduler.deliver('cancel', true);
  }

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async =>
      scheduler.deliver('fresh', profileMap(profile('A', on: true)));
  @override
  Future<bool> isLocationServiceEnabled() => scheduler.deliver('services', true);
  @override
  Future<LocationPermissionStatus> checkPermission() =>
      scheduler.deliver('foreground', LocationPermissionStatus.granted);
  @override
  Future<LocationPermissionStatus> requestForegroundPermission() =>
      scheduler.deliver('requestForeground', LocationPermissionStatus.granted);
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() =>
      scheduler.deliver('background', LocationPermissionStatus.granted);
  @override
  Future<LocationPermissionStatus> requestNotificationPermission() =>
      scheduler.deliver('notifications', LocationPermissionStatus.granted);
  @override
  Future<bool> hasRequiredPermissions() async => true;
  @override
  Future<DriverPosition?> getCurrentPosition() => scheduler.deliver(
      'position', DriverPosition(latitude: 18, longitude: 73, timestamp: stamp));
  @override
  Stream<DriverPosition> getPositionStream() => const Stream.empty();
  @override
  DriverPosition? get lastKnownPosition =>
      DriverPosition(latitude: 18, longitude: 73, timestamp: stamp);
  @override
  Future<bool> openAppSettings() async => true;
  @override
  Future<void> sendHeartbeat({required String uid, required DriverPosition position}) async {}
  @override
  Future<void> executeGoOnDutyTransaction({required String uid}) async {}
  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {}
  @override
  void dispose() {}
}

DutySession asSession(DurableDutyOwnerRecord o) => DutySession(
      uid: o.uid,
      sessionId: o.sessionId,
      generation: o.generation,
      lifecycleSeq: o.lifecycleSeq,
    );

DriverProfile profile(String uid, {bool on = false}) => DriverProfile(
      uid: uid,
      name: 'Audit $uid',
      phone: '+919999999999',
      truckType: TruckType.flatbed,
      vehicleNumber: 'AUDIT',
      verificationStatus: 'approved',
      isOnDuty: on,
      activeDutySessionId: on ? 'S' : null,
      dutyGeneration: on ? 2 : null,
      lifecycleSeq: on ? 7 : null,
      workerReady: false,
    );

Map<String, dynamic> profileMap(DriverProfile p) => {
      'uid': p.uid,
      'name': p.name,
      'phone': p.phone,
      'truckType': 'flatbed',
      'vehicleNumber': p.vehicleNumber,
      'verificationStatus': 'approved',
      'isOnDuty': p.isOnDuty,
      'activeDutySessionId': p.activeDutySessionId,
      'dutyGeneration': p.dutyGeneration,
      'lifecycleSeq': p.lifecycleSeq,
      'workerReady': p.workerReady,
    };

class Rig {
  final Scheduler s = Scheduler();
  final AuditAuth auth = AuditAuth();
  late final NativeModel native = NativeModel(s);
  late final AuditLocation location = AuditLocation(s, native);
  late final DutyController duty =
      DutyController(locationService: location, authService: auth, clock: () => stamp);
  final publications = <Map<String, dynamic>>[];

  Rig() {
    NativeOwnershipCoordinator.resetTestSimulation();
    native.attach();
    duty.updateProfile(profile('A'));
    duty.addListener(() {
      publications.add({
        'state': {
          'duty': duty.authoritativeDutyState.name,
          'health': duty.trackingHealth.name,
          'cleanup': duty.isCleanupRequired,
        },
        'nativeRunning': native.running,
        'nativeEpoch': native.epoch,
        'dartEpoch': NativeOwnershipCoordinator.currentEpoch,
        'hasStartInFlight': NativeOwnershipCoordinator.hasStartInFlight,
      });
    });
  }

  Future<bool> goOn() => duty.requestGoOnDuty(onShowDisclosure: () => s.deliver('disclosure', true));
  Future<void> close() async {
    duty.dispose();
    await auth.events.close();
    NativeOwnershipCoordinator.resetTestSimulation();
  }
}

Future<void> arrive(Hold h) => h.arrived.future.timeout(const Duration(seconds: 5));
Future<T> settled<T>(Future<T> f) => f.timeout(const Duration(seconds: 5));
Future<void> ticks() async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('CALLER9 FINAL HANDOFF CLOSURE — 9 FAILING SCHEDULES', () {
    // 6 Schedules with handoff callback: 3 replacements x (reply completed vs reply held)
    for (var index = 0; index < 3; index++) {
      for (final heldReply in [false, true]) {
        final name = 'MATRIX C9 current predecessor handoff native R$index heldReply=$heldReply';
        test(name, () async {
          final r = Rig();
          final activation = r.s.hold('activate');
          final old = r.goOn();
          await arrive(activation);
          r.duty.beginLogoutBarrier('A');

          final handoff = r.s.hold('handoff');
          r.duty.beforeCompensationHandoff = () async {
            await r.s.deliver('handoff', true);
          };
          activation.release.complete();
          await arrive(handoff);

          final reply = heldReply ? r.s.hold('nativeStart', 2) : null;
          final replacement = r.native.start(replacements[index]);
          if (reply == null) {
            expect((await settled(replacement))['success'], true);
          } else {
            await arrive(reply);
          }

          handoff.release.complete();
          final result = await settled(old);

          if (reply != null) {
            reply.release.complete();
            expect((await settled(replacement))['success'], true);
          }

          expect(result, false);
          expect(r.location.endCalls, [['A', 'S', 2, 7]]);
          expect(r.location.stopCalls, [['A', 'S', 2, 7]]);
          expect(r.duty.trackingHealth.name, isNot('off'));
          expect(r.duty.isCleanupRequired, true);
          await r.close();
        });
      }
    }

    // 3 Schedules without handoff callback: microtask boundary after owner:2 delivery
    for (var index = 0; index < 3; index++) {
      final noHook = 'MATRIX C9 no handoff callback stale publication R$index';
      test(noHook, () async {
        final r = Rig();
        final activation = r.s.hold('activate');
        final old = r.goOn();
        await arrive(activation);
        r.duty.beginLogoutBarrier('A');
        final proof = r.s.hold('owner', 2);
        activation.release.complete();
        await arrive(proof);

        Future<Map<String, dynamic>>? replacement;
        r.s.afterDelivery = (action, visit) {
          if (action == 'owner' && visit == 2) {
            scheduleMicrotask(() => replacement = r.native.start(replacements[index]));
          }
        };

        expect(r.duty.beforeCompensationHandoff, null);
        proof.release.complete();
        expect(await settled(old), false);
        await ticks();
        expect((await replacement!)['success'], true);

        final staleClean = r.publications
            .where((e) =>
                e['state']['health'] == 'off' &&
                e['state']['cleanup'] == false &&
                e['nativeEpoch'] == 2 &&
                e['nativeRunning'] == true)
            .toList();

        expect(r.location.endCalls, [['A', 'S', 2, 7]]);
        expect(r.location.stopCalls, [['A', 'S', 2, 7]]);
        expect(staleClean, isEmpty,
            reason: 'Existing R14 caller9 TYPE-A clean publication requires current native absence');
        await r.close();
      });
    }
  });

  group('CALLER9 POSITIVE CONTROL', () {
    test('CONTROL C9 truthful current absence production channel', () async {
      final r = Rig();
      final activation = r.s.hold('activate');
      final old = r.goOn();
      await arrive(activation);
      r.duty.beginLogoutBarrier('A');
      activation.release.complete();
      expect(await settled(old), false);

      expect(r.duty.isCleanupRequired, false);
      expect(r.duty.trackingHealth.name, 'off');
      expect(r.native.owner, null);
      expect(r.native.running, false);
      expect(r.location.endCalls, [['A', 'S', 2, 7]]);
      expect(r.location.stopCalls, [['A', 'S', 2, 7]]);
      await r.close();
    });
  });
}
