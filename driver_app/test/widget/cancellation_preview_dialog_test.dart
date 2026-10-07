import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/job_offer.dart';
import 'package:driver_app/core/services/offer_service.dart';
import 'package:driver_app/features/hub/widgets/cancellation_preview_dialog.dart';
import 'package:driver_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

class MockOfferServiceForCancel extends Fake implements OfferService {
  int cancelCallCount = 0;
  List<String> capturedRequestIds = [];
  CancelJobResult? nextResult;
  Exception? nextException;

  @override
  Future<CancelJobResult> cancelJob({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    cancelCallCount++;
    capturedRequestIds.add(requestId);

    if (nextException != null) {
      throw nextException!;
    }

    return nextResult ??
        CancelJobResult(
          cancelled: true,
          jobId: jobId,
          offerId: offerId,
          driverId: 'driver_test_1',
          forfeitedPaise: 0,
          refundPaise: 5000,
        );
  }
}

void main() {
  final testClock = DateTime.utc(2026, 10, 6, 10, 0, 0);

  final testOffer = JobOffer(
    id: 'offer_cancel_1',
    jobId: 'job_cancel_1',
    driverId: 'driver_test_1',
    dispatchGeneration: 1,
    candidateIndex: 0,
    roundIndex: 0,
    status: JobOfferStatus.accepted,
    offeredAt: DateTime.utc(2026, 10, 6, 10, 0, 0),
    expiresAt: DateTime.utc(2026, 10, 6, 10, 0, 45),
    acceptedAt: DateTime.utc(2026, 10, 6, 10, 0, 10),
    acceptRequestId: 'req_accept_1',
    pickupCoords: const OfferCoordinates(lat: 18.5204, lng: 73.8567),
    destCoords: const OfferCoordinates(lat: 18.5304, lng: 73.8667),
    requestedTruckType: 'flatbed',
    estimatedFarePaise: 50000,
    driverCommissionPaise: 5000, // ₹50.00
    cancellationPolicySnapshot: const {
      'freeCancellationsPerMonth': 1,
      'banThresholdCount': 3,
      'forfeitPctByCount': {'2': 50},
      'version': 1,
      'timezone': 'Asia/Kolkata',
      'roundingMode': 'HALF_UP',
    },
  );

  final testProfile = DriverProfile.fromMap({
    'uid': 'driver_test_1',
    'name': 'Test Driver',
    'phone': '+919876543210',
    'verificationStatus': 'approved',
    'truckType': 'flatbed',
    'vehicleNumber': 'MH12AB1234',
    'isOnDuty': true,
    'walletBalance': 50000,
    'monthlyCancelCount': {
      'month': '2026-10',
      'count': 0,
    },
    'strictMode': false,
  }, 'driver_test_1');

  Widget buildDialog(
    MockOfferServiceForCancel service, {
    DriverProfile? profile,
    void Function(CancelJobResult)? onCancelled,
  }) {
    return MaterialApp(
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [Locale('en')],
      home: Scaffold(
        body: CancellationPreviewDialog(
          offer: testOffer,
          profile: profile ?? testProfile,
          offerService: service,
          clock: () => testClock,
          onCancelled: onCancelled ?? (_) {},
        ),
      ),
    );
  }

  testWidgets('renders non-authoritative preview calculation with free cancellation remaining', (tester) async {
    final mockService = MockOfferServiceForCancel();
    await tester.pumpWidget(buildDialog(mockService));
    await tester.pumpAndSettle();

    expect(find.text('Cancellation Preview'), findsOneWidget);
    // Non-authoritative disclaimer notice present
    expect(find.textContaining('Estimated preview'), findsOneWidget);
    // Free remaining = 1 (1 - 0)
    expect(find.textContaining('Free cancellations remaining: 1'), findsOneWidget);
    // 0% forfeit estimated
    expect(find.textContaining('Estimated Forfeiture: ₹0.00'), findsOneWidget);
    expect(find.textContaining('Estimated Refund: ₹50.00'), findsOneWidget);
    // Ban warning should NOT be shown
    expect(find.byIcon(Icons.block), findsNothing);
  });

  testWidgets('displays ban warning and penalty when threshold or strictMode is active', (tester) async {
    final mockService = MockOfferServiceForCancel();
    final strictProfile = DriverProfile.fromMap({
      'uid': 'driver_test_1',
      'name': 'Strict Driver',
      'phone': '+919876543210',
      'verificationStatus': 'approved',
      'truckType': 'flatbed',
      'vehicleNumber': 'MH12AB1234',
      'isOnDuty': true,
      'walletBalance': 50000,
      'monthlyCancelCount': {
        'month': '2026-10',
        'count': 2,
      },
      'strictMode': true,
    }, 'driver_test_1');

    await tester.pumpWidget(buildDialog(mockService, profile: strictProfile));
    await tester.pumpAndSettle();

    // Strict mode active warning shown
    expect(find.textContaining('Strict Mode Active: Next cancellation incurs 100% penalty'), findsOneWidget);
    expect(find.textContaining('Estimated Forfeiture: ₹50.00'), findsOneWidget);
    expect(find.textContaining('Estimated Refund: ₹0.00'), findsOneWidget);
  });

  testWidgets('pressing CONFIRM CANCELLATION triggers cancelJob with unique requestId', (tester) async {
    final mockService = MockOfferServiceForCancel();
    CancelJobResult? deliveredResult;

    await tester.pumpWidget(buildDialog(
      mockService,
      onCancelled: (res) => deliveredResult = res,
    ));
    await tester.pumpAndSettle();

    final confirmBtn = find.byKey(const ValueKey('confirm_cancellation_button'));
    await tester.tap(confirmBtn);
    await tester.pumpAndSettle();

    expect(mockService.cancelCallCount, equals(1));
    expect(mockService.capturedRequestIds.length, equals(1));
    expect(mockService.capturedRequestIds.first.startsWith('req_cancel_'), isTrue);
    expect(deliveredResult, isNotNull);
    expect(deliveredResult!.cancelled, isTrue);
  });

  testWidgets('uncertain cancel retry reuses identical requestId', (tester) async {
    final mockService = MockOfferServiceForCancel();
    mockService.nextException = Exception('Network timeout during cancel');

    await tester.pumpWidget(buildDialog(mockService));
    await tester.pumpAndSettle();

    final confirmBtn = find.byKey(const ValueKey('confirm_cancellation_button'));
    await tester.tap(confirmBtn);
    await tester.pumpAndSettle();

    expect(mockService.cancelCallCount, equals(1));
    final firstRequestId = mockService.capturedRequestIds[0];

    // Button should now read RETRY CANCEL and error is displayed
    expect(find.text('RETRY CANCEL'), findsOneWidget);

    // Prepare success for retry
    mockService.nextException = null;
    mockService.nextResult = CancelJobResult(
      cancelled: true,
      jobId: 'job_cancel_1',
      offerId: 'offer_cancel_1',
      driverId: 'driver_test_1',
      forfeitedPaise: 0,
      refundPaise: 5000,
    );

    // Tap retry
    await tester.tap(confirmBtn);
    await tester.pumpAndSettle();

    expect(mockService.cancelCallCount, equals(2));
    // RequestId MUST be identical across retries
    expect(mockService.capturedRequestIds[1], equals(firstRequestId));
  });

  testWidgets('customer cancellation overlap is handled truthfully and non-penalizing', (tester) async {
    final mockService = MockOfferServiceForCancel();
    mockService.nextResult = const CancelJobResult(
      cancelled: false,
      reason: 'customer_cancellation_in_progress',
      jobId: 'job_cancel_1',
      offerId: 'offer_cancel_1',
      driverId: 'driver_test_1',
      forfeitedPaise: 0,
      refundPaise: 0,
    );

    CancelJobResult? deliveredResult;
    await tester.pumpWidget(buildDialog(
      mockService,
      onCancelled: (res) => deliveredResult = res,
    ));
    await tester.pumpAndSettle();

    final confirmBtn = find.byKey(const ValueKey('confirm_cancellation_button'));
    await tester.tap(confirmBtn);
    await tester.pumpAndSettle();

    expect(mockService.cancelCallCount, equals(1));
    expect(deliveredResult, isNotNull);
    expect(deliveredResult!.isCustomerCancelled, isTrue);
  });
}
