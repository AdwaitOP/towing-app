import 'dart:async';
import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';

final oldTuple = <Object>['A', 'S', 2, 7];
final replacements = <List<Object>>[
  ['B', 'T', 3, 8],
  ['A', 'S', 3, 8],
  ['A', 'S', 2, 8],
];

DurableDutyOwnerRecord record(List<Object> t) => DurableDutyOwnerRecord(
      uid: t[0] as String,
      sessionId: t[1] as String,
      generation: t[2] as int,
      lifecycleSeq: t[3] as int,
      startedAt: DateTime.utc(2026, 10, 5),
    );

List<Object> tuple(DurableDutyOwnerRecord r) =>
    [r.uid, r.sessionId, r.generation, r.lifecycleSeq];

class AuditUser implements User {
  AuditUser(this.uid);
  @override
  final String uid;
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

class AuditAuth extends AuthService {
  User? user = AuditUser('A');
  final stream = StreamController<User?>.broadcast(sync: true);
  final signouts = <String?>[];
  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => stream.stream;
  void switchTo(String? uid) {
    user = uid == null ? null : AuditUser(uid);
    stream.add(user);
  }

  @override
  Future<void> signOut() async {
    signouts.add(user?.uid);
    switchTo(null);
  }
}

class Pause {
  Pause(this.label, {this.throws = false});
  final String label;
  final bool throws;
  final entered = Completer<void>();
  final released = Completer<void>();
  dynamic sampled;
}

class Transport {
  DurableDutyOwnerRecord? owner;
  bool running = false;
  bool ineffectiveStop = false;
  int epoch = 0;
  int serial = 0;
  final leases = <String, Map<String, dynamic>>{};
  final calls = <Map<String, dynamic>>[];
  Completer<void>? holdNextStart;
  Completer<void>? activeStart;
  String? malformedOwner;

  Future<dynamic> handle(MethodCall call) async {
    final a = Map<String, dynamic>.from((call.arguments as Map?) ?? {});
    calls.add({'method': call.method, 'arguments': a});
    switch (call.method) {
      case 'atomicStartService':
        final next =
            DurableDutyOwnerRecord.fromJson(a['sessionPayloadJson'] as String);
        if (owner != null && next.lifecycleSeq <= owner!.lifecycleSeq) {
          return {'success': false, 'reason': 'superseded_sequence'};
        }
        owner = next;
        running = true;
        epoch++;
        final sampled = {
          'success': true,
          'active': true,
          'state': 'ACTIVE',
          'executionEpoch': epoch,
          'generation': next.generation,
          'lifecycleSeq': next.lifecycleSeq,
        };
        if (holdNextStart != null) {
          final hold = holdNextStart!;
          holdNextStart = null;
          activeStart?.complete();
          await hold.future;
        }
        return sampled;
      case 'atomicStopService':
        final capture =
            a['cleanupToken'] == null ? null : leases[a['cleanupToken']];
        if (a['cleanupToken'] != null &&
            (capture == null ||
                capture['operationId'] != a['cleanupOperationId'])) {
          return {
            'success': false,
            'reason': 'invalid_cleanup_acquisition',
          };
        }
        final wanted = [
          a['expectedUid'],
          a['expectedSessionId'],
          a['expectedGeneration'],
          a['expectedLifecycleSeq'],
        ];
        if (owner != null && jsonEncode(tuple(owner!)) != jsonEncode(wanted)) {
          return {'success': false, 'reason': 'epoch_mismatch'};
        }
        if (!ineffectiveStop) {
          owner = null;
          running = false;
        }
        return {'success': true, 'stopped': !ineffectiveStop};
      case 'getDurableOwner':
        return malformedOwner ?? owner?.encode();
      case 'getWorkerPayload':
        return owner?.encode();
      case 'isServiceRunning':
        return running;
      case 'getMonotonicSequence':
        return owner?.lifecycleSeq ?? 7;
      case 'beginCleanupAcquisition':
        if (owner != null && owner!.uid != a['expectedUid']) {
          throw PlatformException(code: 'UID_CONFLICT');
        }
        final lease = {
          'token': 'independent-${++serial}',
          'operationId': a['operationId'],
          'captured': owner != null,
          'owner': owner?.encode(),
          'epoch': epoch,
        };
        leases[lease['token'] as String] = lease;
        return lease;
      case 'validateCleanupAcquisition':
        final lease = leases[a['token']];
        return lease != null &&
            lease['operationId'] == a['operationId'] &&
            lease['epoch'] == epoch;
      case 'releaseCleanupAcquisition':
        final lease = leases[a['token']];
        final matched =
            lease != null && lease['operationId'] == a['operationId'];
        if (matched) leases.remove(a['token']);
        return matched;
      default:
        throw MissingPluginException(call.method);
    }
  }

