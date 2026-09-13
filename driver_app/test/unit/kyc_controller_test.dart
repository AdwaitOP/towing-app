import 'dart:async';
import 'dart:io';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/kyc_error_category.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/kyc_service.dart';
import 'package:driver_app/features/kyc/controllers/kyc_controller.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';

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

class FakeAuthService extends AuthService {
  User? mockUser;
  @override
  User? get currentUser => mockUser;
  @override
  Stream<User?> get authStateChanges => Stream.value(mockUser);
}

class FakeKycService extends KycService {
  final List<String> uploadCalls = [];
  bool failUpload = false;
  String? failUploadOnFilename;
  bool failSubmit = false;
  Map<String, dynamic> submitResponse = {'success': true, 'status': 'pending'};
  KycException? exceptionToThrow;

  @override
  Future<void> uploadKycFile({
    required String driverUid,
    required String filename,
    required File file,
  }) async {
    if (failUpload || (failUploadOnFilename != null && failUploadOnFilename == filename)) {
      throw exceptionToThrow ?? const KycUploadException('Simulated upload failure');
    }
    uploadCalls.add('$driverUid/$filename');
  }

  @override
  Future<Map<String, dynamic>> submitDriverVerification() async {
    if (failSubmit) {
      throw exceptionToThrow ?? const KycServerException('Simulated submit failure');
    }
    return submitResponse;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('KycController Unit Tests', () {
    late Directory tempDir;
    late FakeAuthService authService;
    late FakeKycService kycService;
    late KycController controller;

    final testProfile = const DriverProfile(
      uid: 'driver_test_123',
      name: 'Ramesh Powar',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH 01 AB 1234',
      verificationStatus: null,
    );

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('kyc_test_');
      authService = FakeAuthService();
      authService.mockUser = FakeUser(uid: 'driver_test_123');
      kycService = FakeKycService();
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

    File createTempFile(String name) {
      final file = File('${tempDir.path}/$name');
      file.writeAsStringSync('dummy content for $name');
      return file;
    }

    test('setting files updates references and replaces old files cleanly', () {
      final id1 = createTempFile('id1.jpg');
      final id2 = createTempFile('id2.jpg');

      controller.setIdFile(id1);
      expect(controller.idFile?.path, equals(id1.path));
      expect(id1.existsSync(), isTrue);

      // Setting a new file deletes old file from disk
      controller.setIdFile(id2);
      expect(controller.idFile?.path, equals(id2.path));
      expect(id1.existsSync(), isFalse);
      expect(id2.existsSync(), isTrue);
    });

    test('hasAllDocuments requires all 3 documents to exist on disk', () {
      expect(controller.hasAllDocuments, isFalse);

      final idFile = createTempFile('id.jpg');
      final rcFile = createTempFile('rc.jpg');
      final selfieFile = createTempFile('selfie.jpg');

      controller.setIdFile(idFile);
      expect(controller.hasAllDocuments, isFalse);

      controller.setRcFile(rcFile);
      expect(controller.hasAllDocuments, isFalse);

      controller.setSelfieFile(selfieFile);
      expect(controller.hasAllDocuments, isTrue);

      // If one file is deleted from disk, hasAllDocuments becomes false
      idFile.deleteSync();
      expect(controller.hasAllDocuments, isFalse);
    });

    test('submitVerification fails precondition if documents are missing', () async {
      final success = await controller.submitVerification(profile: testProfile);
      expect(success, isFalse);
      expect(controller.errorMessage, contains('All three documents (ID, RC, Selfie) are required.'));
      expect(controller.isSubmitting, isFalse);
    });

    test('submitVerification enforces session safety when user is logged out', () async {
      controller.setIdFile(createTempFile('id.jpg'));
      controller.setRcFile(createTempFile('rc.jpg'));
      controller.setSelfieFile(createTempFile('selfie.jpg'));

      authService.mockUser = null; // User logged out

      final success = await controller.submitVerification(profile: testProfile);
      expect(success, isFalse);
      expect(controller.errorMessage, contains('Session mismatch or signed out'));
      expect(controller.isSubmitting, isFalse);
    });

    test('submitVerification enforces session safety on UID mismatch', () async {
      controller.setIdFile(createTempFile('id.jpg'));
      controller.setRcFile(createTempFile('rc.jpg'));
      controller.setSelfieFile(createTempFile('selfie.jpg'));

      authService.mockUser = FakeUser(uid: 'different_driver_uid');

      final success = await controller.submitVerification(profile: testProfile);
      expect(success, isFalse);
      expect(controller.errorMessage, contains('Session mismatch or signed out'));
      expect(controller.isSubmitting, isFalse);
    });

    test('synchronous single-flight lock rejects concurrent submissions', () async {
      controller.setIdFile(createTempFile('id.jpg'));
      controller.setRcFile(createTempFile('rc.jpg'));
      controller.setSelfieFile(createTempFile('selfie.jpg'));

      // Launch first submit
      final future1 = controller.submitVerification(profile: testProfile);
      // Immediately launch second submit before future1 finishes
      final future2 = controller.submitVerification(profile: testProfile);

      final result2 = await future2;
      expect(result2, isFalse, reason: 'Concurrent second call must be rejected immediately by synchronous lock');

      final result1 = await future1;
      expect(result1, isTrue);
    });

    test('successful submission uploads 3 documents, calls backend, and cleans up local files', () async {
      final idFile = createTempFile('id.jpg');
      final rcFile = createTempFile('rc.jpg');
      final selfieFile = createTempFile('selfie.jpg');

      controller.setIdFile(idFile);
      controller.setRcFile(rcFile);
      controller.setSelfieFile(selfieFile);

      final success = await controller.submitVerification(profile: testProfile);
      expect(success, isTrue);
      expect(controller.errorMessage, isNull);
      expect(controller.isSubmitting, isFalse);
      expect(controller.uploadProgress, equals(1.0));

      // Check upload calls made in order
      expect(kycService.uploadCalls, equals([
        'driver_test_123/id.jpg',
        'driver_test_123/rc.jpg',
        'driver_test_123/selfie.jpg',
      ]));

      // Check local files cleaned up on success
      expect(controller.idFile, isNull);
      expect(controller.rcFile, isNull);
      expect(controller.selfieFile, isNull);
      expect(idFile.existsSync(), isFalse);
      expect(rcFile.existsSync(), isFalse);
      expect(selfieFile.existsSync(), isFalse);
    });

    test('upload failure preserves local files for retry and displays error', () async {
      final idFile = createTempFile('id.jpg');
      final rcFile = createTempFile('rc.jpg');
      final selfieFile = createTempFile('selfie.jpg');

      controller.setIdFile(idFile);
      controller.setRcFile(rcFile);
      controller.setSelfieFile(selfieFile);

      kycService.failUploadOnFilename = 'rc.jpg';
      kycService.exceptionToThrow = const KycUploadException('Storage upload failed: rc.jpg');

      final success = await controller.submitVerification(profile: testProfile);
      expect(success, isFalse);
      expect(controller.errorMessage, equals('Storage upload failed: rc.jpg'));
      expect(controller.isSubmitting, isFalse);

      // Files preserved on disk for retry
      expect(idFile.existsSync(), isTrue);
      expect(rcFile.existsSync(), isTrue);
      expect(selfieFile.existsSync(), isTrue);
      expect(controller.hasAllDocuments, isTrue);
    });

    test('callable failure preserves local files for retry and displays error', () async {
      final idFile = createTempFile('id.jpg');
      final rcFile = createTempFile('rc.jpg');
      final selfieFile = createTempFile('selfie.jpg');

      controller.setIdFile(idFile);
      controller.setRcFile(rcFile);
      controller.setSelfieFile(selfieFile);

      kycService.failSubmit = true;
      kycService.exceptionToThrow = const KycServerException('Server verification error');

      final success = await controller.submitVerification(profile: testProfile);
      expect(success, isFalse);
      expect(controller.errorMessage, equals('Server verification error'));
      expect(controller.isSubmitting, isFalse);
      expect(controller.errorCategory, equals(KycErrorCategory.verificationSubmissionFailed));

      // Files preserved for retry
      expect(idFile.existsSync(), isTrue);
      expect(rcFile.existsSync(), isTrue);
      expect(selfieFile.existsSync(), isTrue);
      expect(controller.hasAllDocuments, isTrue);
    });

    test('dispose deletes local temporary files', () {
      final idFile = createTempFile('id.jpg');
      final rcFile = createTempFile('rc.jpg');
      final selfieFile = createTempFile('selfie.jpg');

      controller.setIdFile(idFile);
      controller.setRcFile(rcFile);
      controller.setSelfieFile(selfieFile);

      expect(idFile.existsSync(), isTrue);
      expect(rcFile.existsSync(), isTrue);
      expect(selfieFile.existsSync(), isTrue);

      controller.dispose();

      expect(idFile.existsSync(), isFalse);
      expect(rcFile.existsSync(), isFalse);
      expect(selfieFile.existsSync(), isFalse);
    });

    test('in-flight disposal defers file cleanup until active upload finishes without notifyListeners crash', () async {
      final idFile = createTempFile('id.jpg');
      final rcFile = createTempFile('rc.jpg');
      final selfieFile = createTempFile('selfie.jpg');

      controller.setIdFile(idFile);
      controller.setRcFile(rcFile);
      controller.setSelfieFile(selfieFile);

      final uploadCompleter = Completer<void>();
      var notifyCountAfterDisposal = 0;

      final barrierKycService = _BarrierKycService(uploadCompleter);
      final testController = KycController(
        kycService: barrierKycService,
        authService: authService,
      );
      testController.setIdFile(idFile);
      testController.setRcFile(rcFile);
      testController.setSelfieFile(selfieFile);

      // Start submission
      final submitFuture = testController.submitVerification(profile: testProfile);

      // Verify submission is active
      expect(testController.isSubmitting, isTrue);

      // Attach listener that should NOT be called after disposal
      testController.addListener(() {
        notifyCountAfterDisposal++;
      });

      // Dispose while submission is actively in flight
      testController.dispose();

      // Files must NOT be deleted yet while upload task might still be reading them
      expect(idFile.existsSync(), isTrue);

      // Release upload barrier
      uploadCompleter.complete();
      final success = await submitFuture;

      expect(success, isFalse);
      expect(notifyCountAfterDisposal, equals(0), reason: 'notifyListeners must not be called after disposal');

      // Now that upload finished and finally block executed, deferred cleanup took place
      expect(idFile.existsSync(), isFalse);
      expect(rcFile.existsSync(), isFalse);
      expect(selfieFile.existsSync(), isFalse);
    });
  });
}

class _BarrierKycService extends FakeKycService {
  final Completer<void> barrier;
  _BarrierKycService(this.barrier);

  @override
  Future<void> uploadKycFile({
    required String driverUid,
    required String filename,
    required File file,
  }) async {
    await barrier.future;
    await super.uploadKycFile(driverUid: driverUid, filename: filename, file: file);
  }
}
