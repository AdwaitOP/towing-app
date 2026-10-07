import 'dart:async';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:driver_app/features/hub/models/hub_error_category.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'duty_controller_test.dart' as f;
import 'r14_caller1_stale_failure_isolation_test.dart' as snapshots;

const exact = DutySession(
  uid: 'A',
  sessionId: 'S1',
  generation: 7,
  lifecycleSeq: 11,
);

class StartupLocation extends f.TestLocationService {
  Future<void> Function()? cancelHook, endHook, earlyHook, activationHook;
  Future<void> Function(String boundary)? boundaryHook;
  Object? startError;
  bool startReturnsFalse = false;
  final ends = <DutySession>[];
  @override
  Future<LocationPermissionStatus> checkPermission() async {
    await boundaryHook?.call('checkPermission');
    return checkPermResult;
  }

  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async {
    await boundaryHook?.call('foreground');
    return reqForegroundResult;
  }

  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async {
    await boundaryHook?.call('background');
    return reqBackgroundResult;
  }

  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async {
    await boundaryHook?.call('notification');
    return reqNotificationResult;
  }

  @override
  Future<DriverPosition?> getCurrentPosition() async {
    await boundaryHook?.call('GPS');
    return currentPos;
  }

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    await boundaryHook?.call('preparation');
    return super.prepareDutyActivation(
      uid: uid,
      clientRequestId: clientRequestId,
    );
  }

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    final allocated = session.copyWith(lifecycleSeq: 11);
    onAuthorityAllocated?.call(allocated);
    currentSession = allocated;
    serviceRunning = true;
    if (startError != null) {
      throw startError!;
    }
    return !startReturnsFalse;
  }

  @override
  Future<bool> isLocationServiceEnabled() async {
    await earlyHook?.call();
    return serviceEnabled;
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    await cancelHook?.call();
    await super.cancelDutyActivationCall(
      uid: uid,
      sessionId: sessionId,
      generation: generation,
      lifecycleSeq: lifecycleSeq,
      attemptSeq: attemptSeq,
    );
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
    await endHook?.call();
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
    await activationHook?.call();
    return super.startDutySessionCall(
      uid: uid,
      sessionId: sessionId,
      initialLocation: initialLocation,
      lifecycleSeq: lifecycleSeq,
      generation: generation,
      attemptSeq: attemptSeq,
    );
  }
}

