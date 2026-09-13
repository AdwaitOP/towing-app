import 'dart:async';
import 'dart:io';
import 'package:camera/camera.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/kyc_error_category.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/kyc_service.dart';
import 'package:driver_app/features/kyc/controllers/kyc_controller.dart';
import 'package:driver_app/features/kyc/screens/kyc_camera_screen.dart';
import 'package:driver_app/features/kyc/screens/kyc_consent_screen.dart';
import 'package:driver_app/features/kyc/screens/kyc_pending_screen.dart';
import 'package:driver_app/features/kyc/screens/kyc_rejected_screen.dart';
import 'package:driver_app/features/kyc/screens/kyc_review_screen.dart';
import 'package:driver_app/l10n/app_localizations.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helper.dart';

// ignore: subtype_of_sealed_class
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

class MockKycService extends KycService {
  @override
  Future<void> uploadKycFile({
    required String driverUid,
    required String filename,
    required File file,
  }) async {}

  @override
  Future<Map<String, dynamic>> submitDriverVerification() async {
    return {'success': true, 'status': 'pending'};
  }
}

// Minimal valid 1x1 transparent PNG bytes
final kMinimal1x1PngBytes = [
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

class FakeCameraController extends CameraController {
  final CameraDescription _cameraDesc;

  FakeCameraController({
    CameraDescription? description,
    this.onInitialize,
    this.onTakePicture,
    this.onDispose,
  })  : _cameraDesc = description ??
            const CameraDescription(
              name: 'back',
              lensDirection: CameraLensDirection.back,
              sensorOrientation: 90,
            ),
        super(
          description ??
              const CameraDescription(
                name: 'back',
                lensDirection: CameraLensDirection.back,
                sensorOrientation: 90,
              ),
          ResolutionPreset.high,
          enableAudio: false,
        );

  final Future<void> Function()? onInitialize;
  final Future<XFile> Function()? onTakePicture;
  final Future<void> Function()? onDispose;

  bool _isInit = false;
  int disposeCallCount = 0;
  bool isDisposed = false;

  @override
  CameraDescription get description => _cameraDesc;

  @override
  CameraValue get value => CameraValue.uninitialized(_cameraDesc).copyWith(
        isInitialized: _isInit,
        previewSize: const Size(1920, 1080),
      );

  @override
  Future<void> initialize() async {
    if (onInitialize != null) {
      await onInitialize!();
    }
    _isInit = true;
  }

  @override
  Future<XFile> takePicture() async {
    if (onTakePicture != null) {
      return await onTakePicture!();
    }
    return XFile('fake_capture.jpg');
  }

  @override
  Widget buildPreview() {
    return const SizedBox(width: 100, height: 100, key: ValueKey('fake_camera_preview'));
  }

  @override
  Future<void> dispose() async {
    disposeCallCount++;
    isDisposed = true;
    _isInit = false;
    if (onDispose != null) {
      await onDispose!();
    }
    await super.dispose();
  }
}

void main() {
  group('KycConsentScreen Tests', () {
    late MockAuthService authService;
    const testProfile = DriverProfile(
      uid: 'driver_consent_1',
      name: 'Sunil Gavaskar',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH 01 AB 1234',
      verificationStatus: null,
    );

    setUp(() {
      authService = MockAuthService();
      authService.mockUser = FakeUser(uid: 'driver_consent_1');
    });

    testWidgets('renders privacy and consent notice, document items, and manages continue button state', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await tester.pumpWidget(
        createTestWidget(
          child: KycConsentScreen(
            profile: testProfile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Title & privacy notice
      expect(find.text('Driver Verification'), findsNWidgets(2)); // AppBar + Body
      expect(find.byIcon(Icons.privacy_tip_outlined), findsOneWidget);
      expect(find.text('Driver Photo ID'), findsOneWidget);
      expect(find.text('Vehicle RC Document'), findsOneWidget);
      expect(find.text('Driver Selfie'), findsOneWidget);

      // Button is initially disabled
      final continueButton = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(continueButton.onPressed, isNull);

      // Tap consent checkbox
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();

      // Button is now enabled
      final enabledButton = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(enabledButton.onPressed, isNotNull);
    });

    testWidgets('logout action triggers authService signOut', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: KycConsentScreen(
            profile: testProfile,
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

  group('KycPendingScreen Tests', () {
    late MockAuthService authService;
    const testProfile = DriverProfile(
      uid: 'driver_pending_1',
      name: 'Kapil Dev',
      phone: '+919876543210',
      truckType: TruckType.hydraulic,
      vehicleNumber: 'DL 01 XY 9999',
      verificationStatus: 'pending',
    );

    setUp(() {
      authService = MockAuthService();
      authService.mockUser = FakeUser(uid: 'driver_pending_1');
    });

    testWidgets('renders pending state, driver details, and sign out', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await tester.pumpWidget(
        createTestWidget(
          child: KycPendingScreen(
            profile: testProfile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Verification Under Review'), findsOneWidget);
      expect(find.byIcon(Icons.hourglass_top_outlined), findsOneWidget);
      expect(find.text('Kapil Dev'), findsOneWidget);
      expect(find.text('DL 01 XY 9999'), findsOneWidget);
      expect(find.text('+919876543210'), findsOneWidget);
      expect(find.text('Under Review'), findsOneWidget);

      // Sign out button
      await tester.tap(find.text('Logout'));
      await tester.pump();

      expect(authService.signOutCalled, isTrue);
    });

    testWidgets('renders Hindi details table labels without English leak', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await tester.pumpWidget(
        createTestWidget(
          locale: const Locale('hi'),
          child: KycPendingScreen(
            profile: testProfile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('चालक'), findsOneWidget);
      expect(find.text('वाहन'), findsOneWidget);
      expect(find.text('फ़ोन'), findsOneWidget);
      expect(find.text('स्थिति'), findsOneWidget);
      expect(find.text('समीक्षाधीन'), findsOneWidget);

      expect(find.text('Driver'), findsNothing);
      expect(find.text('Vehicle'), findsNothing);
      expect(find.text('Phone'), findsNothing);
      expect(find.text('Status'), findsNothing);
      expect(find.text('Under Review'), findsNothing);
    });

    testWidgets('renders Marathi details table labels without English leak', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await tester.pumpWidget(
        createTestWidget(
          locale: const Locale('mr'),
          child: KycPendingScreen(
            profile: testProfile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('चालक'), findsOneWidget);
      expect(find.text('वाहन'), findsOneWidget);
      expect(find.text('फोन'), findsOneWidget);
      expect(find.text('स्थिती'), findsOneWidget);
      expect(find.text('तपासणी सुरू आहे'), findsOneWidget);

      expect(find.text('Driver'), findsNothing);
      expect(find.text('Vehicle'), findsNothing);
      expect(find.text('Phone'), findsNothing);
      expect(find.text('Status'), findsNothing);
      expect(find.text('Under Review'), findsNothing);
    });
  });

  group('KycRejectedScreen Tests', () {
    late MockAuthService authService;
    const testProfileWithReason = DriverProfile(
      uid: 'driver_rej_1',
      name: 'Zaheer Khan',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH 04 AB 5678',
      verificationStatus: 'rejected',
      rejectionReason: 'Driving license expired. Please upload valid license.',
    );

    const testProfileWithoutReason = DriverProfile(
      uid: 'driver_rej_2',
      name: 'Anil Kumble',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'KA 01 CD 1111',
      verificationStatus: 'rejected',
      rejectionReason: null,
    );

    setUp(() {
      authService = MockAuthService();
      authService.mockUser = FakeUser(uid: 'driver_rej_1');
    });

    testWidgets('renders custom rejection reason when provided', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: KycRejectedScreen(
            profile: testProfileWithReason,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Verification Rejected'), findsOneWidget);
      expect(find.byIcon(Icons.cancel_outlined), findsOneWidget);
      expect(find.text('Driving license expired. Please upload valid license.'), findsOneWidget);
      expect(find.text('Resubmit Documents'), findsOneWidget);
    });

    testWidgets('renders fallback default rejection reason when reason is null', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: KycRejectedScreen(
            profile: testProfileWithoutReason,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Documents were unclear or did not match registration details.'), findsOneWidget);
    });

    testWidgets('sign out button triggers authService signOut', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: KycRejectedScreen(
            profile: testProfileWithReason,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Logout'));
      await tester.pump();

      expect(authService.signOutCalled, isTrue);
    });
  });

  group('KycReviewScreen Tests', () {
    late MockAuthService authService;
    late MockKycService kycService;
    late KycController controller;
    late Directory tempDir;

    const testProfile = DriverProfile(
      uid: 'driver_review_1',
      name: 'Sachin Tendulkar',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH 02 BB 1010',
      verificationStatus: null,
    );

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('kyc_screen_test_');
      authService = MockAuthService();
      authService.mockUser = FakeUser(uid: 'driver_review_1');
      kycService = MockKycService();
      controller = KycController(
        kycService: kycService,
        authService: authService,
      );
    });

    tearDown(() {
      try {
        if (tempDir.existsSync()) {
          tempDir.deleteSync(recursive: true);
        }
      } catch (_) {}
    });

    File createTempImageFile(String name) {
      final file = File('${tempDir.path}/$name');
      file.writeAsBytesSync(kMinimal1x1PngBytes);
      return file;
    }

    testWidgets('renders document previews, retake buttons, and submit button state', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final idFile = createTempImageFile('id.jpg');
      final rcFile = createTempImageFile('rc.jpg');
      final selfieFile = createTempImageFile('selfie.jpg');

      controller.setIdFile(idFile);
      controller.setRcFile(rcFile);
      // selfieFile not set yet

      await tester.pumpWidget(
        createTestWidget(
          child: KycReviewScreen(
            controller: controller,
            profile: testProfile,
            authService: authService,
          ),
        ),
      );
      await tester.pump();

      expect(find.text('Review Documents'), findsNWidgets(2)); // AppBar + Title
      expect(find.text('Driver Photo ID'), findsOneWidget);
      expect(find.text('Vehicle RC Document'), findsOneWidget);
      expect(find.text('Driver Selfie'), findsOneWidget);
      expect(find.text('Retake'), findsNWidgets(3));

      // Submit button is disabled because selfie is missing
      final submitBtn = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(submitBtn.onPressed, isNull);

      // Now add selfie
      controller.setSelfieFile(selfieFile);
      await tester.pump();

      // Submit button is now enabled
      final enabledSubmitBtn = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(enabledSubmitBtn.onPressed, isNotNull);
    });

    testWidgets('renders error banner when controller has errorMessage', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      await tester.pumpWidget(
        createTestWidget(
          child: KycReviewScreen(
            controller: controller,
            profile: testProfile,
            authService: authService,
          ),
        ),
      );
      await tester.pump();

      // Trigger submit to get missing documents error
      await controller.submitVerification(profile: testProfile);
      await tester.pump();

      expect(find.text('All required documents must be captured before submission.'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsWidgets);
    });

    testWidgets('renders Hindi captured and missing labels in KycReviewScreen', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final idFile = createTempImageFile('id.jpg');
      controller.setIdFile(idFile);
      // RC and selfie missing

      await tester.pumpWidget(
        createTestWidget(
          locale: const Locale('hi'),
          child: KycReviewScreen(
            controller: controller,
            profile: testProfile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('कैप्चर किया गया'), findsOneWidget);
      expect(find.text('अनुपलब्ध'), findsNWidgets(2));
      expect(find.text('Captured'), findsNothing);
      expect(find.text('Missing'), findsNothing);
    });

    testWidgets('renders Marathi captured and missing labels in KycReviewScreen', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final idFile = createTempImageFile('id.jpg');
      controller.setIdFile(idFile);
      // RC and selfie missing

      await tester.pumpWidget(
        createTestWidget(
          locale: const Locale('mr'),
          child: KycReviewScreen(
            controller: controller,
            profile: testProfile,
            authService: authService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('कॅप्चर केले'), findsOneWidget);
      expect(find.text('गहाळ'), findsNWidgets(2));
      expect(find.text('Captured'), findsNothing);
      expect(find.text('Missing'), findsNothing);
    });
  });

  group('KycCameraScreen Lifecycle & Ownership Tests', () {
    late MockAuthService authService;
    late MockKycService kycService;
    late KycController controller;
    late Directory tempDir;

    const testProfile = DriverProfile(
      uid: 'driver_cam_1',
      name: 'Mohammad Azharuddin',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH 01 CC 9090',
      verificationStatus: null,
    );

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('kyc_cam_test_');
      authService = MockAuthService();
      authService.mockUser = FakeUser(uid: 'driver_cam_1');
      kycService = MockKycService();
      controller = KycController(
        kycService: kycService,
        authService: authService,
      );
    });

    tearDown(() {
      try {
        if (tempDir.existsSync()) {
          tempDir.deleteSync(recursive: true);
        }
      } catch (_) {}
    });

    testWidgets('captured file ownership is transferred and preserved on accept', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final capturedFile = File('${tempDir.path}/test_capture.jpg');
      capturedFile.writeAsBytesSync(kMinimal1x1PngBytes);

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            onSimulatedCaptureForTest: () async => capturedFile,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Tap capture photo
      await tester.tap(find.byIcon(Icons.camera_alt));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Verify preview is shown with "Use Photo" button
      expect(find.text('Use Photo'), findsOneWidget);

      // Tap "Use Photo" to accept
      await tester.tap(find.text('Use Photo'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Controller should now have the ID file
      expect(controller.idFile?.path, equals(capturedFile.path));
      // And the file on disk should NOT have been deleted by camera screen disposal
      expect(capturedFile.existsSync(), isTrue);
    });

    testWidgets('unaccepted captured file is deleted when camera screen is disposed', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final capturedFile = File('${tempDir.path}/test_capture_unaccepted.jpg');
      capturedFile.writeAsBytesSync(kMinimal1x1PngBytes);

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            onSimulatedCaptureForTest: () async => capturedFile,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Tap capture photo
      await tester.tap(find.byIcon(Icons.camera_alt));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Use Photo'), findsOneWidget);
      expect(capturedFile.existsSync(), isTrue);

      // Replace widget tree, causing KycCameraScreen to dispose without accepting photo
      await tester.pumpWidget(
        createTestWidget(
          child: const SizedBox.shrink(),
        ),
      );
      await tester.pumpAndSettle();

      // The unaccepted captured file was deleted on dispose
      expect(capturedFile.existsSync(), isFalse);
    });

    testWidgets('Medium 1: late capture completing during dispose delays controller disposal, deletes orphan XFile, and triggers zero errors', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final orphanCaptureFile = File('${tempDir.path}/late_orphan_capture.jpg');
      orphanCaptureFile.writeAsBytesSync(kMinimal1x1PngBytes);

      final captureCompleter = Completer<XFile>();
      late FakeCameraController fakeController;

      fakeController = FakeCameraController(
        onTakePicture: () => captureCompleter.future,
      );

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(
                name: 'back',
                lensDirection: CameraLensDirection.back,
                sensorOrientation: 90,
              ),
            ],
            cameraControllerBuilder: (_) => fakeController,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(fakeController._isInit, isTrue);
      expect(fakeController.isDisposed, isFalse);

      // Tap capture button to initiate async takePicture
      await tester.tap(find.byIcon(Icons.camera_alt));
      await tester.pump();

      // Controller is still active because capture is in flight
      expect(fakeController.isDisposed, isFalse);

      // Screen is unmounted while takePicture is pending
      await tester.pumpWidget(
        createTestWidget(
          child: const SizedBox.shrink(),
        ),
      );
      // Wait a tick: dispose() ran, but controller should NOT be disposed yet because capture is in-flight!
      await tester.pump();
      expect(fakeController.isDisposed, isFalse, reason: 'Controller must not be disposed while capture is in flight');
      expect(fakeController.disposeCallCount, equals(0));

      // Now complete the capture
      captureCompleter.complete(XFile(orphanCaptureFile.path));

      // Let microtasks run
      await tester.pump(const Duration(milliseconds: 50));

      // Now the capture has settled, the orphan file must be deleted, and the controller disposed exactly once
      expect(fakeController.isDisposed, isTrue, reason: 'Controller must be disposed after capture completes');
      expect(fakeController.disposeCallCount, equals(1), reason: 'Controller must be disposed exactly once');
      expect(orphanCaptureFile.existsSync(), isFalse, reason: 'Orphan XFile must be deleted upon late completion');
    });

    testWidgets('Medium 3: Camera recovers cleanly on app resume: controller #1 disposed on inactive, controller #2 initialized on resumed', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final createdControllers = <FakeCameraController>[];

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(
                name: 'back',
                lensDirection: CameraLensDirection.back,
                sensorOrientation: 90,
              ),
            ],
            cameraControllerBuilder: (_) {
              final c = FakeCameraController();
              createdControllers.add(c);
              return c;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(createdControllers.length, equals(1));
      expect(createdControllers[0]._isInit, isTrue);
      expect(createdControllers[0].isDisposed, isFalse);

      // App transitions to inactive/paused
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();

      // Controller #1 is disposed
      expect(createdControllers[0].isDisposed, isTrue);
      expect(createdControllers[0].disposeCallCount, equals(1));

      // App resumes
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      // Controller #2 is created and initialized
      expect(createdControllers.length, equals(2));
      expect(createdControllers[1]._isInit, isTrue);
      expect(createdControllers[1].isDisposed, isFalse);
    });

    testWidgets('Low 4: Complete Marathi error localization for all 10 KycErrorCategory values with zero English leaks', (tester) async {
      late AppLocalizations marathiL10n;

      await tester.pumpWidget(
        createTestWidget(
          locale: const Locale('mr'),
          child: Builder(
            builder: (context) {
              marathiL10n = AppLocalizations.of(context)!;
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      final englishRegex = RegExp(r'[a-zA-Z]');

      expect(KycErrorCategory.values.length, equals(10));

      for (final category in KycErrorCategory.values) {
        final message = category.toLocalizedMessage(marathiL10n);
        expect(message.isNotEmpty, isTrue, reason: 'Category $category localized message must not be empty');
        expect(
          englishRegex.hasMatch(message),
          isFalse,
          reason: 'Category $category localized message "$message" must not leak English characters',
        );
      }
    });

    testWidgets('Medium 2: Wrong lens direction fails closed immediately without creating controller (front-only + ID)', (tester) async {
      int creationCount = 0;
      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(
                name: 'front',
                lensDirection: CameraLensDirection.front,
                sensorOrientation: 270,
              ),
            ],
            cameraControllerBuilder: (_) {
              creationCount++;
              return FakeCameraController();
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(creationCount, equals(0));
      expect(find.byIcon(Icons.camera_alt_outlined), findsOneWidget);
    });

    testWidgets('Medium 2: Wrong lens direction fails closed immediately without creating controller (front-only + RC)', (tester) async {
      int creationCount = 0;
      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.rc,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(
                name: 'front',
                lensDirection: CameraLensDirection.front,
                sensorOrientation: 270,
              ),
            ],
            cameraControllerBuilder: (_) {
              creationCount++;
              return FakeCameraController();
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(creationCount, equals(0));
      expect(find.byIcon(Icons.camera_alt_outlined), findsOneWidget);
    });

    testWidgets('Medium 2: Wrong lens direction fails closed immediately without creating controller (rear-only + selfie)', (tester) async {
      int creationCount = 0;
      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.selfie,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(
                name: 'back',
                lensDirection: CameraLensDirection.back,
                sensorOrientation: 90,
              ),
            ],
            cameraControllerBuilder: (_) {
              creationCount++;
              return FakeCameraController();
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(creationCount, equals(0));
      expect(find.byIcon(Icons.camera_alt_outlined), findsOneWidget);
    });

    testWidgets('Medium 2: Matching camera descriptor exists and exact descriptor is selected', (tester) async {
      CameraDescription? capturedDesc;
      const backDesc = CameraDescription(
        name: 'back_cam',
        lensDirection: CameraLensDirection.back,
        sensorOrientation: 90,
      );
      const frontDesc = CameraDescription(
        name: 'front_cam',
        lensDirection: CameraLensDirection.front,
        sensorOrientation: 270,
      );

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.selfie,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [backDesc, frontDesc],
            cameraControllerBuilder: (desc) {
              capturedDesc = desc;
              return FakeCameraController(description: desc);
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(capturedDesc, equals(frontDesc));
    });

    testWidgets('Matrix A: Init pending -> inactive -> resumed (old init settles/disposes, new controller initializes, capture works)', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final matrixAFile = File('${tempDir.path}/test_matrix_a.jpg');
      matrixAFile.writeAsBytesSync(kMinimal1x1PngBytes);

      final initCompleter1 = Completer<void>();
      final controllers = <FakeCameraController>[];

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(name: 'back', lensDirection: CameraLensDirection.back, sensorOrientation: 90),
            ],
            cameraControllerBuilder: (_) {
              if (controllers.isEmpty) {
                final c = FakeCameraController(onInitialize: () => initCompleter1.future);
                controllers.add(c);
                return c;
              } else {
                final c = FakeCameraController(
                  onTakePicture: () async => XFile(matrixAFile.path),
                );
                controllers.add(c);
                return c;
              }
            },
          ),
        ),
      );
      // Pump one frame - init 1 started but not completed
      await tester.pump();
      expect(controllers.length, equals(1));
      expect(controllers[0]._isInit, isFalse);

      // App goes inactive
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();

      // App resumed while init 1 still pending
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      // Now complete init 1
      initCompleter1.complete();
      await tester.pumpAndSettle();

      // Controller 1 must be disposed, and Controller 2 must be created and initialized
      expect(controllers.length, equals(2));
      expect(controllers[0].isDisposed, isTrue);
      expect(controllers[1]._isInit, isTrue);
      expect(controllers[1].isDisposed, isFalse);

      // Capture works on controller 2
      await tester.tap(find.byIcon(Icons.camera_alt));
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.check), findsOneWidget);
    });

    testWidgets('Matrix B: Init pending -> inactive -> resumed -> inactive (no leak, no resurrection)', (tester) async {
      final initCompleter1 = Completer<void>();
      final initCompleter2 = Completer<void>();
      final controllers = <FakeCameraController>[];

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(name: 'back', lensDirection: CameraLensDirection.back, sensorOrientation: 90),
            ],
            cameraControllerBuilder: (_) {
              if (controllers.isEmpty) {
                final c = FakeCameraController(onInitialize: () => initCompleter1.future);
                controllers.add(c);
                return c;
              } else {
                final c = FakeCameraController(onInitialize: () => initCompleter2.future);
                controllers.add(c);
                return c;
              }
            },
          ),
        ),
      );
      await tester.pump();
      expect(controllers.length, equals(1));

      // App inactive
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();

      // App resumed
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      // Complete init 1 so teardown unblocks and init 2 starts
      initCompleter1.complete();
      await tester.pump();

      // App goes inactive again before init 2 completes
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();

      // Complete init 2 late
      if (!initCompleter2.isCompleted) {
        initCompleter2.complete();
      }
      await tester.pumpAndSettle();

      // All controllers must be disposed, none active
      for (final c in controllers) {
        expect(c.isDisposed, isTrue, reason: 'Every created controller must be disposed');
      }
    });

    testWidgets('Matrix C: Capture pending -> inactive -> resumed (capture settles, old controller disposed, new controller created only afterward)', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final captureCompleter = Completer<XFile>();
      final controllers = <FakeCameraController>[];
      final orphanFile = File('${tempDir.path}/matrix_c_orphan.jpg');
      orphanFile.writeAsBytesSync(kMinimal1x1PngBytes);

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(name: 'back', lensDirection: CameraLensDirection.back, sensorOrientation: 90),
            ],
            cameraControllerBuilder: (_) {
              if (controllers.isEmpty) {
                final c = FakeCameraController(onTakePicture: () => captureCompleter.future);
                controllers.add(c);
                return c;
              } else {
                final c = FakeCameraController();
                controllers.add(c);
                return c;
              }
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(controllers.length, equals(1));

      // Initiate capture
      await tester.tap(find.byIcon(Icons.camera_alt));
      await tester.pump();

      // App goes inactive while capture in flight
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();

      // Controller 1 is NOT yet disposed because capture is awaiting
      expect(controllers[0].isDisposed, isFalse);

      // App resumes while capture STILL pending
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      // Controller 2 must NOT be created yet because teardown of 1 is pending
      expect(controllers.length, equals(1), reason: 'Controller 2 must not be created before controller 1 finishes teardown');

      // Now capture completes
      captureCompleter.complete(XFile(orphanFile.path));
      await tester.pumpAndSettle();

      // Now controller 1 is disposed, orphan deleted, and controller 2 is created and initialized!
      expect(controllers[0].isDisposed, isTrue);
      expect(orphanFile.existsSync(), isFalse);
      expect(controllers.length, equals(2));
      expect(controllers[1]._isInit, isTrue);
      expect(controllers[1].isDisposed, isFalse);
    });

    testWidgets('Matrix D: Capture pending -> inactive -> resumed -> capture throws (old controller disposed, guard cleared, new controller initialized)', (tester) async {
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final captureCompleter = Completer<XFile>();
      final controllers = <FakeCameraController>[];

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(name: 'back', lensDirection: CameraLensDirection.back, sensorOrientation: 90),
            ],
            cameraControllerBuilder: (_) {
              if (controllers.isEmpty) {
                final c = FakeCameraController(onTakePicture: () => captureCompleter.future);
                controllers.add(c);
                return c;
              } else {
                final c = FakeCameraController();
                controllers.add(c);
                return c;
              }
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(controllers.length, equals(1));

      // Initiate capture
      await tester.tap(find.byIcon(Icons.camera_alt));
      await tester.pump();

      // App inactive
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();

      // App resumed
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      // Capture throws error
      captureCompleter.completeError(Exception('Hardware capture crash'));
      await tester.pumpAndSettle();

      // Controller 1 disposed, Controller 2 created and active, no unhandled error
      expect(controllers[0].isDisposed, isTrue);
      expect(controllers.length, equals(2));
      expect(controllers[1]._isInit, isTrue);
      expect(controllers[1].isDisposed, isFalse);
    });

    testWidgets('Matrix E: Inactive -> resumed -> inactive -> resumed (sequential controllers only, no overlap)', (tester) async {
      final controllers = <FakeCameraController>[];

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(name: 'back', lensDirection: CameraLensDirection.back, sensorOrientation: 90),
            ],
            cameraControllerBuilder: (_) {
              final c = FakeCameraController();
              controllers.add(c);
              return c;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(controllers.length, equals(1));

      // Cycle 1: inactive -> resumed
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(controllers[0].isDisposed, isTrue);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(controllers.length, equals(2));
      expect(controllers[1]._isInit, isTrue);
      expect(controllers[1].isDisposed, isFalse);

      // Cycle 2: inactive -> resumed
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(controllers[1].isDisposed, isTrue);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(controllers.length, equals(3));
      expect(controllers[2]._isInit, isTrue);
      expect(controllers[2].isDisposed, isFalse);
    });

    testWidgets('Matrix F: Rapid resumed events (exactly 1 init, no duplicate controllers created)', (tester) async {
      final controllers = <FakeCameraController>[];

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(name: 'back', lensDirection: CameraLensDirection.back, sensorOrientation: 90),
            ],
            cameraControllerBuilder: (_) {
              final c = FakeCameraController();
              controllers.add(c);
              return c;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(controllers.length, equals(1));

      // Inactive
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(controllers[0].isDisposed, isTrue);

      // Rapid resumed fires
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      // Exactly 1 new controller created (total 2)
      expect(controllers.length, equals(2));
      expect(controllers[1]._isInit, isTrue);
      expect(controllers[1].isDisposed, isFalse);
    });

    testWidgets('Matrix G: Dispose widget while init or capture is pending (no new init, no setState, no unhandled exception)', (tester) async {
      final initCompleter = Completer<void>();
      final controllers = <FakeCameraController>[];

      await tester.pumpWidget(
        createTestWidget(
          child: KycCameraScreen(
            docType: KycDocType.id,
            controller: controller,
            profile: testProfile,
            authService: authService,
            camerasForTest: [
              const CameraDescription(name: 'back', lensDirection: CameraLensDirection.back, sensorOrientation: 90),
            ],
            cameraControllerBuilder: (_) {
              final c = FakeCameraController(onInitialize: () => initCompleter.future);
              controllers.add(c);
              return c;
            },
          ),
        ),
      );
      await tester.pump();
      expect(controllers.length, equals(1));

      // Unmount the widget while init is still running
      await tester.pumpWidget(createTestWidget(child: const SizedBox.shrink()));
      await tester.pump();

      // Complete init late
      initCompleter.complete();
      await tester.pumpAndSettle();

      // Controller must be disposed, no error thrown
      expect(controllers[0].isDisposed, isTrue);
    });
  });
}
