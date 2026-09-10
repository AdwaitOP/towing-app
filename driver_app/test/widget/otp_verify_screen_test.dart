import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/features/auth/controllers/auth_controller.dart';
import 'package:driver_app/features/auth/screens/otp_verify_screen.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helper.dart';

class MockAuthService extends AuthService {
  @override
  Future<void> sendOtp(String phone) async {}

  @override
  Future<UserCredential> verifyOtp(String phone, String otp) async {
    throw UnimplementedError();
  }
}

void main() {
  group('OtpVerifyScreen Widget Tests', () {
    late AuthController controller;

    setUp(() {
      controller = AuthController(authService: MockAuthService());
    });

    tearDown(() {
      controller.dispose();
    });

    testWidgets('renders OTP entry header, phone, and buttons', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: OtpVerifyScreen(
            controller: controller,
            phone: '+919876543210',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Enter 6-Digit OTP'), findsOneWidget);
      expect(find.text('OTP sent via WhatsApp to +919876543210'), findsOneWidget);
      expect(find.text('Verify OTP'), findsAtLeastNWidgets(1));
      expect(find.text('Resend OTP'), findsOneWidget);
    });

    testWidgets('validates OTP length on submission', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: OtpVerifyScreen(
            controller: controller,
            phone: '+919876543210',
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Enter 3 digits only
      await tester.enterText(find.byType(TextFormField), '123');
      await tester.tap(find.widgetWithText(ElevatedButton, 'Verify OTP'));
      await tester.pumpAndSettle();

      expect(find.text('Please enter a valid 6-digit OTP'), findsOneWidget);
    });

    testWidgets('shows countdown and disables resend when cooldown active', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: OtpVerifyScreen(
            controller: controller,
            phone: '+919876543210',
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Initially resend is enabled
      expect(find.text('Resend OTP'), findsOneWidget);

      // Trigger OTP send to start cooldown timer
      await controller.sendOtp('9876543210');
      await tester.pump();

      // Now cooldown countdown should be visible
      expect(find.textContaining('Resend in'), findsOneWidget);

      // Clean up timer before test finishes
      controller.reset();
    });
  });
}
