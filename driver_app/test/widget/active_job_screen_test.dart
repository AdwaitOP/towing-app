// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/job_offer.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/core/services/offer_service.dart';
import 'package:driver_app/features/job/screens/active_job_screen.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'test_helper.dart';

class FakeUser implements User {
  @override
  final String uid;
  FakeUser({required this.uid});
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

class FakeLifecycleOfferService extends OfferService {
  final StreamController<JobOffer?> offerController;

  int startCallCount = 0;
  int completeCallCount = 0;
  int cancelCallCount = 0;

  List<String> capturedStartRequestIds = [];
  List<String> capturedCompleteRequestIds = [];
  List<String> capturedCancelRequestIds = [];

  Exception? startException;
  Exception? completeException;

  StartJobResult? nextStartResult;
  CompleteJobResult? nextCompleteResult;

  FakeLifecycleOfferService(this.offerController);

  @override
  Stream<JobOffer?> streamAcceptedJobOffer({
    required String driverId,
    required String jobId,
  }) {
    return offerController.stream;
  }

  @override
  Future<StartJobResult> startJob({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    startCallCount++;
    capturedStartRequestIds.add(requestId);

    if (startException != null) {
      throw startException!;
    }

    return nextStartResult ??
        StartJobResult(
          started: true,
          jobId: jobId,
          offerId: offerId,
          driverId: 'driver_123',
        );
  }

  @override
  Future<CompleteJobResult> completeJob({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    completeCallCount++;
    capturedCompleteRequestIds.add(requestId);

    if (completeException != null) {
      throw completeException!;
    }

    return nextCompleteResult ??
        CompleteJobResult(
          completed: true,
          jobId: jobId,
          offerId: offerId,
          driverId: 'driver_123',
        );
  }
}

void main() {
  group('ActiveJobScreen Lifecycle & Invariants (Batch 2)', () {
    final now = DateTime(2026, 10, 6, 12, 0, 0);

    const testProfile = DriverProfile(
      uid: 'driver_123',
      name: 'Rohan Sharma',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH 12 AB 1234',
      isOnDuty: true,
      verificationStatus: 'approved',
      activeJobId: 'job_999',
      walletBalance: 75000, // ₹750.00
    );

    JobOffer createAcceptedOffer({
      String jobId = 'job_999',
      JobOfferStatus status = JobOfferStatus.accepted,
      Map<String, dynamic>? policySnapshot,
    }) {
      return JobOffer(
        id: 'offer_999',
        jobId: jobId,
        driverId: 'driver_123',
        dispatchGeneration: 1,
        status: status,
        offeredAt: now,
        expiresAt: now.add(const Duration(seconds: 45)),
        acceptedAt: now,
        pickupCoords: const OfferCoordinates(lat: 18.5204, lng: 73.8567),
        destCoords: const OfferCoordinates(lat: 18.5500, lng: 73.8800),
        requestedTruckType: 'flatbed',
        estimatedFarePaise: 350000,
        driverCommissionPaise: 52500,
        pickupRoutedDistanceMeters: 6500,
        pickupEtaSeconds: 720,
        cancellationPolicySnapshot: policySnapshot ?? {
          'freeCancellationsPerMonth': 2,
          'banThresholdCount': 3,
          'forfeitPctByCount': {'2': 50},
          'version': 1,
          'timezone': 'Asia/Kolkata',
          'roundingMode': 'HALF_UP',
        },
      );
    }

    testWidgets('renders job identification, wallet balance, and action controls in accepted state', (tester) async {
      final offer = createAcceptedOffer();
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: offer,
          ),
        ),
      );
      await tester.pump();

      // Title & Status
      expect(find.text('Active Job'), findsOneWidget);
      expect(find.text('ASSIGNED'), findsWidgets);
      // Wallet balance displayed in AppBar
      expect(find.text('₹750.00'), findsOneWidget);

      // Job ID & Route
      expect(find.text('job_999'), findsOneWidget);
      expect(find.text('Route Details'), findsOneWidget);

      // Financials
      expect(find.text('₹3500.00'), findsOneWidget);
      expect(find.text('-₹525.00'), findsOneWidget);

      // Accepted state action buttons: START TOW and CANCEL JOB
      expect(find.byKey(const ValueKey('start_tow_button')), findsOneWidget);
      expect(find.byKey(const ValueKey('cancel_job_button')), findsOneWidget);
      expect(find.text('START TOW'), findsOneWidget);
      expect(find.text('CANCEL JOB'), findsOneWidget);

      await streamController.close();
    });

    testWidgets('tapping START TOW invokes startJob callable with unique requestId', (tester) async {
      final offer = createAcceptedOffer();
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: offer,
          ),
        ),
      );
      await tester.pump();

      final startBtn = find.byKey(const ValueKey('start_tow_button'));
      await tester.ensureVisible(startBtn);
      await tester.tap(startBtn);
      await tester.pumpAndSettle();

      expect(fakeOfferService.startCallCount, equals(1));
      expect(fakeOfferService.capturedStartRequestIds.length, equals(1));
      expect(fakeOfferService.capturedStartRequestIds.first.startsWith('req_start_'), isTrue);

