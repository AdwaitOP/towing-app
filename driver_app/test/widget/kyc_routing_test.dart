// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'package:driver_app/app/session_resolver.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/profile_service.dart';
import 'package:driver_app/features/auth/screens/phone_login_screen.dart';
import 'package:driver_app/features/home/screens/stage1_home_screen.dart';
import 'package:driver_app/features/kyc/flow/kyc_flow.dart';
import 'package:driver_app/features/kyc/screens/kyc_consent_screen.dart';
import 'package:driver_app/features/kyc/screens/kyc_pending_screen.dart';
import 'package:driver_app/features/kyc/screens/kyc_rejected_screen.dart';
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

class MockAuthService extends AuthService {
  User? mockUser;
  bool signOutCalled = false;

  @override
  User? get currentUser => mockUser;

  @override
  Stream<User?> get authStateChanges => Stream.value(mockUser);

  @override
  Future<void> signOut() async {
    signOutCalled = true;
  }
}

class MockProfileService extends ProfileService {
  ProfileState stateToEmit;
  MockProfileService(this.stateToEmit);

  @override
  Stream<ProfileState> streamProfileState(String uid) {
    return Stream.value(stateToEmit);
  }
}

class StreamProfileService extends ProfileService {
  final StreamController<ProfileState> controller;
  StreamProfileService(this.controller);

  @override
  Stream<ProfileState> streamProfileState(String uid) {
    return controller.stream;
  }
}

