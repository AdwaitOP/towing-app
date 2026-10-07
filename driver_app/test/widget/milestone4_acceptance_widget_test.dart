import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:driver_app/features/hub/screens/dispatch_hub_screen.dart';
import 'package:driver_app/l10n/app_localizations.dart';

import 'test_helper.dart';
import '../unit/duty_controller_test.dart' as duty_fakes;
import '../unit/milestone4_acceptance_test.dart' as m4_fakes;

class WidgetTestAuthService extends AuthService {
  bool signOutCalled = false;
  final StreamController<User?> _authController = StreamController<User?>.broadcast();

  @override
  User? get currentUser => null;

  @override
  Stream<User?> get authStateChanges => _authController.stream;

  @override
  Future<void> signOut() async {
    signOutCalled = true;
  }
}

class WidgetTestLocationService implements LocationService {
  final StreamController<DriverPosition> _posController = StreamController<DriverPosition>.broadcast();
  DutySession? currentSession;

  @override
  DutySession? get currentServiceSession => currentSession;
  @override
  int? get currentLifecycleSeq => null;
  @override
  int? get currentGeneration => null;
  @override
  Future<DutySession?> getDurableSession() async => currentSession;
  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async => null;
  @override
  Future<bool> isForegroundServiceRunning() async => currentSession != null;
  @override
  Future<bool> isLocationServiceEnabled() async => true;
  @override
  Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async => LocationPermissionStatus.granted;
  @override
  Future<bool> hasRequiredPermissions() async => true;
  @override
  Future<DriverPosition?> getCurrentPosition() async => null;
  @override
  Stream<DriverPosition> getPositionStream() => _posController.stream;
  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    onAuthorityAllocated?.call(session);
    currentSession = session;
    return true;
  }
  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    currentSession = null;
  }
  @override
  DriverPosition? get lastKnownPosition => null;
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => null;
  @override
  Future<void> sendHeartbeat({required String uid, required DriverPosition position}) async {}
  @override
  Future<void> executeGoOnDutyTransaction({required String uid}) async {}
  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {}
  @override
  Future<DutyActivationPreparation> prepareDutyActivation({required String uid, String? clientRequestId}) async =>
      DutyActivationPreparation(sessionId: '${uid}_test', generation: 1);
  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async =>
      {'status': 'activated', 'dutyGeneration': 1, 'lifecycleSeq': 1, 'workerReady': true};
  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {}
  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {}
  @override
  Future<void> reportHeartbeatCall({
    required String uid,
    required String sessionId,
    required DriverPosition position,
    int? generation,
    int? lifecycleSeq,
  }) async {}
  @override
  Future<Map<String, dynamic>> recoverActiveJobSessionCall({
    required String uid,
    required String activeDutySessionId,
    required int dutyGeneration,
    required int lifecycleSeq,
    required String expectedActiveJobId,
    String? clientRequestId,
    DriverPosition? initialLocation,
  }) async =>
      {};
  @override
  Future<bool> openAppSettings() async => true;
  @override
  void dispose() {
    _posController.close();
  }
}

class TestableDutyController extends DutyController {
  bool retryCleanupCalled = false;

  AuthoritativeDutyState? overrideAuthoritative;
  TrackingHealth? overrideTrackingHealth;
  bool? overrideCleanupRequired;
  bool? overrideReconciling;
  bool? overrideLoading;
  bool? overrideLogoutInProgress;
  bool? overrideCanToggle;

  TestableDutyController({
    required super.locationService,
    required super.authService,
  });

  @override
  AuthoritativeDutyState get authoritativeDutyState =>
      overrideAuthoritative ?? super.authoritativeDutyState;

  @override
  TrackingHealth get trackingHealth =>
      overrideTrackingHealth ?? super.trackingHealth;

  @override
  bool get isCleanupRequired =>
      overrideCleanupRequired ?? super.isCleanupRequired;

  @override
  bool get isReconciling =>
      overrideReconciling ?? super.isReconciling;

  @override
  bool get isLoading =>
      overrideLoading ?? super.isLoading;

  @override
  bool get isLogoutInProgress =>
      overrideLogoutInProgress ?? super.isLogoutInProgress;

  @override
  bool get canToggleDuty =>
      overrideCanToggle ?? super.canToggleDuty;

  @override
  bool get isReady =>
      (overrideAuthoritative ?? super.authoritativeDutyState) == AuthoritativeDutyState.onDuty &&
      (overrideTrackingHealth ?? super.trackingHealth) == TrackingHealth.healthy;

