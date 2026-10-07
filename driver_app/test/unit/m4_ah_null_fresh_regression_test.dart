import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:flutter_test/flutter_test.dart';

import 'duty_controller_test.dart' as f;
import 'milestone4_acceptance_test.dart' as m4;

void main() {
  const uid = 'm4_ah_driver';
  const base = DriverProfile(
    uid: uid,
    name: 'Driver',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 AB 1234',
    verificationStatus: 'approved',
  );

  Map<String, dynamic> doc(DriverProfile p) => {
        'uid': p.uid,
        'name': p.name,
        'phone': p.phone,
        'truckType': p.truckType.backendValue,
        'vehicleNumber': p.vehicleNumber,
        'verificationStatus': p.verificationStatus,
        'isOnDuty': p.isOnDuty,
        'activeDutySessionId': p.activeDutySessionId,
        'dutyGeneration': p.dutyGeneration,
        'lifecycleSeq': p.lifecycleSeq,
        'workerReady': p.workerReady,
      };

  DriverProfile on({int generation = 1, int seq = 1, bool ready = true}) =>
      base.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'session',
        dutyGeneration: generation,
        lifecycleSeq: seq,
        workerReady: ready,
      );

  m4.M4AcceptanceLocationService worker({int generation = 2, int seq = 2}) {
    final loc = m4.M4AcceptanceLocationService();
    loc.serviceRunning = true;
    loc.mockLifecycleSeq = seq;
    loc.durableOwnerRecord = DurableDutyOwnerRecord(
      uid: uid,
      sessionId: 'session',
      generation: generation,
      lifecycleSeq: seq,
      startedAt: DateTime.now(),
    );
    return loc;
  }

  DutyController controller(m4.M4AcceptanceLocationService loc, DriverProfile cached) {
    final c = DutyController(locationService: loc, authService: m4.M4AcceptanceAuthService(f.FakeUser(uid)));
    c.updateProfile(cached);
    return c;
  }

  void unresolved(DutyController c, m4.M4AcceptanceLocationService loc) {
    expect(loc.stopCalls, isEmpty);
    expect(loc.serviceRunning, isTrue);
    expect(c.isReady, isFalse);
    expect(c.authoritativeDutyState, AuthoritativeDutyState.unknown);
    expect(c.trackingHealth, TrackingHealth.reconciliationFailed);
    expect(c.canToggleDuty, isFalse);
  }

  test('A/H-1 cached OFF G1/L1, native G2/L2, fresh null remains unresolved', () async {
    final loc = worker();
    final c = controller(loc, base.copyWith(activeDutySessionId: 'session', dutyGeneration: 1, lifecycleSeq: 1));
    await c.reconcileDutyState();
    unresolved(c, loc);
  });

  test('A/H-2 cached ON ready and exact native cannot establish READY with fresh null', () async {
    final loc = worker();
    final c = controller(loc, on(generation: 2, seq: 2));
    await c.reconcileDutyState();
    unresolved(c, loc);
    expect(c.activeSession, isNull);
  });

  test('A/H-3 thrown fresh read cannot authorize cached OFF stop', () async {
    final loc = worker();
    loc.throwOnFetchServerState = true;
    final c = controller(loc, base);
    await c.reconcileDutyState();
    unresolved(c, loc);
  });

  test('A/H-4 wrong UID and malformed fresh identity fail closed', () async {
    for (final bad in [
      {...doc(on()), 'uid': 'another_driver'},
      {...doc(on()), 'activeDutySessionId': ' '},
      {...doc(on()), 'dutyGeneration': 'bad'},
      {...doc(on()), 'lifecycleSeq': -1},
    ]) {
      final loc = worker();
      loc.serverDriverState = bad;
      final c = controller(loc, base);
      await c.reconcileDutyState();
      unresolved(c, loc);
    }
  });

  test('A/H-5 valid fresh OFF cleans exact residual worker', () async {
    final loc = worker();
    loc.serverDriverState = doc(base);
    final c = controller(loc, base);
    await c.reconcileDutyState();
    expect(loc.stopCalls, hasLength(1));
    expect(loc.stopCalls.single['expectedGeneration'], 2);
    expect(loc.stopCalls.single['expectedLifecycleSeq'], 2);
    expect(loc.serviceRunning, isFalse);
    expect(c.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(c.trackingHealth, TrackingHealth.off);
  });

  test('A/H-6 valid fresh OFF and absent native establishes clean OFF', () async {
    final loc = m4.M4AcceptanceLocationService()..serverDriverState = doc(base);
    final c = controller(loc, base);
    await c.reconcileDutyState();
    expect(c.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(c.trackingHealth, TrackingHealth.off);
    expect(loc.stopCalls, isEmpty);
  });

  test('A/H-7 valid fresh ON exact native progresses STARTING to READY', () async {
    final loc = worker();
    loc.serverDriverState = doc(on(generation: 2, seq: 2, ready: false));
    final c = controller(loc, on(generation: 1, seq: 1));
    await c.reconcileDutyState();
    expect(c.trackingHealth, TrackingHealth.starting);
    expect(c.isReady, isFalse);
    loc.serverDriverState = doc(on(generation: 2, seq: 2));
    await c.reconcileDutyState();
    expect(c.trackingHealth, TrackingHealth.healthy);
    expect(c.isReady, isTrue);
    expect(loc.stopCalls, isEmpty);
  });

  test('A/H-8 fresh L1 cannot stop newer native L2', () async {
    final loc = worker();
    loc.serverDriverState = doc(on());
    final c = controller(loc, on());
    await c.reconcileDutyState();
    expect(c.isReady, isFalse);
    expect(c.trackingHealth, TrackingHealth.reconciliationFailed);
    expect(loc.stopCalls, isEmpty);
    expect(loc.serviceRunning, isTrue);
  });

  test('A/H-9 cached callbacks cannot heal null or thrown fresh failures', () async {
    for (final throws in [false, true]) {
      final loc = worker();
      loc.throwOnFetchServerState = throws;
      final c = controller(loc, base);
      await c.reconcileDutyState();
      c.updateProfile(base);
      c.updateProfile(on(generation: 2, seq: 2));
      unresolved(c, loc);
    }
  });

  test('A/H-10 missing fresh isOnDuty cannot authorize a native stop', () async {
    final loc = worker();
    loc.serverDriverState = doc(on(generation: 2, seq: 2))..remove('isOnDuty');
    final c = controller(loc, base);
    await c.reconcileDutyState();
    unresolved(c, loc);
    expect(c.activeSession, isNull);
  });

  test('A/H-11 null fresh isOnDuty cannot authorize a native stop', () async {
    final loc = worker();
    loc.serverDriverState = {...doc(on(generation: 2, seq: 2)), 'isOnDuty': null};
    final c = controller(loc, base);
    await c.reconcileDutyState();
    unresolved(c, loc);
  });

  test('A/H-12 string false fresh isOnDuty cannot authorize a native stop', () async {
    final loc = worker();
    loc.serverDriverState = {...doc(on(generation: 2, seq: 2)), 'isOnDuty': 'false'};
    final c = controller(loc, base);
    await c.reconcileDutyState();
    unresolved(c, loc);
  });

  test('A/H-12 integer zero fresh isOnDuty cannot authorize a native stop', () async {
    final loc = worker();
    loc.serverDriverState = {...doc(on(generation: 2, seq: 2)), 'isOnDuty': 0};
    final c = controller(loc, base);
    await c.reconcileDutyState();
    unresolved(c, loc);
  });
}
