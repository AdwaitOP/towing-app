// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'package:driver_app/core/models/job_offer.dart';
import 'package:driver_app/core/services/offer_service.dart';
import 'package:driver_app/features/hub/widgets/incoming_offer_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'test_helper.dart';

class FakeOfferService extends OfferService {
  int acceptCallCount = 0;
  int declineCallCount = 0;
  List<String> capturedAcceptRequestIds = [];
  List<String> capturedDeclineRequestIds = [];
  Completer<AcceptJobResult>? acceptCompleter;
  Completer<DeclineJobResult>? declineCompleter;
  OfferActionException? acceptErrorToThrow;
  OfferActionException? declineErrorToThrow;

  @override
  Future<AcceptJobResult> acceptOffer({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    acceptCallCount++;
    capturedAcceptRequestIds.add(requestId);

    if (acceptErrorToThrow != null) {
      throw acceptErrorToThrow!;
    }

    if (acceptCompleter != null) {
      return acceptCompleter!.future;
    }

    return AcceptJobResult(
      accepted: true,
      jobId: jobId,
      offerId: offerId,
      driverId: 'driver_1',
    );
  }

  @override
  Future<DeclineJobResult> declineOffer({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    declineCallCount++;
    capturedDeclineRequestIds.add(requestId);

    if (declineErrorToThrow != null) {
      throw declineErrorToThrow!;
    }

    if (declineCompleter != null) {
      return declineCompleter!.future;
    }

    return DeclineJobResult(
      declined: true,
      jobId: jobId,
      offerId: offerId,
      driverId: 'driver_1',
    );
  }
}

void main() {
  group('IncomingOfferSheet Widget Tests', () {
    final now = DateTime(2026, 10, 6, 12, 0, 0);
    final expiresAt = now.add(const Duration(seconds: 45));

    JobOffer createTestOffer({
      DateTime? expiry,
      JobOfferStatus status = JobOfferStatus.offered,
      int farePaise = 250000,
      int commissionPaise = 37500,
      int? distanceMeters = 5000,
      int? etaSeconds = 600,
    }) {
      return JobOffer(
        id: 'offer_test_1',
        jobId: 'job_test_101',
        driverId: 'driver_1',
        dispatchGeneration: 1,
        status: status,
        offeredAt: now,
        expiresAt: expiry ?? expiresAt,
        pickupCoords: const OfferCoordinates(lat: 18.5204, lng: 73.8567),
        destCoords: const OfferCoordinates(lat: 18.5500, lng: 73.8800),
        requestedTruckType: 'flatbed',
        estimatedFarePaise: farePaise,
        driverCommissionPaise: commissionPaise,
        pickupRoutedDistanceMeters: distanceMeters,
        pickupEtaSeconds: etaSeconds,
      );
    }

    testWidgets('renders all key offer details accurately (Gate B1, B2)', (tester) async {
      final offer = createTestOffer();
      final fakeService = FakeOfferService();

      await tester.pumpWidget(
        createTestWidget(
          child: Scaffold(
            body: IncomingOfferSheet(
              offer: offer,
              offerService: fakeService,
              clock: () => now,
            ),
          ),
        ),
      );
      await tester.pump();

      // Title & Expiry countdown
      expect(find.text('Incoming Job Offer'), findsOneWidget);
      expect(find.text('45s remaining'), findsOneWidget);

      // Coordinates
      expect(find.textContaining('Lat: 18.5204, Lng: 73.8567'), findsOneWidget);
      expect(find.textContaining('Lat: 18.5500, Lng: 73.8800'), findsOneWidget);

      // Truck Type, ETA, Distance
      expect(find.text('FLATBED'), findsOneWidget);
      expect(find.text('5.0 km'), findsOneWidget);
      expect(find.text('~10 min'), findsOneWidget);

      // Financials
      expect(find.text('₹2500.00'), findsOneWidget);
      expect(find.text('-₹375.00'), findsOneWidget);

      // Action Buttons
      expect(find.byKey(const ValueKey('accept_offer_button')), findsOneWidget);
      expect(find.byKey(const ValueKey('decline_offer_button')), findsOneWidget);
    });

    testWidgets('authoritative expiry disables ACCEPT and DECLINE actions (Gate B4)', (tester) async {
      // Create an offer that expired 5 seconds ago
      final expiredOffer = createTestOffer(expiry: now.subtract(const Duration(seconds: 5)));
      final fakeService = FakeOfferService();

      await tester.pumpWidget(
        createTestWidget(
          child: Scaffold(
            body: IncomingOfferSheet(
              offer: expiredOffer,
              offerService: fakeService,
              clock: () => now,
            ),
          ),
        ),
      );
      await tester.pump();

      // Expiry badge
      expect(find.text('EXPIRED'), findsOneWidget);

      // Both buttons must be disabled
      final acceptButton = tester.widget<ElevatedButton>(find.byKey(const ValueKey('accept_offer_button')));
      expect(acceptButton.onPressed, isNull);

      final declineButton = tester.widget<OutlinedButton>(find.byKey(const ValueKey('decline_offer_button')));
      expect(declineButton.onPressed, isNull);

      // Tapping does nothing
      await tester.tap(find.byKey(const ValueKey('accept_offer_button')));
      expect(fakeService.acceptCallCount, equals(0));
    });

    testWidgets('rapid double ACCEPT dispatches only once (single-flight locking)', (tester) async {
      final offer = createTestOffer();
      final fakeService = FakeOfferService();
      fakeService.acceptCompleter = Completer<AcceptJobResult>();

      await tester.pumpWidget(
        createTestWidget(
          child: Scaffold(
            body: IncomingOfferSheet(
              offer: offer,
              offerService: fakeService,
              clock: () => now,
            ),
          ),
        ),
      );
      await tester.pump();

      // Tap ACCEPT once
      await tester.tap(find.byKey(const ValueKey('accept_offer_button')));
      await tester.pump();

      expect(fakeService.acceptCallCount, equals(1));

      // Attempt rapid second tap while first is in-flight
      await tester.tap(find.byKey(const ValueKey('accept_offer_button')));
      await tester.pump();

      // Still only 1 call dispatched!
      expect(fakeService.acceptCallCount, equals(1));

      // Resolve the in-flight call
      fakeService.acceptCompleter!.complete(
        const AcceptJobResult(
          accepted: true,
          jobId: 'job_test_101',
          offerId: 'offer_test_1',
          driverId: 'driver_1',
        ),
      );
      await tester.pumpAndSettle();
    });

    testWidgets('uncertain network retry reuses the SAME client requestId (Idempotency Rule)', (tester) async {
      final offer = createTestOffer();
      final fakeService = FakeOfferService();

      int reqCounter = 0;
      final testClock = now;

      await tester.pumpWidget(
        createTestWidget(
          child: Scaffold(
            body: IncomingOfferSheet(
              offer: offer,
              offerService: fakeService,
              clock: () => testClock,
              requestIdGenerator: () => 'generated_req_${++reqCounter}',
            ),
          ),
        ),
      );
      await tester.pump();

      // 1. Simulate network timeout error on first accept attempt
      fakeService.acceptErrorToThrow = const OfferActionException(
        code: 'NETWORK_ERROR',
        message: 'Deadline exceeded',
      );

      await tester.tap(find.byKey(const ValueKey('accept_offer_button')));
      await tester.pumpAndSettle();

      expect(fakeService.acceptCallCount, equals(1));
      final firstRequestId = fakeService.capturedAcceptRequestIds.first;
      expect(firstRequestId, equals('generated_req_1'));

      // Error banner is visible and button shows "RETRY ACCEPT"
      expect(find.text('RETRY ACCEPT'), findsOneWidget);

      // 2. Now driver taps RETRY ACCEPT. Backend is back online.
      fakeService.acceptErrorToThrow = null;

      await tester.tap(find.byKey(const ValueKey('accept_offer_button')));
      await tester.pumpAndSettle();

      expect(fakeService.acceptCallCount, equals(2));
      final secondRequestId = fakeService.capturedAcceptRequestIds[1];

      // CRITICAL IDEMPOTENCY INVARIANT: The retry MUST reuse the SAME requestId!
      expect(secondRequestId, equals(firstRequestId));
      expect(reqCounter, equals(1), reason: 'Did not generate a new requestId for retry of same logical operation');
    });

    testWidgets('insufficient wallet error displays truthful banner without dismissing offer (Gate B5)', (tester) async {
      final offer = createTestOffer(commissionPaise: 50000); // ₹500.00
      final fakeService = FakeOfferService();

      // Simulate backend rejecting with INSUFFICIENT_WALLET_BALANCE
      fakeService.acceptErrorToThrow = const OfferActionException(
        code: 'INSUFFICIENT_WALLET_BALANCE',
        message: 'Wallet balance insufficient for commission',
      );

      await tester.pumpWidget(
        createTestWidget(
          child: Scaffold(
            body: IncomingOfferSheet(
              offer: offer,
              offerService: fakeService,
              clock: () => now,
            ),
          ),
        ),
      );
      await tester.pump();

      // Tap ACCEPT
      await tester.tap(find.byKey(const ValueKey('accept_offer_button')));
      await tester.pumpAndSettle();

      // Insufficient balance banner is shown with exact required deposit
      expect(find.byKey(const ValueKey('insufficient_balance_banner')), findsOneWidget);
      expect(find.textContaining('Deposit ₹500.00 to accept this offer'), findsOneWidget);

      // CRITICAL INVARIANT: The offer is NOT locally dismissed or fabricated as resolved!
      expect(find.byKey(const ValueKey('accept_offer_button')), findsOneWidget);
      expect(find.byKey(const ValueKey('decline_offer_button')), findsOneWidget);

      // The driver can still DECLINE the offer
      fakeService.acceptErrorToThrow = null;
      await tester.tap(find.byKey(const ValueKey('decline_offer_button')));
      await tester.pumpAndSettle();

      expect(fakeService.declineCallCount, equals(1));
    });

    testWidgets('DECLINE action dispatches declineOffer with requestId', (tester) async {
      final offer = createTestOffer();
      final fakeService = FakeOfferService();

      await tester.pumpWidget(
        createTestWidget(
          child: Scaffold(
            body: IncomingOfferSheet(
              offer: offer,
              offerService: fakeService,
              clock: () => now,
            ),
          ),
        ),
      );
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey('decline_offer_button')));
      await tester.pumpAndSettle();

      expect(fakeService.declineCallCount, equals(1));
      expect(fakeService.capturedDeclineRequestIds.length, equals(1));
      expect(fakeService.capturedDeclineRequestIds.first, isNotEmpty);
    });

    testWidgets('F08: 360dp width layout has zero overflow across EN, HI, MR', (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final offer = createTestOffer();
      final fakeService = FakeOfferService();

      for (final locale in ['en', 'hi', 'mr']) {
        await tester.pumpWidget(
          createTestWidget(
            locale: Locale(locale),
            child: Scaffold(
              body: SingleChildScrollView(
                child: IncomingOfferSheet(
                  offer: offer,
                  offerService: fakeService,
                  clock: () => now,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull,
            reason: '360dp layout in locale $locale must not throw RenderFlex overflow');
      }
    });
  });
}