Map<String, Object?> state(DutyController c) => {
  ...snapshots.snapshot(c),
  'message': c.lastErrorMessage,
  'startupError': c.startupErrorCode,
  'startupMessage': c.startupErrorMessage,
  'cleanupError': c.cleanupErrorCode,
  'cleanupMessage': c.cleanupErrorMessage,
  'reconciling': c.isReconciling,
};
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late f.TestAuthService auth;
  late StartupLocation location;
  late DutyController controller;
  setUp(() {
    auth = f.TestAuthService(f.FakeUser('A'));
    location = StartupLocation()
      ..nextPreparedSessionId = 'S1'
      ..nextPreparedGeneration = 7
      ..nextPreparedAttemptSeq = 3
      ..mockLifecycleSeq = 11
      ..currentPos = DriverPosition(
        latitude: 19,
        longitude: 73,
        timestamp: DateTime.utc(2026),
      );
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(snapshots.profile('A', on: false));
  });
  tearDown(() {
    controller.dispose();
    auth.dispose();
  });
  Future<void> selectB() async {
    auth.emitUser(f.FakeUser('B'));
    await Future<void>.delayed(Duration.zero);
    controller.updateProfile(snapshots.profile('B', on: false));
  }

  Future<bool> goOn() =>
      controller.requestGoOnDuty(onShowDisclosure: () async => true);
  for (final fail in [true, false]) {
    test(
      'startup compensation STOP fail=$fail cannot mutate clean B',
      () async {
        location.startError = PlatformException(code: 'STARTUP_A');
        final entered = Completer<void>(), release = Completer<void>();
        var stops = 0;
        location.stopServiceOverride = () async {
          if (++stops == 1) {
            entered.complete();
            await release.future;
            if (fail) {
              throw PlatformException(code: 'STOP_A');
            }
          }
        };
        final old = goOn();
        await entered.future;
        await selectB();
        final before = state(controller);
        expect(controller.trackingHealth, TrackingHealth.off);
        expect(controller.lastError, isNull);
        expect(controller.isCleanupRequired, false);
        var notifications = 0;
        controller.addListener(() => notifications++);
        release.complete();
        expect(await old, false);
        expect(state(controller), before);
        expect(notifications, 0);
        expect(location.exactStopRequests, [exact, exact]);
        expect(location.ends, isEmpty);
        expect(location.cancelActivationCalls.single, containsPair('uid', 'A'));
        expect(
          location.cancelActivationCalls.single,
          containsPair('generation', 7),
        );
        expect(
          location.cancelActivationCalls.single,
          containsPair('lifecycleSeq', 11),
        );
      },
    );
  }
  test(
    'current STARTUP_A plus STOP_A remains truthful and actionable',
    () async {
      location.startError = PlatformException(code: 'STARTUP_A');
      location.stopServiceOverride = () async {
        throw PlatformException(code: 'STOP_A');
      };
      expect(await goOn(), false);
      expect(controller.lastErrorCode, 'STARTUP_A');
      expect(controller.startupErrorCode, 'STARTUP_A');
      expect(controller.cleanupErrorCode, 'STOP_A');
      expect(controller.errorCategory, HubErrorCategory.serviceStartupFailed);
      expect(controller.isCleanupRequired, true);
      expect(controller.isLoading, false);
      expect(controller.pendingCleanupSession, exact);
      expect(location.exactStopRequests, [exact]);
    },
  );
  test(
    'same UID O2 survives stale compensation failure and finalizer',
    () async {
      location.startError = PlatformException(code: 'STARTUP_A');
      final entered = Completer<void>(), release = Completer<void>();
      final nextEntered = Completer<void>(), nextRelease = Completer<void>();
      var stops = 0;
      location.stopServiceOverride = () async {
        if (++stops == 1) {
          entered.complete();
          await release.future;
          throw PlatformException(code: 'STOP_A');
        }
      };
      location.endHook = () async {
        nextEntered.complete();
        await nextRelease.future;
      };
      final old = goOn();
      await entered.future;
      final newer = controller.requestGoOffDuty();
      final before = state(controller);
      var notifications = 0;
      controller.addListener(() => notifications++);
      release.complete();
      expect(await old, false);
      await nextEntered.future;
      expect(state(controller), before);
      expect(notifications, 0);
      expect(controller.isLoading, true);
      expect(controller.pendingCleanupSession, isNull);
      expect(controller.pendingCancellation, isNull);
      nextRelease.complete();
      expect(await newer, true);
      expect(location.exactStopRequests, [exact, exact]);
    },
  );
  for (final fail in [true, false]) {
    test(
      'replacement during compensation second await CANCEL fail=$fail is isolated',
      () async {
        location.startError = PlatformException(code: 'STARTUP_A');
        final entered = Completer<void>(), release = Completer<void>();
        location.cancelHook = () async {
          entered.complete();
          await release.future;
          if (fail) {
            throw PlatformException(code: 'CANCEL_A');
          }
        };
        final old = goOn();
        await entered.future;
        await selectB();
        final before = state(controller);
        release.complete();
        expect(await old, false);
        expect(state(controller), before);
        expect(controller.pendingCancellation, isNull);
        expect(location.exactStopRequests.every((s) => s == exact), true);
      },
    );
  }
  for (final fail in [true, false]) {
    test(
      'early service await fail=$fail and outer catch cannot mutate B',
      () async {
        final entered = Completer<void>(), release = Completer<void>();
        location.earlyHook = () async {
          entered.complete();
          await release.future;
          if (fail) {
            throw PlatformException(code: 'STARTUP_EARLY_A');
          }
        };
        location.serviceEnabled = false;
        final old = goOn();
        await entered.future;
        await selectB();
        final before = state(controller);
        release.complete();
        expect(await old, false);
        expect(state(controller), before);
        expect(location.exactStopRequests, isEmpty);
        expect(location.cancelActivationCalls, isEmpty);
      },
    );
  }
  test(
    'stale server activation failure and its cleanup cannot publish errors into B',
    () async {
      final entered = Completer<void>(), release = Completer<void>();
      location.activationHook = () async {
        entered.complete();
        await release.future;
        throw PlatformException(code: 'ACTIVATION_A');
      };
      final old = goOn();
      await entered.future;
      await selectB();
      final before = state(controller);
      release.complete();
      expect(await old, false);
      expect(state(controller), before);
      expect(location.exactStopRequests.every((s) => s == exact), true);
    },
  );
  test(
    'stale failed START result cannot publish compensation failure into B',
    () async {
      location.startReturnsFalse = true;
      final entered = Completer<void>(), release = Completer<void>();
      var stops = 0;
      location.stopServiceOverride = () async {
        if (++stops == 1) {
          entered.complete();
          await release.future;
          throw PlatformException(code: 'STOP_A');
        }
      };
      final old = goOn();
      await entered.future;
      await selectB();
      final before = state(controller);
      release.complete();
      expect(await old, false);
      expect(state(controller), before);
    },
  );
  for (final boundary in [
    'checkPermission',
    'foreground',
    'background',
    'notification',
    'GPS',
    'preparation',
  ]) {
    for (final fail in [true, false]) {
      test(
        'go-on $boundary fail=$fail continuation preserves replacement B',
        () async {
          final entered = Completer<void>(), release = Completer<void>();
          if (boundary == 'foreground') {
            location.checkPermResult = LocationPermissionStatus.denied;
          }
          location.boundaryHook = (kind) async {
            if (kind != boundary) return;
            entered.complete();
            await release.future;
            if (fail) {
              throw PlatformException(code: 'STARTUP_BOUNDARY_A');
            }
          };
          final old = goOn();
          await entered.future;
          await selectB();
          final before = state(controller);
          release.complete();
          expect(await old, false);
          expect(state(controller), before);
          expect(location.exactStopRequests, isEmpty);
          if (boundary == 'preparation' && !fail) {
            expect(
              location.cancelActivationCalls.single,
              containsPair('uid', 'A'),
            );
            expect(
              location.cancelActivationCalls.single,
              containsPair('generation', 7),
            );
          } else {
            expect(location.cancelActivationCalls, isEmpty);
          }
        },
      );
    }
  }
  for (final fail in [true, false]) {
    test('disclosure fail=$fail completion cannot mutate B', () async {
      final entered = Completer<void>(), release = Completer<void>();
      final old = controller.requestGoOnDuty(
        onShowDisclosure: () async {
          entered.complete();
          await release.future;
          if (fail) {
            throw PlatformException(code: 'DISCLOSURE_A');
          }
          return false;
        },
      );
      await entered.future;
      await selectB();
      final before = state(controller);
      release.complete();
      expect(await old, false);
      expect(state(controller), before);
      expect(location.exactStopRequests, isEmpty);
    });
  }
}
