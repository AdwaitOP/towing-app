import '../../l10n/app_localizations.dart';

/// Exception thrown during authentication operations.
class AuthException implements Exception {
  final String message;
  final String? code;
  final int? statusCode;

  const AuthException({
    required this.message,
    this.code,
    this.statusCode,
  });

  /// Map exception to localized user-facing message.
  String toLocalizedMessage(AppLocalizations l10n) {
    if (code == 'OTP_EXPIRED') {
      return l10n.otpExpired;
    }
    if (code == 'OTP_ATTEMPTS_EXCEEDED') {
      return l10n.otpAttemptsExceeded;
    }
    if (code == 'OTP_SEND_BLOCKED') {
      return l10n.otpSendBlocked;
    }
    if (code == 'OTP_RESEND_COOLDOWN') {
      return l10n.otpResendCooldown;
    }
    if (code == 'OTP_DELIVERY_FAILED' || statusCode == 503) {
      return l10n.otpDeliveryFailed;
    }
    if (code == 'OTP_INVALID' || code == 'OTP_CONSUMED' || code == 'OTP_NOT_FOUND') {
      return l10n.invalidOtp;
    }
    if (statusCode == 429) {
      return l10n.otpResendCooldown;
    }
    if (code == 'INVALID_PHONE' || statusCode == 400) {
      return l10n.invalidPhone;
    }
    if (code == 'NETWORK_ERROR') {
      return l10n.genericNetworkError;
    }
    return l10n.authFailed;
  }

  @override
  String toString() => 'AuthException(statusCode: $statusCode, code: $code, message: $message)';
}
