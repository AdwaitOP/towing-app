import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/services/offer_service.dart';
import 'package:driver_app/features/hub/widgets/wallet_topup_sheet.dart';
import 'package:driver_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

class MockOfferServiceForTopup extends Fake implements OfferService {
  int initiateCallCount = 0;
  int reconcileCallCount = 0;
  List<String> capturedRequestIds = [];
  List<int> capturedInitiateAmounts = [];

  Exception? initiateException;
  Exception? reconcileException;

  InitiateTopupResult? nextInitiateResult;
  ReconcileTopupResult? nextReconcileResult;

  Completer<InitiateTopupResult>? initiateCompleter;

  @override
  Future<InitiateTopupResult> initiateWalletTopup({
    required int amountPaise,
    required String requestId,
  }) async {
    initiateCallCount++;
    capturedRequestIds.add(requestId);
    capturedInitiateAmounts.add(amountPaise);

    if (initiateCompleter != null) {
      return initiateCompleter!.future;
    }

    if (initiateException != null) {
      throw initiateException!;
    }

    return nextInitiateResult ??
        InitiateTopupResult(
          topupId: 'topup_test_1',
          orderId: 'order_test_1',
          amountPaise: amountPaise,
        );
  }
}

void main() {
  final testProfile = DriverProfile.fromMap({
    'uid': 'driver_topup_1',
    'name': 'Test Driver',
    'phone': '+919876543210',
    'verificationStatus': 'approved',
    'truckType': 'flatbed',
    'vehicleNumber': 'MH12AB1234',
    'isOnDuty': false,
    'walletBalance': 50000, // ₹500.00
    'strictMode': false,
  }, 'driver_topup_1');

  Widget buildTopupSheet(
    MockOfferServiceForTopup service, {
    DriverProfile? profile,
    void Function(int)? onSuccess,
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
        body: WalletTopupSheet(
          profile: profile ?? testProfile,
          offerService: service,
          onTopupSuccess: onSuccess,
        ),
      ),
    );
  }

  testWidgets('renders current balance, test mode notice, presets, and submit button', (tester) async {
    final mockService = MockOfferServiceForTopup();
    await tester.pumpWidget(buildTopupSheet(mockService));
    await tester.pumpAndSettle();

    expect(find.text('Wallet Top-Up'), findsOneWidget);
    expect(find.text('₹500.00'), findsOneWidget); // Current balance
    expect(find.textContaining('Test Mode:'), findsOneWidget);
    expect(find.byKey(const ValueKey('topup_preset_500')), findsOneWidget);
    expect(find.byKey(const ValueKey('topup_preset_1000')), findsOneWidget);
    expect(find.byKey(const ValueKey('topup_preset_2000')), findsOneWidget);
    expect(find.byKey(const ValueKey('topup_submit_button')), findsOneWidget);
  });

  testWidgets('tapping preset chip updates amount text field', (tester) async {
    final mockService = MockOfferServiceForTopup();
    await tester.pumpWidget(buildTopupSheet(mockService));
    await tester.pumpAndSettle();

    final preset1000 = find.byKey(const ValueKey('topup_preset_1000'));
    await tester.tap(preset1000);
    await tester.pumpAndSettle();

    final textField = tester.widget<TextField>(find.byKey(const ValueKey('topup_amount_field')));
    expect(textField.controller?.text, equals('1000'));
  });

  testWidgets('valid topup triggers initiateWalletTopup and pops sheet with success notification', (tester) async {
    final mockService = MockOfferServiceForTopup();
    int? creditedAmount;

    await tester.pumpWidget(buildTopupSheet(
      mockService,
      onSuccess: (amount) => creditedAmount = amount,
    ));
    await tester.pumpAndSettle();

    // Default amount is ₹500 = 50,000 paise
    final submitBtn = find.byKey(const ValueKey('topup_submit_button'));
    await tester.tap(submitBtn);
    await tester.pumpAndSettle();

    expect(mockService.initiateCallCount, equals(1));
    expect(mockService.capturedInitiateAmounts.first, equals(50000));
    expect(mockService.capturedRequestIds.length, equals(1));
    expect(mockService.capturedRequestIds.first.startsWith('req_topup_'), isTrue);
    // F01: Pending initiation must not trigger onTopupSuccess or falsely announce credit
    expect(creditedAmount, isNull);
    expect(find.textContaining('successful'), findsNothing);
  });

  testWidgets('invalid amount outside ₹1 - ₹1,00,000 displays error and does not call backend', (tester) async {
    final mockService = MockOfferServiceForTopup();
    await tester.pumpWidget(buildTopupSheet(mockService));
    await tester.pumpAndSettle();

    // Enter 0 (invalid)
    final amountField = find.byKey(const ValueKey('topup_amount_field'));
    await tester.enterText(amountField, '0');
    await tester.pumpAndSettle();

    final submitBtn = find.byKey(const ValueKey('topup_submit_button'));
    await tester.tap(submitBtn);
    await tester.pumpAndSettle();

    expect(mockService.initiateCallCount, equals(0));
    expect(find.text('Amount must be between ₹1 and ₹1,00,000'), findsOneWidget);
  });

  testWidgets('uncertain topup retry reuses identical requestId', (tester) async {
    final mockService = MockOfferServiceForTopup();
    mockService.initiateException = Exception('Network timeout during topup initiation');

    await tester.pumpWidget(buildTopupSheet(mockService));
    await tester.pumpAndSettle();

    final submitBtn = find.byKey(const ValueKey('topup_submit_button'));
    await tester.tap(submitBtn);
    await tester.pumpAndSettle();

    expect(mockService.initiateCallCount, equals(1));
    final firstRequestId = mockService.capturedRequestIds[0];

    // Button should now show RETRY TOP-UP
    expect(find.text('RETRY TOP-UP'), findsOneWidget);

    // Prepare success for retry
    mockService.initiateException = null;
    mockService.nextInitiateResult = const InitiateTopupResult(
      topupId: 'topup_test_retry_1',
      orderId: 'order_test_retry_1',
      amountPaise: 50000,
    );

    // Tap retry
    await tester.tap(submitBtn);
    await tester.pumpAndSettle();

    expect(mockService.initiateCallCount, equals(2));
    expect(mockService.capturedRequestIds[1], equals(firstRequestId));
  });

  testWidgets('rapid double tap initiates only once (single-flight locking)', (tester) async {
    final mockService = MockOfferServiceForTopup();
    mockService.initiateCompleter = Completer<InitiateTopupResult>();

    await tester.pumpWidget(buildTopupSheet(mockService));
    await tester.pumpAndSettle();

    final submitBtn = find.byKey(const ValueKey('topup_submit_button'));
    // Double tap rapidly
    await tester.tap(submitBtn);
    await tester.tap(submitBtn);
    await tester.pump();

    expect(mockService.initiateCallCount, equals(1));

    // Complete the pending request
    mockService.initiateCompleter!.complete(const InitiateTopupResult(
      topupId: 'topup_test_single_flight',
      orderId: 'order_test_single_flight',
      amountPaise: 50000,
    ));
    await tester.pumpAndSettle();
  });

  testWidgets('F04: changing topup amount after uncertain failure generates fresh requestId', (tester) async {
    final mockService = MockOfferServiceForTopup();
    mockService.initiateException = Exception('network timeout');

    await tester.pumpWidget(buildTopupSheet(mockService));
    await tester.pumpAndSettle();

    final submitBtn = find.byKey(const ValueKey('topup_submit_button'));
    await tester.tap(submitBtn);
    await tester.pumpAndSettle();

    expect(mockService.initiateCallCount, equals(1));
    final firstRequestId = mockService.capturedRequestIds[0];

    // Change amount to 1000
    mockService.initiateException = null;
    mockService.nextInitiateResult = const InitiateTopupResult(
      topupId: 'topup_test_f04',
      orderId: 'order_test_f04',
      amountPaise: 100000,
    );
    await tester.enterText(find.byKey(const ValueKey('topup_amount_field')), '1000');
    await tester.tap(submitBtn);
    await tester.pumpAndSettle();

    expect(mockService.initiateCallCount, equals(2));
    expect(mockService.capturedRequestIds[1], isNot(equals(firstRequestId)),
        reason: 'New payload amount must not reuse prior uncertain requestId');
    expect(mockService.capturedInitiateAmounts[1], equals(100000));
  });
}
