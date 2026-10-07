import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/job_offer.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/core/services/offer_service.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/screens/dispatch_hub_screen.dart';
import 'package:driver_app/features/hub/widgets/wallet_topup_sheet.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'test_helper.dart';

class FakeHubAuthService extends AuthService {
  @override
  User? get currentUser => null;
  @override
  Stream<User?> get authStateChanges => Stream.value(null);
  @override
  Future<void> signOut() async {}
}

class FakeHubLocationService implements LocationService {
  final StreamController<DriverPosition> _controller =
      StreamController<DriverPosition>.broadcast();
  DutySession? currentSession;
  bool serviceEnabled = true;

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
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;
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
  Stream<DriverPosition> getPositionStream() => _controller.stream;
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
      DutyActivationPreparation(sessionId: '${uid}_${DateTime.now().microsecondsSinceEpoch}', generation: 1);
  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async =>
      {'status': 'activated', 'dutyGeneration': generation ?? 1, 'lifecycleSeq': lifecycleSeq ?? 1, 'workerReady': true};
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
      {
        'sessionId': '${uid}_recovered',
        'dutyGeneration': 1,
        'workerReady': false,
        'lifecycleSeq': null,
        'activeJobId': expectedActiveJobId,
        'status': 'recovered',
      };
  @override
  Future<bool> openAppSettings() async => true;
  @override
  void dispose() {
    _controller.close();
  }
}

class FakeHubOfferService extends Fake implements OfferService {
  @override
  Stream<JobOffer?> streamActiveOffer({required String driverId, required String? activeOfferId}) {
    return const Stream.empty();
  }
}

void main() {
  group('DispatchHubScreen Wallet & Policy Presentation (Batch 2)', () {
    final auth = FakeHubAuthService();
    final locService = FakeHubLocationService();
    final offerService = FakeHubOfferService();

    DriverProfile createProfile({
      int walletBalance = 50000, // ₹500.00
      bool strictMode = false,
      int monthlyCancelCount = 0,
      DateTime? bannedUntil,
      bool isOnDuty = false,
    }) {
      return DriverProfile(
        uid: 'driver_test_wallet',
        name: 'Sunil Gavaskar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: isOnDuty,
        walletBalance: walletBalance,
        strictMode: strictMode,
        monthlyCancelCount: MonthlyCancelCount(month: '2026-10', count: monthlyCancelCount),
        bannedUntil: bannedUntil,
      );
    }

    testWidgets('renders real-time wallet balance card with formatted balance', (tester) async {
      final profile = createProfile(walletBalance: 75050); // ₹750.50

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: profile,
            authService: auth,
            locationService: locService,
            offerService: offerService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('hub_wallet_card')), findsOneWidget);
      expect(find.text('₹750.50'), findsOneWidget);
      expect(find.text('Wallet Balance'), findsOneWidget);
      expect(find.byKey(const ValueKey('hub_wallet_topup_button')), findsOneWidget);
    });

    testWidgets('renders low-balance warning banner when balance < ₹200 and driver is NOT banned', (tester) async {
      final lowProfile = createProfile(walletBalance: 12000); // ₹120.00 (< ₹200)

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: lowProfile,
            authService: auth,
            locationService: locService,
            offerService: offerService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('low_balance_warning_card')), findsOneWidget);
      expect(find.textContaining('Low wallet balance: ₹120.00'), findsOneWidget);
      expect(find.byKey(const ValueKey('low_balance_topup_button')), findsOneWidget);
    });

    testWidgets('does NOT render low-balance warning banner when balance >= ₹200', (tester) async {
      final healthyProfile = createProfile(walletBalance: 25000); // ₹250.00

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: healthyProfile,
            authService: auth,
            locationService: locService,
            offerService: offerService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('low_balance_warning_card')), findsNothing);
    });

    testWidgets('INVARIANT: Low balance does NOT block duty toggle (no hardcoded ₹200 duty gate)', (tester) async {
      // Driver with zero balance
      final zeroProfile = createProfile(walletBalance: 0, isOnDuty: false);

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: zeroProfile,
            authService: auth,
            locationService: locService,
            offerService: offerService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Duty toggle button must remain ENABLED
      final dutyButton = find.byKey(const ValueKey('duty_toggle_button'));
      expect(dutyButton, findsOneWidget);

      final buttonWidget = tester.widget<ElevatedButton>(dutyButton);
      expect(buttonWidget.onPressed, isNotNull, reason: 'Duty toggle button must remain active regardless of low balance');
    });

    testWidgets('renders strict mode badge and monthly cancellation count in driver summary card', (tester) async {
      final strictProfile = createProfile(
        strictMode: true,
        monthlyCancelCount: 2,
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: strictProfile,
            authService: auth,
            locationService: locService,
            offerService: offerService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Summary card details
      expect(find.byKey(const ValueKey('driver_summary_card')), findsOneWidget);
      expect(find.text('Cancellations this month: 2'), findsOneWidget);
      expect(find.byKey(const ValueKey('strict_mode_badge')), findsOneWidget);
      expect(find.text('Strict Mode Active'), findsOneWidget);
    });

    testWidgets('tapping top-up button opens WalletTopupSheet modal', (tester) async {
      final profile = createProfile(walletBalance: 5000);

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: profile,
            authService: auth,
            locationService: locService,
            offerService: offerService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final topupBtn = find.byKey(const ValueKey('hub_wallet_topup_button'));
      await tester.ensureVisible(topupBtn);
      await tester.tap(topupBtn);
      await tester.pumpAndSettle();

      // WalletTopupSheet should now be presented
      expect(find.byType(WalletTopupSheet), findsOneWidget);
      expect(find.text('Wallet Top-Up'), findsOneWidget);
    });

    testWidgets('when driver is temporarily banned, banner is shown and low balance banner suppressed', (tester) async {
      final bannedProfile = createProfile(
        walletBalance: 5000, // low balance
        bannedUntil: DateTime.now().add(const Duration(hours: 24)),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: bannedProfile,
            authService: auth,
            locationService: locService,
            offerService: offerService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('temporary_ban_banner')), findsOneWidget);
      expect(find.textContaining('temporarily paused'), findsOneWidget);
      // Low balance banner should not distract when account is banned
      expect(find.byKey(const ValueKey('low_balance_warning_card')), findsNothing);
    });
  });
}
