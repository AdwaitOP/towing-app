import 'dart:convert';

import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:flutter_test/flutter_test.dart';

import 'duty_controller_test.dart' as fixtures;

/// Uses the production native owner/session adapters, with only server and
/// permission dependencies replaced. Both native reads go through the channel.
class NativeReadLocationService extends DriverLocationService {
  final Map<String, dynamic> server;
  final List<DutySession?> durableSessions = [];
  final List<Map<String, dynamic>> exactStops = [];

  NativeReadLocationService(this.server);

  @override
  Future<DutySession?> getDurableSession() async {
    final session = await super.getDurableSession();
    durableSessions.add(session);
    return session;
  }

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async =>
      server;

  @override
  Future<bool> isLocationServiceEnabled() async => true;

  @override
  Future<LocationPermissionStatus> checkPermission() async =>
      LocationPermissionStatus.granted;

  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async =>
      LocationPermissionStatus.granted;

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    exactStops.add({
      'uid': expectedUid,
      'sessionId': expectedSessionId,
      'generation': expectedGeneration,
      'lifecycleSeq': expectedLifecycleSeq,
    });
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const profile = DriverProfile(
    uid: 'uid-a',
    name: 'Driver',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 AB 1234',
    verificationStatus: 'approved',
    isOnDuty: true,
    activeDutySessionId: 'same-session',
    dutyGeneration: 2,
    lifecycleSeq: 7,
    workerReady: true,
  );

  Map<String, dynamic> server({Object? seq = 7, Object? ready = true}) => {
    'uid': profile.uid,
    'name': profile.name,
    'phone': profile.phone,
    'truckType': profile.truckType.backendValue,
    'vehicleNumber': profile.vehicleNumber,
    'verificationStatus': profile.verificationStatus,
    'isOnDuty': true,
    'activeDutySessionId': profile.activeDutySessionId,
    'dutyGeneration': 2,
    'lifecycleSeq': ?seq,
    'workerReady': ?ready,
  };

  String owner(Object? seq) => jsonEncode({
    'uid': profile.uid,
    'sessionId': profile.activeDutySessionId,
    'generation': 2,
    'lifecycleSeq': ?seq,
    'state': 'ACTIVE',
    'startedAt': DateTime.utc(2026, 9, 30).toIso8601String(),
  });

  late fixtures.TestAuthService auth;
  late DutyController controller;
  late NativeReadLocationService location;
  var ownerReads = 0;

  void configure(Map<String, dynamic> fresh, List<String?> nativeReads) {
    ownerReads = 0;
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (
      call,
    ) async {
      if (call.method == 'getDurableOwner') {
        final index = ownerReads++;
        return nativeReads[index < nativeReads.length
            ? index
            : nativeReads.length - 1];
      }
      if (call.method == 'isServiceRunning') return true;
      throw StateError('Unexpected native mutation: ${call.method}');
    });
    location = NativeReadLocationService(fresh);
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(profile);
  }

  void expectUnconfirmed() {
    expect(controller.isReady, isFalse);
    expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
    expect(controller.activeSession, isNull);
    expect(controller.activeLifecycleSeq, isNull);
  }

  setUp(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    auth = fixtures.TestAuthService(fixtures.FakeUser(profile.uid));
  });

  tearDown(() {
    controller.dispose();
    auth.dispose();
    messenger.setMockMethodCallHandler(
      NativeOwnershipCoordinator.channel,
      null,
    );
    NativeOwnershipCoordinator.resetTestSimulation();
  });

  test(
    'R12: initial null then durable native L7 never adopts fresh server L1',
    () async {
      configure(server(seq: 1), [null, owner(7)]);
      await controller.reconcileDutyState();
      expect(ownerReads, 2);
      expect(
        location.durableSessions.single,
        const DutySession(
          uid: 'uid-a',
          sessionId: 'same-session',
          generation: 2,
          lifecycleSeq: 7,
        ),
      );
      expectUnconfirmed();
      expect(location.exactStops, isEmpty);
    },
  );

  test('R12: initial null then exact native/server L7 reaches READY', () async {
    configure(server(), [null, owner(7)]);
    await controller.reconcileDutyState();
    expect(ownerReads, 2);
    expect(location.durableSessions.single?.lifecycleSeq, 7);
    expect(controller.activeSession?.lifecycleSeq, 7);
    expect(controller.activeLifecycleSeq, 7);
    expect(controller.trackingHealth, TrackingHealth.healthy);
    expect(controller.isReady, isTrue);
    expect(location.exactStops, isEmpty);
  });

  for (final seq in <Object?>[null, 0, -1, '7', 7.0, true]) {
    test(
      'R12: second native read lifecycleSeq=$seq cannot prove equality',
      () async {
        configure(server(), [null, owner(seq)]);
        await controller.reconcileDutyState();
        expect(ownerReads, 2);
        expectUnconfirmed();
        expect(location.exactStops, isEmpty);
      },
    );

    test(
      'R12: valid first owner cannot hide invalid second lifecycleSeq=$seq',
      () async {
        configure(server(), [owner(7), owner(seq)]);
        await controller.reconcileDutyState();
        expect(ownerReads, 2);
        expectUnconfirmed();
        expect(location.exactStops, isEmpty);
      },
    );

    test(
      'R12: fresh server lifecycleSeq=$seq cannot prove native L7 equality',
      () async {
        configure(server(seq: seq), [null, owner(7)]);
        await controller.reconcileDutyState();
        expectUnconfirmed();
        expect(location.exactStops, isEmpty);
      },
    );
  }

  for (final ready in <Object?>[null, false, 'true', 1]) {
    test(
      'R12: exact L7 requires literal workerReady=true, received $ready',
      () async {
        configure(server(ready: ready), [null, owner(7)]);
        await controller.reconcileDutyState();
        expect(controller.isReady, isFalse);
        if (ready == null || ready == false) {
          expect(controller.activeSession?.lifecycleSeq, 7);
          expect(controller.trackingHealth, TrackingHealth.starting);
        } else {
          expectUnconfirmed();
        }
        expect(location.exactStops, isEmpty);
      },
    );
  }

  for (final seq in [6, 8]) {
    test(
      'R12: same uid/session/generation native L$seq differs from server L7',
      () async {
        configure(server(), [null, owner(seq)]);
        await controller.reconcileDutyState();
        expect(location.durableSessions.single?.lifecycleSeq, seq);
        expectUnconfirmed();
        if (seq == 8) {
          expect(location.exactStops, isEmpty);
        } else {
          expect(location.exactStops.single['lifecycleSeq'], seq);
        }
      },
    );

    test(
      'R12: native reads L7 then L$seq cannot combine epochs into READY',
      () async {
        configure(server(), [owner(7), owner(seq)]);
        await controller.reconcileDutyState();
        expect(ownerReads, 2);
        expectUnconfirmed();
        expect(location.exactStops, isEmpty);
      },
    );
  }
}