  @override
  bool get isOnDuty =>
      (overrideAuthoritative ?? super.authoritativeDutyState) == AuthoritativeDutyState.onDuty;

  @override
  Future<bool> retryCleanup() async {
    retryCleanupCalled = true;
    return true;
  }

  void notify() => notifyListeners();
}

void main() {
  const testProfile = DriverProfile(
    uid: 'm4_driver_widget_1',
    name: 'M4 Verification Driver',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 CD 5678',
    verificationStatus: 'approved',
    isOnDuty: false,
  );

  group('Milestone 4 Duty UI & Presentation States', () {
    testWidgets('State 1: OFF DUTY renders grey status, offDuty subtitle, and enabled Go On Duty toggle', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);
      controller.updateProfile(testProfile.copyWith(isOnDuty: false));

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile,
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;

      expect(find.byKey(const ValueKey('duty_status_card')), findsOneWidget);
      expect(find.text(l10n.offDuty), findsOneWidget);
      expect(find.text(l10n.hubStatusOffDuty), findsOneWidget);

      final button = tester.widget<ElevatedButton>(find.byKey(const ValueKey('duty_toggle_button')));
      expect(button.onPressed, isNotNull);
      expect(find.text(l10n.goOnDuty), findsOneWidget);
    });

    testWidgets('State 2: ON DUTY (STARTING) renders amber status and dutyTransitionInProgress subtitle', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);
      controller.updateProfile(testProfile.copyWith(isOnDuty: true));
      controller.overrideAuthoritative = AuthoritativeDutyState.onDuty;
      controller.overrideTrackingHealth = TrackingHealth.starting;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile.copyWith(isOnDuty: true),
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;

      expect(find.text(l10n.onDuty), findsOneWidget);
      expect(find.text(l10n.dutyTransitionInProgress), findsOneWidget);
    });

    testWidgets('State 3: ON DUTY (READY) renders green status, hubStatusOnDuty subtitle, and Go Off Duty toggle', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);
      controller.updateProfile(testProfile.copyWith(isOnDuty: true, workerReady: true));
      controller.overrideAuthoritative = AuthoritativeDutyState.onDuty;
      controller.overrideTrackingHealth = TrackingHealth.healthy;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile.copyWith(isOnDuty: true, workerReady: true),
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;

      expect(find.text(l10n.onDuty), findsOneWidget);
      expect(find.text(l10n.hubStatusOnDuty), findsOneWidget);

      final button = tester.widget<ElevatedButton>(find.byKey(const ValueKey('duty_toggle_button')));
      expect(button.onPressed, isNotNull);
      expect(find.text(l10n.goOffDuty), findsOneWidget);
    });

    testWidgets('State 4: RECONCILING / UNKNOWN renders amber status and disables toggle button', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);
      controller.overrideAuthoritative = AuthoritativeDutyState.unknown;
      controller.overrideReconciling = true;
      controller.overrideCanToggle = false;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile,
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;

      expect(find.text(l10n.dutyAttentionRequired), findsOneWidget);
      expect(find.text(l10n.dutyTransitionInProgress), findsOneWidget);

      final button = tester.widget<ElevatedButton>(find.byKey(const ValueKey('duty_toggle_button')));
      expect(button.onPressed, isNull);
    });

    testWidgets('State 5: CLEANUP REQUIRED renders red status, retry button, disables toggle button, and clicking retry triggers controller', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);
      controller.updateProfile(testProfile.copyWith(isOnDuty: false));
      controller.overrideAuthoritative = AuthoritativeDutyState.offDuty;
      controller.overrideTrackingHealth = TrackingHealth.reconciliationFailed;
      controller.overrideCleanupRequired = true;
      controller.overrideCanToggle = false;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile,
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;

      expect(find.text(l10n.dutyAttentionRequired), findsOneWidget);
      expect(find.text('Cleanup required'), findsOneWidget);

      // Retry button is present and clickable
      final retryFinder = find.byKey(const ValueKey('retry_cleanup_button'));
      expect(retryFinder, findsOneWidget);

      // Duty toggle button is disabled
      final toggleButton = tester.widget<ElevatedButton>(find.byKey(const ValueKey('duty_toggle_button')));
      expect(toggleButton.onPressed, isNull);

      // Tap retry button
      await tester.tap(retryFinder);
      await tester.pump();

      expect(controller.retryCleanupCalled, isTrue);
    });

    testWidgets('Duty toggle button is disabled when isLoading or isLogoutInProgress', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);
      controller.updateProfile(testProfile.copyWith(isOnDuty: false));

      // Test isLoading disables button
      controller.overrideLoading = true;
      controller.overrideCanToggle = false;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile,
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      var button = tester.widget<ElevatedButton>(find.byKey(const ValueKey('duty_toggle_button')));
      expect(button.onPressed, isNull);

      // Test isLogoutInProgress disables button
      controller.overrideLoading = false;
      controller.overrideLogoutInProgress = true;
      controller.overrideCanToggle = false;
      controller.notify();

      await tester.pumpAndSettle();

      button = tester.widget<ElevatedButton>(find.byKey(const ValueKey('duty_toggle_button')));
      expect(button.onPressed, isNull);
    });

    testWidgets('B-WIDGET: UI remains in STARTING / transition state while workerReady is false or lifecycleSeq mismatch', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);

      // Part 1: workerReady = false -> remains in STARTING transition state
      controller.updateProfile(testProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b',
        dutyGeneration: 1,
        lifecycleSeq: 2,
        workerReady: false,
      ));
      controller.overrideAuthoritative = AuthoritativeDutyState.onDuty;
      controller.overrideTrackingHealth = TrackingHealth.starting;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile.copyWith(isOnDuty: true),
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;
      expect(find.text(l10n.dutyTransitionInProgress), findsOneWidget);
      expect(find.text(l10n.hubStatusOnDuty), findsNothing);

      // Part 2: lifecycleSeq mismatch -> remains in STARTING transition state
      controller.updateProfile(testProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b',
        dutyGeneration: 1,
        lifecycleSeq: 1, // Mismatch with native worker (2)
        workerReady: true,
      ));
      controller.overrideTrackingHealth = TrackingHealth.starting;
      controller.notify();
      await tester.pumpAndSettle();

      expect(find.text(l10n.dutyTransitionInProgress), findsOneWidget);
      expect(find.text(l10n.hubStatusOnDuty), findsNothing);
    });

    testWidgets('H-WIDGET: starting from READY, reconcile failure disables toggle, changes status, exposes retry cleanup', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);

      // Start in READY
      controller.updateProfile(testProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_h',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));
      controller.overrideAuthoritative = AuthoritativeDutyState.onDuty;
      controller.overrideTrackingHealth = TrackingHealth.healthy;
      controller.overrideCanToggle = true;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile.copyWith(isOnDuty: true),
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;
      expect(find.text(l10n.hubStatusOnDuty), findsOneWidget);
      var toggleBtn = tester.widget<ElevatedButton>(find.byKey(const ValueKey('duty_toggle_button')));
      expect(toggleBtn.onPressed, isNotNull);

      // Transition to reconcile failure
      controller.overrideAuthoritative = AuthoritativeDutyState.unknown;
      controller.overrideTrackingHealth = TrackingHealth.reconciliationFailed;
      controller.overrideCleanupRequired = true;
      controller.overrideCanToggle = false;
      controller.notify();
      await tester.pumpAndSettle();

      // Verify toggle button disabled
      toggleBtn = tester.widget<ElevatedButton>(find.byKey(const ValueKey('duty_toggle_button')));
      expect(toggleBtn.onPressed, isNull);

      // Verify status changes to attention required
      expect(find.text(l10n.dutyAttentionRequired), findsOneWidget);

      // Verify retry cleanup button is exposed and functional
      final retryFinder = find.byKey(const ValueKey('retry_cleanup_button'));
      expect(retryFinder, findsOneWidget);

      await tester.tap(retryFinder);
      await tester.pump();
      expect(controller.retryCleanupCalled, isTrue);
    });

    testWidgets('B-NULL-WIDGET: exact worker + null readiness -> not green READY (renders amber STARTING)', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);

      // Exact worker match, but workerReady is null
      controller.updateProfile(testProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_b_null',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: null,
      ));
      controller.overrideAuthoritative = AuthoritativeDutyState.onDuty;
      controller.overrideTrackingHealth = TrackingHealth.starting;
      controller.overrideCanToggle = true;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile.copyWith(isOnDuty: true),
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;
      // Must NOT show hubStatusOnDuty (green READY)
      expect(find.text(l10n.hubStatusOnDuty), findsNothing);
      // Must show transition in progress (amber STARTING)
      expect(find.text(l10n.dutyTransitionInProgress), findsOneWidget);
    });

    testWidgets('A/B-EPOCH-ADVANCE-WIDGET: server L1 ready, native L2 mismatch -> NOT green READY', (tester) async {
      final auth = WidgetTestAuthService();
      final loc = WidgetTestLocationService();
      final controller = TestableDutyController(locationService: loc, authService: auth);

      // Server is L1 ready, but native is L2 -> mismatch
      controller.updateProfile(testProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_epoch_widget',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      ));
      // Reconcile recognized mismatch: trackingHealth is reconciliationFailed, isReady is false
      controller.overrideAuthoritative = AuthoritativeDutyState.onDuty;
      controller.overrideTrackingHealth = TrackingHealth.reconciliationFailed;
      controller.overrideCanToggle = false;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: testProfile.copyWith(isOnDuty: true),
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;
      // Must NOT show hubStatusOnDuty (green READY)
      expect(find.text(l10n.hubStatusOnDuty), findsNothing);
      // Status indicates reconciliation/attention issue
      expect(find.text(l10n.dutyAttentionRequired), findsOneWidget);
    });

    testWidgets('Repro 2: real hub profile delivery cannot re-green after L1/L2 mismatch', (tester) async {
      final auth = m4_fakes.M4AcceptanceAuthService(duty_fakes.FakeUser(testProfile.uid));
      final loc = m4_fakes.M4AcceptanceLocationService()
        ..serviceRunning = true
        ..mockLifecycleSeq = 1
        ..durableOwnerRecord = DurableDutyOwnerRecord(
          uid: testProfile.uid,
          sessionId: 'sess_hub',
          generation: 1,
          lifecycleSeq: 1,
          startedAt: DateTime.now(),
        );
      final controller = DutyController(locationService: loc, authService: auth);
      final cachedL1 = testProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_hub',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      );
      loc.serverDriverState = {
        'uid': cachedL1.uid,
        'name': cachedL1.name,
        'phone': cachedL1.phone,
        'truckType': cachedL1.truckType.backendValue,
        'vehicleNumber': cachedL1.vehicleNumber,
        'verificationStatus': 'approved',
        'isOnDuty': true,
        'activeDutySessionId': 'sess_hub',
        'dutyGeneration': 1,
        'lifecycleSeq': 1,
        'workerReady': true,
      };

      Widget hub(DriverProfile profile) => createTestWidget(
        child: DispatchHubScreen(
          profile: profile,
          authService: auth,
          locationService: loc,
          controller: controller,
        ),
      );

      await tester.pumpWidget(hub(cachedL1));
      await tester.pumpAndSettle();
      expect(controller.isReady, isTrue);

      loc.mockLifecycleSeq = 2;
      loc.durableOwnerRecord = DurableDutyOwnerRecord(
        uid: testProfile.uid,
        sessionId: 'sess_hub',
        generation: 1,
        lifecycleSeq: 2,
        startedAt: DateTime.now(),
      );
      loc.serverDriverState = {
        'uid': testProfile.uid,
        'name': testProfile.name,
        'phone': testProfile.phone,
        'truckType': testProfile.truckType.backendValue,
        'vehicleNumber': testProfile.vehicleNumber,
        'verificationStatus': 'approved',
        'isOnDuty': true,
        'activeDutySessionId': 'sess_hub',
        'dutyGeneration': 1,
        'lifecycleSeq': 1,
        'workerReady': true,
      };
      await controller.reconcileDutyState();
      expect(controller.isReady, isFalse);
      expect(controller.activeSession, isNull);
      expect(loc.stopCalls, isEmpty);

      // Rebuild the same hub State to exercise didUpdateWidget's cached profile callback.
      await tester.pumpWidget(hub(cachedL1.copyWith()));
      await tester.pumpAndSettle();
      final l10n = AppLocalizations.of(tester.element(find.byType(DispatchHubScreen)))!;
      expect(find.text(l10n.hubStatusOnDuty), findsNothing);
      expect(find.text(l10n.dutyAttentionRequired), findsOneWidget);
      expect(controller.isReady, isFalse);
      expect(controller.canToggleDuty, isFalse);
      final button = tester.widget<ElevatedButton>(
        find.byKey(const ValueKey('duty_toggle_button')),
      );
      expect(button.onPressed, isNull);
    });
  });
}
