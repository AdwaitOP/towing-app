import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/features/home/screens/stage1_home_screen.dart';
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
  group('Stage1HomeScreen Widget Tests', () {
    const profile = DriverProfile(
      uid: 'driver_uid_999',
      name: 'Amit Deshmukh',
      phone: '+919876543210',
      truckType: TruckType.crane,
      vehicleNumber: 'MH 46 AB 9999',
      isOnDuty: false,
    );

    testWidgets('renders profile summary and Stage 1 setup completion banner', (tester) async {
      final authService = MockAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: Stage1HomeScreen(
            profile: profile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver app setup complete'), findsOneWidget);
      expect(find.text('Amit Deshmukh'), findsOneWidget);
      expect(find.text('+919876543210'), findsOneWidget);
      expect(find.text('Crane Recovery'), findsOneWidget);
      expect(find.text('MH 46 AB 9999'), findsOneWidget);
      expect(find.text('Duty Status'), findsOneWidget);
      expect(find.text('Off Duty'), findsOneWidget);
    });

    testWidgets('renders Hindi Duty Status label and does not render English', (tester) async {
      final authService = MockAuthService();

      await tester.pumpWidget(
        createTestWidget(
          locale: const Locale('hi'),
          child: Stage1HomeScreen(
            profile: profile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('ड्यूटी स्थिति'), findsOneWidget);
      expect(find.text('Duty Status'), findsNothing);
      expect(find.text('ड्यूटी बंद'), findsOneWidget);
      expect(find.text('ड्राइवर ऐप सेटअप पूरा हुआ'), findsOneWidget);
    });

    testWidgets('renders Marathi Duty Status label and does not render English', (tester) async {
      final authService = MockAuthService();

      await tester.pumpWidget(
        createTestWidget(
          locale: const Locale('mr'),
          child: Stage1HomeScreen(
            profile: profile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('ड्युटी स्थिती'), findsOneWidget);
      expect(find.text('Duty Status'), findsNothing);
      expect(find.text('ड्युटी बंद'), findsOneWidget);
      expect(find.text('ड्रायव्हर ॲप सेटअप पूर्ण झाले'), findsOneWidget);
    });

    testWidgets('logout button invokes authService.signOut()', (tester) async {
      final authService = MockAuthService();

      await tester.pumpWidget(
        createTestWidget(
          child: Stage1HomeScreen(
            profile: profile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Tap the logout button in AppBar
      await tester.tap(find.byType(IconButton));
      await tester.pumpAndSettle();

      expect(authService.signOutCalled, isTrue);
    });
  });
}
