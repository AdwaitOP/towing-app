import '../../l10n/app_localizations.dart';

/// Controlled categories for KYC-related user-facing errors.
/// Raw provider/backend errors must be mapped to these categories.
enum KycErrorCategory {
  cameraPermissionDenied,
  cameraPermissionPermanentlyDenied,
  cameraUnavailable,
  captureFailed,
  uploadFailed,
  networkError,
  sessionChanged,
  documentsMissing,
  verificationSubmissionFailed,
  genericKycError,
}

extension KycErrorCategoryLocalization on KycErrorCategory {
  String toLocalizedMessage(AppLocalizations l10n) {
    switch (this) {
      case KycErrorCategory.cameraPermissionDenied:
        return l10n.cameraPermissionRequired;
      case KycErrorCategory.cameraPermissionPermanentlyDenied:
        return l10n.cameraPermissionPermanentlyDenied;
      case KycErrorCategory.cameraUnavailable:
        return l10n.cameraUnavailable;
      case KycErrorCategory.captureFailed:
        return l10n.photoCaptureFailed;
      case KycErrorCategory.uploadFailed:
        return l10n.kycUploadError;
      case KycErrorCategory.networkError:
        return l10n.kycNetworkError;
      case KycErrorCategory.sessionChanged:
        return l10n.kycSessionExpired;
      case KycErrorCategory.documentsMissing:
        return l10n.kycDocumentsMissing;
      case KycErrorCategory.verificationSubmissionFailed:
        return l10n.kycSubmissionError;
      case KycErrorCategory.genericKycError:
        return l10n.kycGenericError;
    }
  }
}
