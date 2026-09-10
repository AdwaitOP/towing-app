import 'dart:async';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/features/auth/controllers/auth_controller.dart';
import 'package:driver_app/features/auth/screens/phone_login_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helper.dart';

class MockAuthService extends AuthService {
  Completer<void>? pendingSendOtp;

  @override
  Future<void> sendOtp(String phone) {
    if (pendingSendOtp != null) {
      return pendingSendOtp!.future;
    }
    return Future.value();
  }
}

void main() {
  group('PhoneLoginScreen Widget Tests', () {
    late AuthController controller;

    setUp(() {
      controller = AuthController(authService: MockAuthService());
    });

    testWidgets('renders phone login elements and +91 prefix', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: PhoneLoginScreen(controller: controller),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Towing Driver'), findsAtLeastNWidgets(1));
      expect(find.text('+91'), findsOneWidget);
      expect(find.text('Send OTP'), findsOneWidget);
      expect(find.byType(ElevatedButton), findsOneWidget);
    });

    testWidgets('shows validation error when tapping Send OTP with empty or invalid phone', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: PhoneLoginScreen(controller: controller),
        ),
      );
      await tester.pumpAndSettle();

      // Tap Send OTP without entering phone
      await tester.tap(find.byType(ElevatedButton));
      await tester.pumpAndSettle();

      expect(find.text('Please enter a valid 10-digit mobile number'), findsOneWidget);

      // Enter invalid phone (< 10 digits)
      await tester.enterText(find.byType(TextFormField), '12345');
      await tester.tap(find.byType(ElevatedButton));
      await tester.pumpAndSettle();

      expect(find.text('Please enter a valid 10-digit mobile number'), findsOneWidget);
    });

    testWidgets('disables button when controller is loading', (tester) async {
      final mockAuth = MockAuthService();
      final completer = Completer<void>();
      mockAuth.pendingSendOtp = completer;
      final loadingController = AuthController(authService: mockAuth);

      await tester.pumpWidget(
        createTestWidget(
          child: PhoneLoginScreen(controller: loadingController),
        ),
      );
      await tester.pumpAndSettle();

      // Simulate loading state
      loadingController.sendOtp('9876543210');
      await tester.pump();

      final button = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(button.onPressed, isNull);

      // Clean up
      completer.complete();
      await tester.pumpAndSettle();
      loadingController.reset();
    });
  });
}
