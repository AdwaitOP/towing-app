import 'dart:io';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_storage/firebase_storage.dart';
import '../models/kyc_error_category.dart';

/// Exceptions thrown by KycService with controlled, sanitized categorization.
sealed class KycException implements Exception {
  final String message;
  final KycErrorCategory category;
  const KycException(this.message, {this.category = KycErrorCategory.genericKycError});

  @override
  String toString() => message;
}

class KycAuthException extends KycException {
  const KycAuthException([super.message = 'Driver session expired or unauthenticated'])
      : super(category: KycErrorCategory.sessionChanged);
}

class KycNotFoundException extends KycException {
  const KycNotFoundException([super.message = 'Driver profile not found'])
      : super(category: KycErrorCategory.genericKycError);
}

class KycPreconditionException extends KycException {
  const KycPreconditionException([super.message = 'Submission precondition not met'])
      : super(category: KycErrorCategory.documentsMissing);
}

class KycUploadException extends KycException {
  const KycUploadException([super.message = 'Failed to upload document'])
      : super(category: KycErrorCategory.uploadFailed);
}

class KycNetworkException extends KycException {
  const KycNetworkException([super.message = 'Network error during KYC submission'])
      : super(category: KycErrorCategory.networkError);
}

class KycServerException extends KycException {
  const KycServerException([super.message = 'Server error during KYC verification'])
      : super(category: KycErrorCategory.verificationSubmissionFailed);
}

/// Service handling KYC document uploads to Firebase Storage
/// and calling submitDriverVerification Cloud Function.
class KycService {
  final FirebaseStorage? _customStorage;
  final FirebaseFunctions? _customFunctions;

  KycService({
    FirebaseStorage? storage,
    FirebaseFunctions? functions,
  })  : _customStorage = storage,
        _customFunctions = functions;

  FirebaseStorage get storage => _customStorage ?? FirebaseStorage.instance;
  FirebaseFunctions get functions =>
      _customFunctions ?? FirebaseFunctions.instanceFor(region: 'asia-south1');

  /// Uploads a single KYC document to Firebase Storage:
  /// `driver_verification/{driverUid}/{filename}`.
  Future<void> uploadKycFile({
    required String driverUid,
    required String filename,
    required File file,
  }) async {
    if (driverUid.trim().isEmpty) {
      throw const KycAuthException('Invalid driver UID');
    }
    if (!file.existsSync()) {
      throw const KycUploadException('Document file does not exist');
    }

    try {
      final ref = storage.ref().child('driver_verification/$driverUid/$filename');
      final metadata = SettableMetadata(
        contentType: 'image/jpeg',
      );
      await ref.putFile(file, metadata);
    } on FirebaseException catch (e) {
      if (e.code == 'unauthorized' || e.code == 'permission-denied') {
        throw const KycUploadException('Storage upload permission denied. Verify driver verification status.');
      }
      throw const KycUploadException('Failed to upload document');
    } catch (_) {
      throw const KycUploadException('Failed to upload document');
    }
  }

  /// Calls the submitDriverVerification callable function.
  Future<Map<String, dynamic>> submitDriverVerification() async {
    try {
      final callable = functions.httpsCallable('submitDriverVerification');
      final response = await callable.call<Map<String, dynamic>>({});
      final data = response.data;
      return Map<String, dynamic>.from(data);
    } on FirebaseFunctionsException catch (e) {
      switch (e.code) {
        case 'unauthenticated':
          throw const KycAuthException();
        case 'not-found':
          throw const KycNotFoundException();
        case 'failed-precondition':
          throw const KycPreconditionException();
        default:
          throw const KycServerException();
      }
    } catch (e) {
      if (e is KycException) rethrow;
      throw const KycNetworkException();
    }
  }
}
