import 'dart:async';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'duty_controller_test.dart' as f;
import 'r14_startup_stale_continuation_test.dart' as startup;
import 'r14_caller1_stale_failure_isolation_test.dart' as snapshots;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late f.TestAuthService auth;
  late startup.StartupLocation location;
  late DutyController controller;
  late Completer<void> entered, release;
  setUp(() {
    auth = f.TestAuthService(f.FakeUser('A'));
    location = startup.StartupLocation()
      ..nextPreparedSessionId = 'S1'
      ..nextPreparedGeneration = 7
      ..nextPreparedAttemptSeq = 3
      ..mockLifecycleSeq = 11
      ..startError = PlatformException(code: 'STARTUP_A');
    location.currentPos = DriverPosition(
      latitude: 19,
      longitude: 73,
      timestamp: DateTime.utc(2026),
    );
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(snapshots.profile('A', on: false));
    entered = Completer<void>();
    release = Completer<void>();
  });
  tearDown(() {
    controller.dispose();
    auth.dispose();
  });
  Future<bool> start({bool fail = true}) {
    var count = 0;
    location.stopServiceOverride = () async {
      if (++count == 1) {
        entered.complete();
        await release.future;
        if (fail) throw PlatformException(code: 'STOP_OLD');
      }
    };
    return controller.requestGoOnDuty(onShowDisclosure: () async => true);
  }

  Future<void> selectB() async {
    auth.emitUser(f.FakeUser('B'));
    await Future<void>.delayed(Duration.zero);
    controller.updateProfile(snapshots.profile('B', on: false));
  }

  void exactDebt() {
    expect(controller.deferredCompensation.single.session, startup.exact);
    expect(controller.deferredCompensation.single.source.uid, 'A');
    final cancel = location.cancelActivationCalls.single;
    expect(cancel, containsPair('generation', 7));
    expect(cancel, containsPair('lifecycleSeq', 11));
    expect(cancel, containsPair('attemptSeq', 3));
  }

  test(
    'HANDOFF-1 logout accepts exact predecessor debt, never startup state',
    () async {
      final old = start();
      await entered.future;
      final lease = controller.beginLogoutBarrier('A');
      final before = startup.state(controller);
      release.complete();
      expect(await old, false);
      expect(controller.pendingCleanupSession, startup.exact);
      expect(controller.isCleanupRequired, true);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.startupErrorCode, isNull);
      expect(controller.cleanupErrorCode, 'STOP_OLD');
      expect(controller.deferredCompensation, isEmpty);
      for (final field in [
        'profile',
        'desired',
        'loading',
        'active',
        'ready',
        'logout',
        'duty',
      ]) {
        expect(startup.state(controller)[field], before[field], reason: field);
      }
      expect(location.exactStopRequests, [startup.exact]);
      controller.endLogoutBarrier(lease);
      expect(await controller.retryCleanup(), true);
      expect(controller.pendingCleanupSession, isNull);
      expect(controller.isCleanupRequired, false);
    },
  );

  test(
    'HANDOFF-2 verified success transfers no debt and preserves receiver',
    () async {
      final old = start(fail: false);
      await entered.future;
      final lease = controller.beginLogoutBarrier('A');
      final before = startup.state(controller);
      release.complete();
      expect(await old, false);
      expect(startup.state(controller), before);
      expect(controller.deferredCompensation, isEmpty);
      expect(controller.pendingCleanupSession, isNull);
      expect(controller.lastError, isNull);
      expect(location.serviceRunning, false);
      controller.endLogoutBarrier(lease);
    },
  );

  test(
    'HANDOFF-3 current cleanup owner debt cannot be overwritten even for same tuple',
    () async {
      final handoffEntered = Completer<void>(),
          handoffRelease = Completer<void>();
      controller.beforeCompensationHandoff = () async {
        handoffEntered.complete();
        await handoffRelease.future;
      };
      final old = start();
      await entered.future;
      final lease = controller.beginLogoutBarrier('A');
      release.complete();
      await handoffEntered.future;
      exactDebt();
      // An explicit current-owner retry creates a newer canonical record while
      // predecessor acceptance is held. Equal tuples do not grant overwrite rights.
      location.stopServiceOverride = () async =>
          throw PlatformException(code: 'STOP_NEW');
      expect(await controller.retryCleanup(), false);
      final newerPending = controller.pendingCleanupSession;
      final newerState = startup.state(controller);
      expect(controller.cleanupErrorCode, 'STOP_NEW');
      handoffRelease.complete();
      expect(await old, false);
      expect(startup.state(controller), newerState);
      expect(identical(controller.pendingCleanupSession, newerPending), true);
      controller.endLogoutBarrier(lease);
    },
  );

  test(
    'HANDOFF-4 A debt stays separate from B and retries only after A owns cleanup',
    () async {
      final old = start();
      await entered.future;
      await selectB();
      final before = startup.state(controller);
      release.complete();
      expect(await old, false);
      expect(startup.state(controller), before);
      exactDebt();
      final stops = location.exactStopRequests.length;
      expect(await controller.retryCleanup(), true);
      expect(location.exactStopRequests.length, stops);
      expect(startup.state(controller), before);
      expect(controller.deferredCompensation, hasLength(1));
      auth.emitUser(f.FakeUser('A'));
      await Future<void>.delayed(Duration.zero);
      controller.updateProfile(snapshots.profile('A', on: false));
      expect(await controller.retryCleanup(), true);
      expect(controller.deferredCompensation, isEmpty);
      expect(location.exactStopRequests.every((s) => s == startup.exact), true);
      expect(controller.lastError, isNull);
    },
  );

  test(
    'HANDOFF-5 same UID newer operation retains presentation and winning ownership',
    () async {
      final nextEntered = Completer<void>(), nextRelease = Completer<void>();
      location.endHook = () async {
        nextEntered.complete();
        await nextRelease.future;
      };
      final old = start();
      await entered.future;
      final newer = controller.requestGoOffDuty();
      final before = startup.state(controller);
      release.complete();
      expect(await old, false);
      await nextEntered.future;
      expect(startup.state(controller), before);
      exactDebt();
      nextRelease.complete();
      expect(await newer, true);
      expect(await controller.retryCleanup(), true);
      expect(controller.deferredCompensation, isEmpty);
      expect(location.exactStopRequests, [
        startup.exact,
        startup.exact,
        startup.exact,
      ]);
    },
  );

  test(
    'HANDOFF-6 receiver replaced during acceptance cannot acquire predecessor debt',
    () async {
      final handoffEntered = Completer<void>(),
          handoffRelease = Completer<void>();
      controller.beforeCompensationHandoff = () async {
        handoffEntered.complete();
        await handoffRelease.future;
      };
      final old = start();
      await entered.future;
      final first = controller.beginLogoutBarrier('A');
      release.complete();
      await handoffEntered.future;
      final second = controller.beginLogoutBarrier('A');
      final before = startup.state(controller);
      handoffRelease.complete();
      expect(await old, false);
      expect(startup.state(controller), before);
      exactDebt();
      controller.endLogoutBarrier(first);
      expect(controller.isLogoutInProgress, true);
      controller.endLogoutBarrier(second);
      expect(await controller.retryCleanup(), true);
      expect(controller.deferredCompensation, isEmpty);
    },
  );
  test(
    'cancellation-only debt retains A exact epoch and attempt through deferred retry',
    () async {
      final cancelEntered = Completer<void>(),
          cancelRelease = Completer<void>();
      location.cancelHook = () async {
        cancelEntered.complete();
        await cancelRelease.future;
        throw PlatformException(code: 'CANCEL_OLD');
      };
      final old = start(fail: false);
      await entered.future;
      release.complete();
      await cancelEntered.future;
      await selectB();
      final before = startup.state(controller);
      cancelRelease.complete();
      expect(await old, false);
      expect(startup.state(controller), before);
      final debt = controller.deferredCompensation.single;
      expect(debt.stopSucceeded, true);
      expect(debt.nativeAbsenceProven, true);
      expect(debt.cancellationSucceeded, false);
      expect(debt.cancellation!.uid, 'A');
      expect(debt.cancellation!.generation, 7);
      expect(debt.cancellation!.lifecycleSeq, 11);
      expect(debt.cancellation!.attemptSeq, 3);
      auth.emitUser(f.FakeUser('A'));
      await Future<void>.delayed(Duration.zero);
      controller.updateProfile(snapshots.profile('A', on: false));
      location.cancelHook = null;
      expect(await controller.retryCleanup(), true);
      expect(controller.deferredCompensation, isEmpty);
      expect(location.cancelActivationCalls.single, containsPair('uid', 'A'));
      expect(
        location.cancelActivationCalls.single,
        containsPair('generation', 7),
      );
      expect(
        location.cancelActivationCalls.single,
        containsPair('lifecycleSeq', 11),
      );
      expect(
        location.cancelActivationCalls.single,
        containsPair('attemptSeq', 3),
      );
      expect(controller.lastError, isNull);
    },
  );
}
