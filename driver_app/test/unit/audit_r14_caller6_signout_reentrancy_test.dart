import 'package:flutter/foundation.dart';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:flutter_test/flutter_test.dart';

import 'duty_controller_test.dart' as f;

class AuditSignOutAuth extends f.TestAuthService {
  AuditSignOutAuth() : super(f.FakeUser('uid-a'));
  final signOutUids = <String?>[];

  @override
  Future<void> signOut() async {
    signOutUids.add(mockUser?.uid);
    mockUser = null;
  }
}

class AuditSignOutLocation extends f.TestLocationService {
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => {
        'uid': uid,
        'name': 'Audit Driver',
        'phone': '+919876543210',
        'truckType': 'flatbed',
        'vehicleNumber': 'MH 12 AB 1234',
        'verificationStatus': 'approved',
        'isOnDuty': false,
      };
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('AUDIT R14 caller 6 auth replacement by clearOwnedAuthority listener before sign-out', () async {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    const a = DutySession(
      uid: 'uid-a', sessionId: 'session-a', generation: 2, lifecycleSeq: 7,
    );
    const b = DutySession(
      uid: 'uid-b', sessionId: 'session-b', generation: 3, lifecycleSeq: 8,
    );
    final auth = AuditSignOutAuth();
    final location = AuditSignOutLocation()
      ..currentSession = a
      ..mockLifecycleSeq = 7
      ..serviceRunning = true;
    final controller = DutyController(locationService: location, authService: auth);
    addTearDown(() {
      controller.dispose();
      auth.dispose();
      AppLogoutCoordinator.resetInFlightLogoutForTesting();
    });

    var notifications = 0;
    var installedReplacement = false;
    controller.addListener(() {
      notifications++;
      // Real DutyController emits at beginLogoutBarrier, successful
      // prepareForSignOut, then clearOwnedAuthority. The third notification
      // is synchronous, between AppLogoutCoordinator's final ownership
      // check and its invocation of AuthService.signOut.
      if (notifications == 3) {
        auth.mockUser = f.FakeUser(b.uid);
        location
          ..currentSession = b
          ..mockLifecycleSeq = b.lifecycleSeq
          ..serviceRunning = true;
        installedReplacement = true;
      }
    });

    final result = await AppLogoutCoordinator(
      authService: auth,
      locationService: location,
      dutyController: controller,
    ).coordinateLogout();

    // Keep the observation in fresh audit output even when the first
    // required safety assertion fails.
    debugPrint('AUDIT_R14_C6_BEFORE_SIGNOUT result=$result '
        'replacementInstalled=$installedReplacement '
        'notifications=$notifications signOutUids=${auth.signOutUids} '
        'nativeOwner=${location.currentSession?.uid} '
        'nativeSession=${location.currentSession?.sessionId} '
        'nativeWorker=${location.serviceRunning} '
        'stopUids=${location.exactStopRequests.map((s) => s.uid).toList()}');

    expect(installedReplacement, isTrue);
    expect(location.exactStopRequests, [a]);
    expect(location.currentSession, b);
    expect(location.serviceRunning, isTrue);
    expect(auth.signOutUids, isEmpty, reason: 'Stale A must not sign out replacement B');
    expect(auth.currentUser?.uid, b.uid);
    expect(result, LogoutResult.failedDutyTransition);
  });
}
