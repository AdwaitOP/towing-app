import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'duty_controller_test.dart' as f;

const old = DutySession(
  uid: 'A',
  sessionId: 'S',
  generation: 2,
  lifecycleSeq: 7,
);
DriverProfile profile(String uid, {bool on = true}) => DriverProfile(
  uid: uid,
  name: 'Driver',
  phone: '+919876543210',
  truckType: TruckType.flatbed,
  vehicleNumber: 'MH01AB1234',
  verificationStatus: 'approved',
  isOnDuty: on,
  activeDutySessionId: on ? 'S' : null,
  dutyGeneration: 2,
  lifecycleSeq: on ? 7 : null,
  workerReady: on,
);
DurableDutyOwnerRecord owner() => DurableDutyOwnerRecord(
  uid: 'A',
  sessionId: 'S',
  generation: 2,
  lifecycleSeq: 7,
  startedAt: DateTime.utc(2026),
);

class ControlledLocation extends f.TestLocationService {
  Future<void> Function()? endHook, runningHook, transactionHook;
  final ends = <DutySession>[];
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
    await endHook?.call();
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    await runningHook?.call();
    return serviceRunning;
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    await transactionHook?.call();
  }
}

Map<String, Object?> snapshot(DutyController c) => {
  'profile': c.currentProfile,
  'profileUid': c.currentProfile?.uid,
  'duty': c.authoritativeDutyState,
  'desired': c.desiredDutyState,
  'health': c.trackingHealth,
  'ready': c.isReady,
  'loading': c.isLoading,
  'error': c.lastError,
  'errorCategory': c.errorCategory,
  'cleanup': c.isCleanupRequired,
  'active': c.activeSession,
  'pending': c.pendingCleanupSession,
  'cancellation': c.pendingCancellation,
  'logout': c.isLogoutInProgress,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late f.TestAuthService auth;
  late ControlledLocation location;
  late DutyController controller;
  setUp(() {
    auth = f.TestAuthService(f.FakeUser('A'));
    location = ControlledLocation()
      ..currentSession = old
      ..mockLifecycleSeq = 7
      ..serviceRunning = true;
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(profile('A'));
  });
  tearDown(() {
    controller.dispose();
    auth.dispose();
  });
  Future<void> selectB() async {
    auth.emitUser(f.FakeUser('B'));
    await Future<void>.delayed(Duration.zero);
    controller.updateProfile(profile('B', on: false));
  }

  for (final fail in [true, false]) {
    test(
      fail
          ? 'C1-FAIL-1 cross-UID stale owner failure is side-effect free'
          : 'C1-FAIL-4 successful stale owner read is side-effect free',
      () async {
        final entered = Completer<void>(), release = Completer<void>();
        location.durableOwnerOverride = () async {
          entered.complete();
          await release.future;
          if (fail) {
            throw PlatformException(code: 'A_OWNER_READ_FAILED');
          }
          return owner();
        };
        final operation = controller.requestGoOffDuty();
        await entered.future;
        await selectB();
        final before = snapshot(controller);
        expect(controller.trackingHealth, TrackingHealth.off);
        var notifications = 0;
        controller.addListener(() => notifications++);
        release.complete();
        expect(await operation, false);
        expect(snapshot(controller), before);
        expect(notifications, 0);
        expect(location.ends, isEmpty);
        expect(location.exactStopRequests, isEmpty);
      },
    );
  }
  test(
    'C1-FAIL-2 same-UID O1 failure cannot mutate queued winning O2',
    () async {
      final entered = Completer<void>(), release = Completer<void>();
      final nextEntered = Completer<void>(), nextRelease = Completer<void>();
      var reads = 0;
      location.durableOwnerOverride = () async {
        if (++reads == 1) {
          entered.complete();
          await release.future;
          throw PlatformException(code: 'O1_OWNER_READ_FAILED');
        }
        nextEntered.complete();
        await nextRelease.future;
        return owner();
      };
      final oldOperation = controller.requestGoOffDuty();
      await entered.future;
      final newer = controller.requestGoOffDuty();
      final before = snapshot(controller);
      var notifications = 0;
      controller.addListener(() => notifications++);
      release.complete();
      expect(await oldOperation, false);
      await nextEntered.future;
      expect(snapshot(controller), before);
      expect(notifications, 0);
      expect(controller.isLoading, true);
      expect(location.ends, isEmpty);
      expect(location.exactStopRequests, isEmpty);
      location.durableOwnerOverride = null;
      nextRelease.complete();
      expect(await newer, true);
      expect(location.ends, [old]);
      expect(location.exactStopRequests, [old]);
    },
  );
  test(
    'C1-FAIL-3 current-operation owner failure remains actionable',
    () async {
      location.durableOwnerOverride = () async {
        throw PlatformException(code: 'A_OWNER_READ_FAILED');
      };
      expect(await controller.requestGoOffDuty(), false);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.isCleanupRequired, true);
      expect(controller.lastErrorCode, 'A_OWNER_READ_FAILED');
      expect(controller.isLoading, false);
      expect(location.ends, isEmpty);
      expect(location.exactStopRequests, isEmpty);
    },
  );
  for (final boundary in ['END', 'transaction', 'running', 'STOP', 'absence']) {
    for (final fail in [true, false]) {
      test(
        'caller 1 stale $boundary continuation fail=$fail preserves B',
        () async {
          final entered = Completer<void>(), release = Completer<void>();
          Future<void> hold() async {
            entered.complete();
            await release.future;
            if (fail) {
              throw PlatformException(code: 'A_BOUNDARY_FAILED');
            }
          }

          if (boundary == 'END') {
            location.endHook = hold;
          }
          if (boundary == 'transaction') {
            location.currentSession = null;
            location.serviceRunning = false;
            controller.updateProfile(profile('A', on: false));
            location.transactionHook = hold;
          }
          if (boundary == 'running') {
            location.runningHook = hold;
          }
          if (boundary == 'STOP') {
            location.stopServiceOverride = hold;
          }
          if (boundary == 'absence') {
            var reads = 0;
            location.durableOwnerOverride = () async {
              if (++reads == 1) {
                return owner();
              }
              await hold();
              return null;
            };
          }
          final operation = controller.requestGoOffDuty();
          await entered.future;
          await selectB();
          final before = snapshot(controller);
          final ends = List<DutySession>.of(location.ends);
          final stops = List<DutySession>.of(location.exactStopRequests);
          var notifications = 0;
          controller.addListener(() => notifications++);
          release.complete();
          expect(await operation, false);
          expect(snapshot(controller), before);
          expect(notifications, 0);
          expect(location.ends, ends);
          expect(location.exactStopRequests, stops);
        },
      );
    }
  }
  test(
    'same-UID logout barrier owns stale owner failure and finalizer',
    () async {
      final entered = Completer<void>(), release = Completer<void>();
      location.durableOwnerOverride = () async {
        entered.complete();
        await release.future;
        throw PlatformException(code: 'A_OWNER_READ_FAILED');
      };
      final operation = controller.requestGoOffDuty();
      await entered.future;
      final lease = controller.beginLogoutBarrier('A');
      final before = snapshot(controller);
      release.complete();
      expect(await operation, false);
      expect(snapshot(controller), before);
      expect(controller.isLogoutInProgress, true);
      expect(location.ends, isEmpty);
      expect(location.exactStopRequests, isEmpty);
      controller.endLogoutBarrier(lease);
    },
  );
}