      await streamController.close();
    });

    testWidgets('uncertain startTow retry reuses identical requestId', (tester) async {
      final offer = createAcceptedOffer();
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      fakeOfferService.startException = Exception('Network timeout starting tow');
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: offer,
          ),
        ),
      );
      await tester.pump();

      final startBtn = find.byKey(const ValueKey('start_tow_button'));
      await tester.ensureVisible(startBtn);
      await tester.tap(startBtn);
      await tester.pumpAndSettle();

      expect(fakeOfferService.startCallCount, equals(1));
      final firstRequestId = fakeOfferService.capturedStartRequestIds[0];

      // Prepare success for retry
      fakeOfferService.startException = null;
      fakeOfferService.nextStartResult = const StartJobResult(
        started: true,
        jobId: 'job_999',
        offerId: 'offer_999',
        driverId: 'driver_123',
      );

      // Retry tap
      await tester.ensureVisible(startBtn);
      await tester.tap(startBtn);
      await tester.pumpAndSettle();

      expect(fakeOfferService.startCallCount, equals(2));
      // Invariant: must reuse the identical requestId on retry
      expect(fakeOfferService.capturedStartRequestIds[1], equals(firstRequestId));

      await streamController.close();
    });

    testWidgets('when offer status is in_progress, renders MARK COMPLETE and CANCEL is unavailable', (tester) async {
      final inProgressOffer = createAcceptedOffer(status: JobOfferStatus.inProgress);
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: inProgressOffer,
          ),
        ),
      );
      await tester.pump();

      expect(find.text('IN PROGRESS'), findsWidgets);
      expect(find.byKey(const ValueKey('complete_job_button')), findsOneWidget);
      expect(find.text('MARK COMPLETE'), findsOneWidget);

      // Invariant: Cancel is unavailable once tow is in progress
      expect(find.byKey(const ValueKey('cancel_job_button')), findsNothing);
      expect(find.text('Cancellation is not permitted once tow is in progress.'), findsOneWidget);

      await streamController.close();
    });

    testWidgets('tapping MARK COMPLETE invokes completeJob callable with unique requestId', (tester) async {
      final inProgressOffer = createAcceptedOffer(status: JobOfferStatus.inProgress);
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: inProgressOffer,
          ),
        ),
      );
      await tester.pump();

      final completeBtn = find.byKey(const ValueKey('complete_job_button'));
      await tester.ensureVisible(completeBtn);
      await tester.tap(completeBtn);
      await tester.pumpAndSettle();

      expect(fakeOfferService.completeCallCount, equals(1));
      expect(fakeOfferService.capturedCompleteRequestIds.length, equals(1));
      expect(fakeOfferService.capturedCompleteRequestIds.first.startsWith('req_complete_'), isTrue);

      await streamController.close();
    });

    testWidgets('uncertain completeJob retry reuses identical requestId', (tester) async {
      final inProgressOffer = createAcceptedOffer(status: JobOfferStatus.inProgress);
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      fakeOfferService.completeException = Exception('Network error completing job');
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: inProgressOffer,
          ),
        ),
      );
      await tester.pump();

      final completeBtn = find.byKey(const ValueKey('complete_job_button'));
      await tester.ensureVisible(completeBtn);
      await tester.tap(completeBtn);
      await tester.pumpAndSettle();

      expect(fakeOfferService.completeCallCount, equals(1));
      final firstRequestId = fakeOfferService.capturedCompleteRequestIds[0];

      // Prepare success for retry
      fakeOfferService.completeException = null;
      fakeOfferService.nextCompleteResult = const CompleteJobResult(
        completed: true,
        jobId: 'job_999',
        offerId: 'offer_999',
        driverId: 'driver_123',
      );

      // Retry tap
      await tester.ensureVisible(completeBtn);
      await tester.tap(completeBtn);
      await tester.pumpAndSettle();

      expect(fakeOfferService.completeCallCount, equals(2));
      // Invariant: must reuse identical requestId
      expect(fakeOfferService.capturedCompleteRequestIds[1], equals(firstRequestId));

      await streamController.close();
    });

    testWidgets('customer cancellation overlap displays truthful non-penalizing banner', (tester) async {
      final customerCancelledOffer = createAcceptedOffer(status: JobOfferStatus.cancelledCustomer);
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: customerCancelledOffer,
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(const ValueKey('customer_cancelled_banner')), findsOneWidget);
      expect(find.text('Customer cancellation is in progress. No driver penalty applied. Your wallet balance will update once confirmed.'), findsOneWidget);

      await streamController.close();
    });

    testWidgets('logout is blocked with snackbar when driver is on active job (Stage 3 Invariant)', (tester) async {
      final offer = createAcceptedOffer();
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile, // hasActiveJob is true
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: offer,
          ),
        ),
      );
      await tester.pump();

      // Tap logout icon in AppBar
      await tester.tap(find.byIcon(Icons.logout));
      await tester.pumpAndSettle();

      // Stage 3 invariant: Logout is blocked by active job!
      expect(find.text('Cannot log out while an active job is assigned.'), findsOneWidget);

      await streamController.close();
    });

    testWidgets('Batch 3: NAVIGATE TO PICKUP triggers external navigation with pickup coordinates and >=56dp target', (tester) async {
      final offer = createAcceptedOffer(status: JobOfferStatus.accepted);
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      double? capturedLat;
      double? capturedLng;

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: offer,
            onLaunchNavigation: (lat, lng) async {
              capturedLat = lat;
              capturedLng = lng;
              return true;
            },
          ),
        ),
      );
      await tester.pump();

      final navBtn = find.byKey(const ValueKey('navigate_pickup_button'));
      expect(navBtn, findsOneWidget);
      expect(tester.getSize(navBtn).height, greaterThanOrEqualTo(56.0));

      final startBtn = find.byKey(const ValueKey('start_tow_button'));
      expect(startBtn, findsOneWidget);
      expect(tester.getSize(startBtn).height, greaterThanOrEqualTo(56.0));

      final cancelBtn = find.byKey(const ValueKey('cancel_job_button'));
      expect(cancelBtn, findsOneWidget);
      expect(tester.getSize(cancelBtn).height, greaterThanOrEqualTo(56.0));

      await tester.ensureVisible(navBtn);
      await tester.tap(navBtn);
      await tester.pumpAndSettle();

      expect(capturedLat, equals(offer.pickupCoords.lat));
      expect(capturedLng, equals(offer.pickupCoords.lng));

      await streamController.close();
    });

    testWidgets('Batch 3: NAVIGATE TO DESTINATION triggers external navigation with dest coordinates and >=56dp target', (tester) async {
      final offer = createAcceptedOffer(status: JobOfferStatus.inProgress);
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      double? capturedLat;
      double? capturedLng;

      await tester.pumpWidget(
        createTestWidget(
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: offer,
            onLaunchNavigation: (lat, lng) async {
              capturedLat = lat;
              capturedLng = lng;
              return true;
            },
          ),
        ),
      );
      await tester.pump();

      final navBtn = find.byKey(const ValueKey('navigate_destination_button'));
      expect(navBtn, findsOneWidget);
      expect(tester.getSize(navBtn).height, greaterThanOrEqualTo(56.0));

      final completeBtn = find.byKey(const ValueKey('complete_job_button'));
      expect(completeBtn, findsOneWidget);
      expect(tester.getSize(completeBtn).height, greaterThanOrEqualTo(56.0));

      await tester.ensureVisible(navBtn);
      await tester.tap(navBtn);
      await tester.pumpAndSettle();

      expect(capturedLat, equals(offer.destCoords.lat));
      expect(capturedLng, equals(offer.destCoords.lng));

      await streamController.close();
    });

    testWidgets('F06: cold-start active job with native absence enters existing recovery', (tester) async {
      NativeOwnershipCoordinator.useTestSimulation = false;
      final calls = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
        NativeOwnershipCoordinator.channel,
        (call) async {
          calls.add(call.method);
          if (call.method == 'isServiceRunning') return false;
          if (call.method == 'getDurableOwner') return null;
          return null;
        },
      );
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
          NativeOwnershipCoordinator.channel,
          null,
        );
        NativeOwnershipCoordinator.useTestSimulation = true;
      });

      final offer = createAcceptedOffer();
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService(FakeUser(uid: 'driver_123'));

      final activeProfile = testProfile.copyWith(
        activeDutySessionId: 'sess_123',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );

      final testWidget = createTestWidget(
        child: ActiveJobScreen(
          jobId: 'job_999',
          profile: activeProfile,
          authService: fakeAuth,
          offerService: fakeOfferService,
          initialOffer: offer,
        ),
      );
      NativeOwnershipCoordinator.useTestSimulation = false;
      await tester.pumpWidget(testWidget);
      await tester.pump(const Duration(seconds: 1));

      expect(calls, isNotEmpty,
          reason: 'ActiveJobScreen cold start must query native ownership to reconcile duty state');
      expect(calls, contains('isServiceRunning'));
      await streamController.close();
    });

    testWidgets('F07: active job status badge renders localized text in Hindi', (tester) async {
      final offer = createAcceptedOffer(status: JobOfferStatus.inProgress);
      final streamController = StreamController<JobOffer?>.broadcast();
      final fakeOfferService = FakeLifecycleOfferService(streamController);
      final fakeAuth = FakeAuthService();

      await tester.pumpWidget(
        createTestWidget(
          locale: const Locale('hi'),
          child: ActiveJobScreen(
            jobId: 'job_999',
            profile: testProfile,
            authService: fakeAuth,
            offerService: fakeOfferService,
            initialOffer: offer,
          ),
        ),
      );
      await tester.pump();

      // Status pill badge must render Hindi localized text "प्रगति पर", not raw English "IN_PROGRESS"
      expect(find.text('प्रगति पर'), findsNWidgets(2)); // main text and pill badge
      expect(find.text('IN_PROGRESS'), findsNothing);

      await streamController.close();
    });
  });
}