  Future<void> start(List<Object> t) async {
    final result = await NativeOwnershipCoordinator.atomicStartService(
      record: record(t),
      foregroundTaskOptionsMap: {'callbackHandle': 1},
    );
    expect(result['success'], true);
  }
}

class AuditLocation extends DriverLocationService {
  AuditLocation(this.native);
  final Transport native;
  final counts = <String, int>{};
  final boundaries = <String>[];
  final ends = <List<Object?>>[];
  final stops = <List<Object?>>[];
  Pause? pause;
  Map<String, dynamic>? server = {
    'uid': 'A',
    'name': 'Audit driver',
    'phone': '9999999999',
    'truckType': 'flatbed',
    'vehicleNumber': 'AUDIT',
    'isOnDuty': true,
    'verificationStatus': 'approved',
    'activeDutySessionId': 'S',
    'dutyGeneration': 2,
    'lifecycleSeq': 7,
    'workerReady': false,
  };

  Future<T> observe<T>(String kind, Future<T> pending) async {
    final sample = await pending;
    final label = '$kind:${counts.update(kind, (v) => v + 1, ifAbsent: () => 1)}';
    boundaries.add(label);
    final p = pause;
    if (p != null && p.label == label) {
      p.sampled = sample is NativeCleanupAcquisition
          ? {'epoch': sample.epoch, 'owner': sample.owner?.toMap()}
          : sample is DurableDutyOwnerRecord
              ? sample.toMap()
              : sample is DutySession
                  ? {
                      'uid': sample.uid,
                      'sessionId': sample.sessionId,
                      'generation': sample.generation,
                      'lifecycleSeq': sample.lifecycleSeq,
                    }
                  : sample;
      p.entered.complete();
      await p.released.future;
      if (p.throws) {
        throw PlatformException(
          code: 'AUDIT_HELD_REPLY_FAILURE',
          message: label,
        );
      }
    }
    return sample;
  }

  @override
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(
          String op, String uid) =>
      observe('acquire', super.beginCleanupAcquisition(op, uid));

  @override
  Future<bool> validateCleanupAcquisition(NativeCleanupAcquisition lease) =>
      observe('validate', super.validateCleanupAcquisition(lease));


  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) =>
      observe('server', Future.value(server == null ? null : Map<String, dynamic>.from(server!)));

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() =>
      observe('owner', super.getDurableOwnerRecord());

  @override
  Future<DutySession?> getDurableSession() =>
      observe('session', super.getDurableSession());

  @override
  Future<bool> isForegroundServiceRunning() =>
      observe('running', super.isForegroundServiceRunning());

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    ends.add([uid, sessionId, generation, lifecycleSeq]);
    await observe('end', Future<void>.value());
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    stops.add([expectedUid, expectedSessionId, expectedGeneration, expectedLifecycleSeq]);
    await observe(
      'stop',
      super.stopForegroundService(
        expectedUid: expectedUid,
        expectedSessionId: expectedSessionId,
        expectedGeneration: expectedGeneration,
        expectedLifecycleSeq: expectedLifecycleSeq,
      ),
    );
  }

  @override
  void dispose() {}
}

class Fixture {
  Fixture(this.mounted);
  final bool mounted;
  final auth = AuditAuth();
  final native = Transport();
  late final AuditLocation location = AuditLocation(native);
  DutyController? controller;

  AppLogoutCoordinator get coordinator => AppLogoutCoordinator(
        authService: auth,
        locationService: location,
        dutyController: controller,
      );

