// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/job_offer.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/offer_service.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:driver_app/features/hub/screens/dispatch_hub_screen.dart';
import 'package:driver_app/features/hub/widgets/incoming_offer_sheet.dart';
import 'package:driver_app/features/hub/widgets/wallet_topup_sheet.dart';
import 'package:driver_app/features/job/screens/active_job_screen.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'test_helper.dart';

class FakeUser implements User {
  @override
  final String uid;
  @override
  final String? phoneNumber;
  FakeUser({required this.uid, this.phoneNumber});

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeAuthService extends AuthService {
  final User? user;
  FakeAuthService([this.user]);

  @override
  User? get currentUser => user;

  @override
  Stream<User?> get authStateChanges => Stream.value(user);
}

class FakeLocationService extends LocationService {
  DriverPosition? currentPos;

  FakeLocationService({this.currentPos});

  @override
  Future<DriverPosition?> getCurrentPosition() async => currentPos;

  @override
  Stream<DriverPosition> getPositionStream() => const Stream.empty();

  @override
  Future<Map<String, dynamic>> fetchServerDriverState(String uid) async {
    return {
      'isOnDuty': true,
      'hasActiveJob': false,
      'hasActiveOffer': false,
    };
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeFullJourneyOfferService extends OfferService {
  final StreamController<JobOffer?> hubOfferController = StreamController<JobOffer?>.broadcast();
  final StreamController<JobOffer?> activeJobOfferController = StreamController<JobOffer?>.broadcast();

  int acceptCalls = 0;
  int startCalls = 0;
  int completeCalls = 0;
  int topupCalls = 0;

  List<String> acceptRequestIds = [];
  List<String> startRequestIds = [];
  List<String> completeRequestIds = [];
  List<String> topupRequestIds = [];

  @override
  Stream<JobOffer?> streamActiveOffer({
    required String driverId,
    required String? activeOfferId,
  }) {
    if (activeOfferId == null || activeOfferId.isEmpty) {
      return Stream.value(null);
    }
    return hubOfferController.stream;
  }

  @override
  Stream<JobOffer?> streamAcceptedJobOffer({
    required String driverId,
    required String jobId,
  }) {
    return activeJobOfferController.stream;
  }

  @override
  Future<AcceptJobResult> acceptOffer({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    acceptCalls++;
    acceptRequestIds.add(requestId);
    return AcceptJobResult(
      accepted: true,
      jobId: jobId,
      offerId: offerId,
      driverId: 'driver_p5_1',
    );
  }

  @override
  Future<StartJobResult> startJob({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    startCalls++;
    startRequestIds.add(requestId);
    return StartJobResult(
      started: true,
      jobId: jobId,
      offerId: offerId,
      driverId: 'driver_p5_1',
    );
  }

  @override
  Future<CompleteJobResult> completeJob({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    completeCalls++;
    completeRequestIds.add(requestId);
    return CompleteJobResult(
      completed: true,
      jobId: jobId,
      offerId: offerId,
      driverId: 'driver_p5_1',
    );
  }

  @override
  Future<InitiateTopupResult> initiateWalletTopup({
    required int amountPaise,
    required String requestId,
  }) async {
    topupCalls++;
    topupRequestIds.add(requestId);
    return InitiateTopupResult(
      topupId: 'topup_order_test',
      orderId: 'order_test_999',
      amountPaise: amountPaise,
    );
  }
}

class FakeTestDutyController extends DutyController {
  bool _mockIsOnDuty = false;
  DriverProfile? _profile;

  FakeTestDutyController({
    required super.locationService,
    required super.authService,
    super.clock,
    this._profile,
  });

  @override
  DriverProfile? get currentProfile => _profile;

  @override
  void updateProfile(DriverProfile profile) {
    _profile = profile;
    notifyListeners();
  }

  @override
  bool get isOnDuty => _mockIsOnDuty;

  @override
  bool get isReady => true;

  @override
  bool get canToggleDuty => true;

  @override
  AuthoritativeDutyState get authoritativeDutyState =>
      _mockIsOnDuty ? AuthoritativeDutyState.onDuty : AuthoritativeDutyState.offDuty;

  @override
  Future<bool> requestGoOnDuty({
    required Future<bool> Function() onShowDisclosure,
    String? notificationTitle,
    String? notificationText,
    String? locale,
  }) async {
    _mockIsOnDuty = true;
    notifyListeners();
    return true;
  }

  @override
  Future<bool> requestGoOffDuty() async {
    _mockIsOnDuty = false;
    notifyListeners();
    return true;
  }
}

void main() {
  group('Phase 5 Complete Driver-App Integration Flow', () {
    final fixedClock = DateTime(2026, 10, 6, 15, 0, 0);

    DriverProfile createTestDriver({
      bool isOnDuty = false,
      String? activeOfferId,
      String? activeJobId,
      int walletBalance = 50000, // ₹500.00
    }) {
      return DriverProfile(
        uid: 'driver_p5_1',
        phone: '+919876543210',
        name: 'Arjun Verma',
        vehicleNumber: 'MH-12-AB-1234',
        truckType: TruckType.flatbed,
        isOnDuty: isOnDuty,
        activeOfferId: activeOfferId,
        activeJobId: activeJobId,
        walletBalance: walletBalance,
        strictMode: false,
        createdAt: fixedClock,
        updatedAt: fixedClock,
      );
    }

    JobOffer createSampleOffer({
      String id = 'offer_phase5_100',
      String jobId = 'job_phase5_100',
      JobOfferStatus status = JobOfferStatus.offered,
    }) {
      return JobOffer(
        id: id,
        jobId: jobId,
        driverId: 'driver_p5_1',
        dispatchGeneration: 1,
        status: status,
        requestedTruckType: 'flatbed',
        pickupCoords: const OfferCoordinates(lat: 18.5204, lng: 73.8567),
        destCoords: const OfferCoordinates(lat: 18.5600, lng: 73.9100),
        estimatedFarePaise: 150000, // ₹1,500.00
        driverCommissionPaise: 22500, // ₹225.00
        pickupRoutedDistanceMeters: 12500, // 12.5 km
        pickupEtaSeconds: 1080, // 18 min
        cancellationPolicySnapshot: {
          'freeCancellationsPerMonth': 2,
          'driverCancellationFinePaise': 10000,
        },
        offeredAt: fixedClock,
        expiresAt: fixedClock.add(const Duration(seconds: 45)),
      );
    }

    testWidgets('Full End-to-End Journey: Duty -> Offer -> Accept -> Route -> Start Tow -> Complete -> Topup -> Off Duty', (tester) async {
      final fakeOfferService = FakeFullJourneyOfferService();
      final fakeAuth = FakeAuthService(FakeUser(uid: 'driver_p5_1', phoneNumber: '+919876543210'));
      final fakeLocation = FakeLocationService();

      var profile = createTestDriver(isOnDuty: false);
      final dutyController = FakeTestDutyController(
        locationService: fakeLocation,
        authService: fakeAuth,
        clock: () => fixedClock,
        profile: profile,
      );

      // 1. Mount DispatchHubScreen
      await tester.pumpWidget(
        createTestWidget(
          child: StatefulBuilder(
            builder: (context, setState) {
              return DispatchHubScreen(
                profile: profile,
                authService: fakeAuth,
                locationService: fakeLocation,
                offerService: fakeOfferService,
                controller: dutyController,
                clock: () => fixedClock,
                mapWidgetBuilder: (context, pos) => const SizedBox(key: ValueKey('test_map')),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Hub initial state: OFF DUTY, ₹500.00 balance
      expect(find.byKey(const ValueKey('duty_toggle_button')), findsOneWidget);
      expect(find.text('₹500.00'), findsOneWidget);
      expect(find.text('GO ON DUTY'), findsOneWidget);

      // 2. Go ON DUTY
      await tester.tap(find.byKey(const ValueKey('duty_toggle_button')));
      await tester.pumpAndSettle();
      expect(dutyController.isOnDuty, isTrue);
      expect(find.text('GO OFF DUTY'), findsOneWidget);

      // 3. Incoming Offer Arrives
      final sampleOffer = createSampleOffer(status: JobOfferStatus.offered);
      profile = profile.copyWith(activeOfferId: sampleOffer.id, isOnDuty: true);
      dutyController.updateProfile(profile);

      // Push offer to stream and pump
      fakeOfferService.hubOfferController.add(sampleOffer);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      // Verify IncomingOfferSheet is rendered with details
      expect(find.byType(IncomingOfferSheet), findsOneWidget);
      expect(find.text('₹1500.00'), findsOneWidget); // informational earnings
      expect(find.text('-₹225.00'), findsOneWidget); // driver commission
      expect(find.text('12.5 km'), findsOneWidget);
      expect(find.text('FLATBED'), findsOneWidget);

      // Verify >=56dp touch targets on offer buttons
      final acceptBtn = find.byKey(const ValueKey('accept_offer_button'));
      final declineBtn = find.byKey(const ValueKey('decline_offer_button'));
      expect(acceptBtn, findsOneWidget);
      expect(declineBtn, findsOneWidget);
      expect(tester.getSize(acceptBtn).height, greaterThanOrEqualTo(56.0));
      expect(tester.getSize(declineBtn).height, greaterThanOrEqualTo(56.0));

      // 4. Accept Offer
      await tester.tap(acceptBtn);
      await tester.pumpAndSettle();
      expect(fakeOfferService.acceptCalls, equals(1));
      expect(fakeOfferService.acceptRequestIds.first, isNotEmpty);

      // 5. Transition to ActiveJobScreen
      var activeOffer = createSampleOffer(status: JobOfferStatus.accepted);
      profile = profile.copyWith(
        activeJobId: activeOffer.jobId,
        activeOfferId: null,
      );

      double? capturedNavLat;
      double? capturedNavLng;

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: activeOffer.jobId,
            profile: profile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: activeOffer,
            clock: () => fixedClock,
            onLaunchNavigation: (lat, lng) async {
              capturedNavLat = lat;
              capturedNavLng = lng;
              return true;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Verify ActiveJobScreen displays ASSIGNED status, route, and >=56dp buttons
      expect(find.text('ASSIGNED'), findsWidgets);
      expect(find.text('job_phase5_100'), findsOneWidget);
      expect(find.byKey(const ValueKey('navigate_pickup_button')), findsOneWidget);
      expect(find.byKey(const ValueKey('start_tow_button')), findsOneWidget);
      expect(find.byKey(const ValueKey('cancel_job_button')), findsOneWidget);

      expect(tester.getSize(find.byKey(const ValueKey('navigate_pickup_button'))).height, greaterThanOrEqualTo(56.0));
      expect(tester.getSize(find.byKey(const ValueKey('start_tow_button'))).height, greaterThanOrEqualTo(56.0));
      expect(tester.getSize(find.byKey(const ValueKey('cancel_job_button'))).height, greaterThanOrEqualTo(56.0));

      // 6. External Navigation to Pickup
      await tester.ensureVisible(find.byKey(const ValueKey('navigate_pickup_button')));
      await tester.tap(find.byKey(const ValueKey('navigate_pickup_button')));
      await tester.pumpAndSettle();
      expect(capturedNavLat, equals(18.5204));
      expect(capturedNavLng, equals(73.8567));

      // 7. Start Tow (Transition to in_progress)
      await tester.ensureVisible(find.byKey(const ValueKey('start_tow_button')));
      await tester.tap(find.byKey(const ValueKey('start_tow_button')));
      await tester.pumpAndSettle();
      expect(fakeOfferService.startCalls, equals(1));
      expect(fakeOfferService.startRequestIds.first, isNotEmpty);

      // Offer stream emits in_progress
      activeOffer = createSampleOffer(status: JobOfferStatus.inProgress);
      fakeOfferService.activeJobOfferController.add(activeOffer);
      await tester.pumpAndSettle();

      // Verify in_progress UI: IN PROGRESS banner, NAVIGATE TO DESTINATION, MARK COMPLETE
      expect(find.text('IN PROGRESS'), findsWidgets);
      expect(find.byKey(const ValueKey('navigate_destination_button')), findsOneWidget);
      expect(find.byKey(const ValueKey('complete_job_button')), findsOneWidget);
      expect(find.byKey(const ValueKey('cancel_job_button')), findsNothing); // Cancel strictly hidden in progress

      expect(tester.getSize(find.byKey(const ValueKey('navigate_destination_button'))).height, greaterThanOrEqualTo(56.0));
      expect(tester.getSize(find.byKey(const ValueKey('complete_job_button'))).height, greaterThanOrEqualTo(56.0));

      // 8. External Navigation to Destination
      await tester.ensureVisible(find.byKey(const ValueKey('navigate_destination_button')));
      await tester.tap(find.byKey(const ValueKey('navigate_destination_button')));
      await tester.pumpAndSettle();
      expect(capturedNavLat, equals(18.5600));
      expect(capturedNavLng, equals(73.9100));

      // 9. Mark Complete
      await tester.ensureVisible(find.byKey(const ValueKey('complete_job_button')));
      await tester.tap(find.byKey(const ValueKey('complete_job_button')));
      await tester.pumpAndSettle();
      expect(fakeOfferService.completeCalls, equals(1));
      expect(fakeOfferService.completeRequestIds.first, isNotEmpty);

      // Offer stream emits completed
      activeOffer = createSampleOffer(status: JobOfferStatus.completed);
      fakeOfferService.activeJobOfferController.add(activeOffer);
      await tester.pumpAndSettle();

      expect(find.text('Job Completed Successfully'), findsWidgets);

      // 10. Return to Hub, Open Wallet Top-Up Sheet
      profile = profile.copyWith(activeJobId: null, walletBalance: 47750); // After commission deducted
      dutyController.updateProfile(profile);

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: profile,
            authService: fakeAuth,
            locationService: fakeLocation,
            offerService: fakeOfferService,
            controller: dutyController,
            clock: () => fixedClock,
            mapWidgetBuilder: (context, pos) => const SizedBox(key: ValueKey('test_map')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Open wallet top-up sheet
      final topupBtn = find.byKey(const ValueKey('hub_wallet_topup_button'));
      expect(topupBtn, findsOneWidget);
      await tester.tap(topupBtn);
      await tester.pumpAndSettle();

      expect(find.byType(WalletTopupSheet), findsOneWidget);
      // Select preset ₹1,000 chip
      final preset1000 = find.byKey(const ValueKey('topup_preset_1000'));
      expect(preset1000, findsOneWidget);
      await tester.tap(preset1000);
      await tester.pumpAndSettle();

      final topupSubmitBtn = find.byKey(const ValueKey('topup_submit_button'));
      expect(topupSubmitBtn, findsOneWidget);
      expect(tester.getSize(topupSubmitBtn).height, greaterThanOrEqualTo(56.0));

      await tester.tap(topupSubmitBtn);
      await tester.pumpAndSettle();
      expect(fakeOfferService.topupCalls, equals(1));
      expect(fakeOfferService.topupRequestIds.first, isNotEmpty);

      // 11. Go OFF DUTY
      expect(find.byKey(const ValueKey('duty_toggle_button')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('duty_toggle_button')));
      await tester.pumpAndSettle();
      expect(dutyController.isOnDuty, isFalse);
      expect(find.text('GO ON DUTY'), findsOneWidget);

      await fakeOfferService.hubOfferController.close();
      await fakeOfferService.activeJobOfferController.close();
    });
  });
}
