import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/features/profile/controllers/profile_controller.dart';
import 'package:driver_app/features/profile/screens/profile_setup_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helper.dart';

class MockAuthService extends AuthService {
  bool signOutCalled = false;
  @override
  Future<void> signOut() async {
    signOutCalled = true;
  }
}

void main() {
  group('ProfileSetupScreen Widget Tests', () {
    late ProfileController controller;
    late MockAuthService authService;

    setUp(() {
      controller = ProfileController();
      authService = MockAuthService();
    });

    testWidgets('renders all profile fields and read-only phone', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: ProfileSetupScreen(
            uid: 'test_uid_123',
            phone: '+919876543210',
            controller: controller,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver Profile Setup'), findsAtLeastNWidgets(1));
      expect(find.text('+919876543210'), findsOneWidget);
      expect(find.text('Full Name'), findsOneWidget);
      expect(find.text('Tow Truck Type'), findsOneWidget);
      expect(find.text('Vehicle Registration Number'), findsOneWidget);
      expect(find.text('Continue'), findsOneWidget);
    });

    testWidgets('validates required fields on submission', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: ProfileSetupScreen(
            uid: 'test_uid_123',
            phone: '+919876543210',
            controller: controller,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Tap Continue with empty fields
      final continueButton = find.widgetWithText(ElevatedButton, 'Continue');
      await tester.ensureVisible(continueButton);
      await tester.tap(continueButton);
      await tester.pumpAndSettle();

      expect(find.text('Full name is required'), findsOneWidget);
      expect(find.text('Vehicle number is required'), findsOneWidget);
    });

    testWidgets('allows selecting different truck types', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: ProfileSetupScreen(
            uid: 'test_uid_123',
            phone: '+919876543210',
            controller: controller,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(controller.selectedTruckType, equals(TruckType.flatbed));

      // Open dropdown
      await tester.tap(find.byType(DropdownButtonFormField<TruckType>));
      await tester.pumpAndSettle();

      // Select Hydraulic Lift
      await tester.tap(find.text('Hydraulic Lift').last);
      await tester.pumpAndSettle();

      expect(controller.selectedTruckType, equals(TruckType.hydraulic));
    });

    testWidgets('logout button in AppBar triggers signOut', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: ProfileSetupScreen(
            uid: 'test_uid_123',
            phone: '+919876543210',
            controller: controller,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byIcon(Icons.logout));
      await tester.pump();

      expect(authService.signOutCalled, isTrue);
    });
  });
}