void main() {
  group('SessionResolver Stage 2 KYC Routing Matrix', () {
    late MockAuthService authService;
    final testUser = FakeUser(uid: 'driver_kyc_test_1', phoneNumber: '+919876543210');

    setUp(() {
      authService = MockAuthService();
      authService.mockUser = testUser;
    });

    testWidgets('unsubmitted KYC (verificationStatus null) routes to KycConsentScreen', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const profile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: null,
      );

      final profileService = MockProfileService(const ProfileCompleted(profile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(KycConsentScreen), findsOneWidget);
      expect(find.byType(KycPendingScreen), findsNothing);
      expect(find.byType(KycRejectedScreen), findsNothing);
      expect(find.byType(Stage1HomeScreen), findsNothing);
      expect(find.text('Driver Verification'), findsWidgets);
    });

    testWidgets('pending KYC (verificationStatus: "pending") routes to KycPendingScreen', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const profile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: 'pending',
      );

      final profileService = MockProfileService(const ProfileCompleted(profile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(KycPendingScreen), findsOneWidget);
      expect(find.byType(KycConsentScreen), findsNothing);
      expect(find.byType(KycRejectedScreen), findsNothing);
      expect(find.byType(Stage1HomeScreen), findsNothing);
      expect(find.text('Verification Under Review'), findsOneWidget);
    });

    testWidgets('rejected KYC (verificationStatus: "rejected") routes to KycRejectedScreen', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const profile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: 'rejected',
        rejectionReason: 'RC image was blurry',
      );

      final profileService = MockProfileService(const ProfileCompleted(profile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(KycRejectedScreen), findsOneWidget);
      expect(find.byType(KycPendingScreen), findsNothing);
      expect(find.byType(KycConsentScreen), findsNothing);
      expect(find.byType(Stage1HomeScreen), findsNothing);
      expect(find.text('Verification Rejected'), findsOneWidget);
      expect(find.text('RC image was blurry'), findsOneWidget);
    });

    testWidgets('approved KYC (verificationStatus: "approved") routes to Stage1HomeScreen', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const profile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: 'approved',
      );

      final profileService = MockProfileService(const ProfileCompleted(profile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(Stage1HomeScreen), findsOneWidget);
      expect(find.byType(KycConsentScreen), findsNothing);
      expect(find.byType(KycPendingScreen), findsNothing);
      expect(find.byType(KycRejectedScreen), findsNothing);
      expect(find.text('Driver app setup complete'), findsOneWidget);
      expect(find.text('Rahul Dravid'), findsOneWidget);
    });

    testWidgets('legacy verificationStatus: "verified" is rejected with FormatException and fails closed to ProfileMalformed', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final rawDoc = {
        'uid': 'driver_kyc_test_1',
        'name': 'Rahul Dravid',
        'phone': '+919876543210',
        'truckType': 'flatbed',
        'vehicleNumber': 'KA 03 MH 9999',
        'isOnDuty': false,
        'verificationStatus': 'verified', // Forbidden legacy field
      };

      // Strict parser rejection
      expect(
        () => DriverProfile.fromMap(rawDoc, 'driver_kyc_test_1'),
        throwsA(isA<FormatException>()),
      );

      // Downstream SessionResolver routes ProfileMalformed to fail-closed error screen (neither Home nor Setup)
      final profileService = MockProfileService(
        const ProfileMalformed('Driver profile contains invalid verificationStatus: "verified"'),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(Stage1HomeScreen), findsNothing);
      expect(find.byType(KycConsentScreen), findsNothing);
      expect(find.byType(KycPendingScreen), findsNothing);
      expect(find.byType(KycRejectedScreen), findsNothing);
      expect(find.text('Driver profile data is invalid. Please contact support.'), findsOneWidget);
    });

    testWidgets('live reactive transition from unsubmitted to pending to approved', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final streamController = StreamController<ProfileState>.broadcast();
      final profileService = StreamProfileService(streamController);

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pump();

      // 1. Initial unsubmitted profile
      const unsubmittedProfile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: null,
      );
      streamController.add(const ProfileCompleted(unsubmittedProfile));
      await tester.pump();

      expect(find.byType(KycConsentScreen), findsOneWidget);
      expect(find.byType(KycPendingScreen), findsNothing);

      // 2. Submission occurs -> profile becomes pending
      const pendingProfile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: 'pending',
      );
      streamController.add(const ProfileCompleted(pendingProfile));
      await tester.pump();

      expect(find.byType(KycConsentScreen), findsNothing);
      expect(find.byType(KycPendingScreen), findsOneWidget);

      // 3. Admin approves -> profile becomes approved
      const approvedProfile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: 'approved',
      );
      streamController.add(const ProfileCompleted(approvedProfile));
      await tester.pump();

      expect(find.byType(KycPendingScreen), findsNothing);
      expect(find.byType(Stage1HomeScreen), findsOneWidget);
      expect(find.text('Driver app setup complete'), findsOneWidget);

      await streamController.close();
    });

    testWidgets('live reactive transition from pending to rejected', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final streamController = StreamController<ProfileState>.broadcast();
      final profileService = StreamProfileService(streamController);

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pump();

      // Emit pending
      const pendingProfile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: 'pending',
      );
      streamController.add(const ProfileCompleted(pendingProfile));
      await tester.pump();

      expect(find.byType(KycPendingScreen), findsOneWidget);

      // Admin rejects with reason
      const rejectedProfile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: 'rejected',
        rejectionReason: 'Expired license',
      );
      streamController.add(const ProfileCompleted(rejectedProfile));
      await tester.pump();

      expect(find.byType(KycPendingScreen), findsNothing);
      expect(find.byType(KycRejectedScreen), findsOneWidget);
      expect(find.text('Expired license'), findsOneWidget);

      await streamController.close();
    });

    testWidgets('unsubmitted KYC mounts KycFlow with session-scoped ValueKey', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const profile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: null,
      );

      final profileService = MockProfileService(const ProfileCompleted(profile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(KycFlow), findsOneWidget);
      expect(find.byKey(const ValueKey('kyc_flow_driver_kyc_test_1_unsubmitted')), findsOneWidget);
    });

    testWidgets('rejected KYC mounts KycFlow with rejected ValueKey', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const profile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: 'rejected',
        rejectionReason: 'Invalid document',
      );

      final profileService = MockProfileService(const ProfileCompleted(profile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(KycFlow), findsOneWidget);
      expect(find.byKey(const ValueKey('kyc_flow_driver_kyc_test_1_rejected')), findsOneWidget);
    });

    testWidgets('user logout unmounts KycFlow and routes to PhoneLoginScreen', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final authStreamController = StreamController<User?>();
      final dynamicAuthService = _DynamicAuthService(authStreamController, testUser);

      const profile = DriverProfile(
        uid: 'driver_kyc_test_1',
        name: 'Rahul Dravid',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'KA 03 MH 9999',
        verificationStatus: null,
      );

      final profileService = MockProfileService(const ProfileCompleted(profile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: dynamicAuthService,
            profileService: profileService,
          ),
        ),
      );
      authStreamController.add(testUser);
      await tester.pumpAndSettle();

      expect(find.byType(KycFlow), findsOneWidget);

      // Sign out
      await dynamicAuthService.signOut();
      await tester.pumpAndSettle();

      // KycFlow unmounted, PhoneLoginScreen rendered
      expect(find.byType(KycFlow), findsNothing);
      expect(find.byType(PhoneLoginScreen), findsOneWidget);

      await authStreamController.close();
    });
  });
}

class _DynamicAuthService extends AuthService {
  final StreamController<User?> controller;
  User? _currentUser;
  _DynamicAuthService(this.controller, this._currentUser);

  @override
  User? get currentUser => _currentUser;

  @override
  Stream<User?> get authStateChanges => controller.stream;

  @override
  Future<void> signOut() async {
    _currentUser = null;
    controller.add(null);
  }
}