  Future<void> setup({bool fresh = false}) async {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    NativeOwnershipCoordinator.resetTestSimulation();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
            NativeOwnershipCoordinator.channel, native.handle);
    if (fresh) {
      native.owner = record(oldTuple);
      native.running = true;
      native.epoch = 1;
    } else {
      await native.start(oldTuple);
    }
    if (mounted) {
      controller = DutyController(
        authService: auth,
        locationService: location,
      );
      controller!.updateProfile(
        DriverProfile.fromMap(location.server!, 'A'),
      );
    }
  }

  Future<void> close() async {
    controller?.dispose();
    await auth.stream.close();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
    NativeOwnershipCoordinator.resetTestSimulation();
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Caller 5 / prepareForSignOut Final Publication Freshness Regressions', () {
    for (var r = 0; r < 3; r++) {
      test('FINAL_BOUNDARY C5 replacement R$r at completed final running receipt',
          () async {
        final f = Fixture(true);
        await f.setup();
        try {
          final emitted = <Map<String, dynamic>>[];
          f.controller!.addListener(() {
            if (f.native.owner != null &&
                tuple(f.native.owner!)[3] == 8 &&
                f.controller!.authoritativeDutyState.name == 'offDuty' &&
                f.controller!.trackingHealth.name == 'off' &&
                !f.controller!.isCleanupRequired) {
              emitted.add({
                'duty': f.controller!.authoritativeDutyState.name,
                'health': f.controller!.trackingHealth.name,
              });
            }
          });
          final p = Pause('running:3');
          f.location.pause = p;
          final old = f.coordinator.coordinateLogout();
          await p.entered.future.timeout(const Duration(seconds: 5));
          expect(p.sampled, false);
          await f.native.start(replacements[r]);
          expect(NativeOwnershipCoordinator.hasStartInFlight, false);
          expect(NativeOwnershipCoordinator.currentEpoch, 2);
          p.released.complete();
          final result = await old;

          expect(result, LogoutResult.failedDutyTransition);
          expect(f.auth.signouts, isEmpty);
          expect(f.auth.currentUser?.uid, 'A');
          expect(tuple(f.native.owner!), replacements[r]);
          expect(f.native.running, true);
          expect(emitted, isEmpty,
              reason: 'TYPE-A clean publication requires current native absence');
          expect(f.location.ends, [oldTuple]);
          expect(f.location.stops, [oldTuple]);
        } finally {
          await f.close();
        }
      });
    }

    test('CONTROL C5 genuine current absence succeeds cleanly', () async {
      final f = Fixture(true);
      await f.setup();
      try {
        final result = await f.coordinator.coordinateLogout();
        expect(result, LogoutResult.success);
        expect(f.auth.signouts, ['A']);
        expect(f.location.ends, [oldTuple]);
        expect(f.location.stops, [oldTuple]);
      } finally {
        await f.close();
      }
    });

    test('LATEST27 C5 fresh-isolate genuine native absence succeeds cleanly',
        () async {
      final f = Fixture(true);
      await f.setup(fresh: true);
      try {
        expect(NativeOwnershipCoordinator.currentEpoch, 0);
        final result = await f.coordinator.coordinateLogout();
        expect(result, LogoutResult.success);
        expect(f.auth.signouts, ['A']);
        expect(f.native.owner, isNull);
        expect(f.native.running, false);
        expect(f.location.ends, [oldTuple]);
        expect(f.location.stops, [oldTuple]);
      } finally {
        await f.close();
      }
    });

    test('LATEST27 C5 replacement R0 ACTIVE with START reply held rejects logout',
        () async {
      final f = Fixture(true);
      await f.setup();
      Future<void>? replacement;
      final hold = Completer<void>();
      try {
        final p = Pause('owner:7');
        f.location.pause = p;
        final old = f.coordinator.coordinateLogout();
        await p.entered.future.timeout(const Duration(seconds: 5));
        expect(p.sampled, isNull);
        f.native.holdNextStart = hold;
        f.native.activeStart = Completer<void>();
        replacement = f.native.start(replacements[0]);
        await f.native.activeStart!.future.timeout(const Duration(seconds: 5));
        expect(f.native.running, true);
        expect(NativeOwnershipCoordinator.hasStartInFlight, true);
        expect(NativeOwnershipCoordinator.currentEpoch, 1);
        p.released.complete();
        final result = await old;

        expect(result, LogoutResult.failedDutyTransition);
        expect(f.auth.signouts, isEmpty);
        expect(f.auth.currentUser?.uid, 'A');
        expect(tuple(f.native.owner!), replacements[0]);
        expect(f.location.ends, [oldTuple]);
        expect(f.location.stops, [oldTuple]);
      } finally {
        if (!hold.isCompleted) hold.complete();
        await replacement;
        await f.close();
      }
    });
  });
}
