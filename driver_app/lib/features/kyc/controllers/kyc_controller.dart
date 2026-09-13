import 'dart:io';
import 'package:flutter/foundation.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/models/kyc_error_category.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/kyc_service.dart';

enum KycStep {
  consent,
  captureId,
  captureRc,
  captureSelfie,
  review,
  uploading,
  submitted,
}

enum KycDocType {
  id('id.jpg'),
  rc('rc.jpg'),
  selfie('selfie.jpg');

  final String filename;
  const KycDocType(this.filename);
}

class KycController extends ChangeNotifier {
  final KycService _kycService;
  final AuthService _authService;

  File? _idFile;
  File? _rcFile;
  File? _selfieFile;

  bool _isSubmitting = false;
  bool _isDisposed = false;
  bool _pendingCleanup = false;
  String? _errorMessage;
  KycErrorCategory? _errorCategory;
  double _uploadProgress = 0.0;

  KycController({
    KycService? kycService,
    AuthService? authService,
  })  : _kycService = kycService ?? KycService(),
        _authService = authService ?? AuthService();

  File? get idFile => _idFile;
  File? get rcFile => _rcFile;
  File? get selfieFile => _selfieFile;

  bool get isSubmitting => _isSubmitting;
  String? get errorMessage => _errorMessage;
  KycErrorCategory? get errorCategory => _errorCategory;
  double get uploadProgress => _uploadProgress;

  bool get hasAllDocuments =>
      _idFile != null &&
      _idFile!.existsSync() &&
      _rcFile != null &&
      _rcFile!.existsSync() &&
      _selfieFile != null &&
      _selfieFile!.existsSync();

  void _safeNotifyListeners() {
    if (!_isDisposed) {
      notifyListeners();
    }
  }

  void setIdFile(File file) {
    if (_isDisposed) return;
    if (_idFile != null && _idFile!.path != file.path && _idFile!.existsSync()) {
      try {
        _idFile!.deleteSync();
      } catch (_) {}
    }
    _idFile = file;
    _errorMessage = null;
    _errorCategory = null;
    _safeNotifyListeners();
  }

  void setRcFile(File file) {
    if (_isDisposed) return;
    if (_rcFile != null && _rcFile!.path != file.path && _rcFile!.existsSync()) {
      try {
        _rcFile!.deleteSync();
      } catch (_) {}
    }
    _rcFile = file;
    _errorMessage = null;
    _errorCategory = null;
    _safeNotifyListeners();
  }

  void setSelfieFile(File file) {
    if (_isDisposed) return;
    if (_selfieFile != null && _selfieFile!.path != file.path && _selfieFile!.existsSync()) {
      try {
        _selfieFile!.deleteSync();
      } catch (_) {}
    }
    _selfieFile = file;
    _errorMessage = null;
    _errorCategory = null;
    _safeNotifyListeners();
  }

  void clearError() {
    if (_isDisposed) return;
    _errorMessage = null;
    _errorCategory = null;
    _safeNotifyListeners();
  }

  /// Submits the 3 KYC documents to Firebase Storage and calls the
  /// submitDriverVerification callable.
  ///
  /// Enforces:
  /// 1. Synchronous single-flight lock BEFORE any async boundary
  /// 2. Session verification: currentUser.uid == profile.uid
  /// 3. In-flight upload progress tracking
  /// 4. Local file cleanup on success
  /// 5. Failure recovery: files retained for retry
  Future<bool> submitVerification({required DriverProfile profile}) async {
    // 1. Synchronous single-flight guard
    if (_isDisposed || _isSubmitting) return false;
    _isSubmitting = true;
    _errorMessage = null;
    _errorCategory = null;
    _uploadProgress = 0.0;
    _safeNotifyListeners();

    try {
      // 2. Precondition validation
      if (!hasAllDocuments) {
        throw const KycPreconditionException('All three documents (ID, RC, Selfie) are required.');
      }

      // 3. User / session change safety check
      final currentUser = _authService.currentUser;
      if (currentUser == null || currentUser.uid != profile.uid) {
        throw const KycAuthException('Session mismatch or signed out. Aborting submission.');
      }

      if (_isDisposed) return false;

      // 4. Upload id.jpg
      _uploadProgress = 0.1;
      _safeNotifyListeners();
      await _kycService.uploadKycFile(
        driverUid: profile.uid,
        filename: KycDocType.id.filename,
        file: _idFile!,
      );

      if (_isDisposed) return false;

      // Verify session between operations
      if (_authService.currentUser?.uid != profile.uid) {
        throw const KycAuthException('Session expired during upload.');
      }

      // 5. Upload rc.jpg
      _uploadProgress = 0.4;
      _safeNotifyListeners();
      await _kycService.uploadKycFile(
        driverUid: profile.uid,
        filename: KycDocType.rc.filename,
        file: _rcFile!,
      );

      if (_isDisposed) return false;

      // Verify session between operations
      if (_authService.currentUser?.uid != profile.uid) {
        throw const KycAuthException('Session expired during upload.');
      }

      // 6. Upload selfie.jpg
      _uploadProgress = 0.7;
      _safeNotifyListeners();
      await _kycService.uploadKycFile(
        driverUid: profile.uid,
        filename: KycDocType.selfie.filename,
        file: _selfieFile!,
      );

      if (_isDisposed) return false;

      // Verify session between operations
      if (_authService.currentUser?.uid != profile.uid) {
        throw const KycAuthException('Session expired during upload.');
      }

      // 7. Invoke submitDriverVerification callable
      _uploadProgress = 0.9;
      _safeNotifyListeners();
      final result = await _kycService.submitDriverVerification();

      if (_isDisposed) return false;

      if (result['success'] == true) {
        _uploadProgress = 1.0;
        // Clean up temporary files on success
        _cleanupTempFiles();
        if (!_isDisposed) {
          _isSubmitting = false;
          _safeNotifyListeners();
        }
        return true;
      } else {
        throw const KycServerException('Submission was not confirmed by the server.');
      }
    } on KycException catch (e) {
      if (!_isDisposed) {
        _isSubmitting = false;
        _errorMessage = e.message;
        _errorCategory = e.category;
        _safeNotifyListeners();
      }
      return false;
    } catch (e) {
      if (!_isDisposed) {
        _isSubmitting = false;
        _errorMessage = 'Submission failed';
        _errorCategory = KycErrorCategory.genericKycError;
        _safeNotifyListeners();
      }
      return false;
    } finally {
      if (_isDisposed || _pendingCleanup) {
        _cleanupTempFiles();
      }
    }
  }

  /// Best-effort local cleanup to delete temporary local files from cache.
  void _cleanupTempFiles() {
    for (final file in [_idFile, _rcFile, _selfieFile]) {
      if (file != null && file.existsSync()) {
        try {
          file.deleteSync();
        } catch (_) {}
      }
    }
    _idFile = null;
    _rcFile = null;
    _selfieFile = null;
  }

  @override
  void dispose() {
    _isDisposed = true;
    if (_isSubmitting) {
      _pendingCleanup = true;
    } else {
      _cleanupTempFiles();
    }
    super.dispose();
  }
}
