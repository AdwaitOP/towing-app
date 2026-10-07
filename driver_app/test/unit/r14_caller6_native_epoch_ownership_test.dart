import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'r14_caller6_logout_ownership_test.dart' as f;

// These are permanent R14 regressions, currently red. UID and operation remain
// unchanged; an observational first reply must not authorize the newer epoch.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const original = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 2,
    lifecycleSeq: 7,
  );
  for (final replacement in [
    const DutySession(
      uid: 'uid-a',
      sessionId: 'session-a',
      generation: 3,
      lifecycleSeq: 8,
    ),
    const DutySession(
      uid: 'uid-a',
      sessionId: 'session-a',
      generation: 2,
      lifecycleSeq: 8,
    ),
    const DutySession(
      uid: 'uid-a',
      sessionId: 'session-a',
      generation: 3,
      lifecycleSeq: 1,
    ),
  ]) {
    test(
      'R14-C6-EPOCH-${replacement.generation == 2
          ? 2
          : replacement.lifecycleSeq == 1
          ? 3
          : 1} first owner reply returns replacement ${replacement.generation}/${replacement.lifecycleSeq}',
      () async {
        AppLogoutCoordinator.resetInFlightLogoutForTesting();
        final auth = f.LogoutAuth();
        final location = f.LogoutDiscoveryService()
          ..currentSession = original
          ..mockLifecycleSeq = 7
          ..serviceRunning = true
          ..heldRead = 'owner';
        addTearDown(() {
          auth.dispose();
          AppLogoutCoordinator.resetInFlightLogoutForTesting();
        });
        final coordinator = AppLogoutCoordinator(
          authService: auth,
          locationService: location,
        );
        final result = coordinator.coordinateLogout();
        await location.entered.future;
        location.currentSession = replacement;
        location.mockLifecycleSeq = replacement.lifecycleSeq;
        location.serviceRunning = true;
        location.released.complete();
        final outcome = await result;
        expect(
          location.exactStopRequests,
          isEmpty,
          reason:
              'The same logout operation must not adopt replacement epoch authority',
        );
        expect(location.currentSession, replacement);
        expect(location.serviceRunning, isTrue);
        expect(auth.signedOut, isEmpty);
        expect(outcome, LogoutResult.failedDutyTransition);
      },
    );
  }
  test(
    'R14-C6-EPOCH-4 original residual remains a legitimate exact cleanup control',
    () async {
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
      final auth = f.LogoutAuth();
      final location = f.LogoutDiscoveryService()
        ..currentSession = original
        ..mockLifecycleSeq = 7
        ..serviceRunning = true;
      addTearDown(() {
        auth.dispose();
        AppLogoutCoordinator.resetInFlightLogoutForTesting();
      });
      expect(
        await AppLogoutCoordinator(
          authService: auth,
          locationService: location,
        ).coordinateLogout(),
        LogoutResult.success,
      );
      expect(location.exactStopRequests, [original]);
      expect(location.currentSession, isNull);
      expect(location.serviceRunning, isFalse);
      expect(auth.signedOut, ['uid-a']);
    },
  );
}
