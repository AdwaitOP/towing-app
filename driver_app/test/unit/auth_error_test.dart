import 'package:driver_app/core/errors/auth_error.dart';
import 'package:driver_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AuthException Localized Error Mapping', () {
    late AppLocalizations l10n;

    setUpAll(() async {
      l10n = await AppLocalizations.delegate.load(const Locale('en'));
    });

    test('maps OTP_EXPIRED code to localized message', () {
      const error = AuthException(message: 'Expired', code: 'OTP_EXPIRED', statusCode: 401);
      expect(error.toLocalizedMessage(l10n), equals(l10n.otpExpired));
    });

    test('maps OTP_ATTEMPTS_EXCEEDED code to localized message', () {
      const error = AuthException(message: 'Exceeded', code: 'OTP_ATTEMPTS_EXCEEDED', statusCode: 401);
      expect(error.toLocalizedMessage(l10n), equals(l10n.otpAttemptsExceeded));
    });

    test('maps OTP_SEND_BLOCKED code to localized message', () {
      const error = AuthException(message: 'Blocked', code: 'OTP_SEND_BLOCKED', statusCode: 429);
      expect(error.toLocalizedMessage(l10n), equals(l10n.otpSendBlocked));
    });

    test('maps OTP_RESEND_COOLDOWN code to localized message', () {
      const error = AuthException(message: 'Cooldown', code: 'OTP_RESEND_COOLDOWN', statusCode: 429);
      expect(error.toLocalizedMessage(l10n), equals(l10n.otpResendCooldown));
    });

    test('maps OTP_DELIVERY_FAILED code to localized message', () {
      const error = AuthException(message: 'Delivery failed', code: 'OTP_DELIVERY_FAILED', statusCode: 503);
      expect(error.toLocalizedMessage(l10n), equals(l10n.otpDeliveryFailed));
    });

    test('maps OTP_INVALID code to localized message', () {
      const error = AuthException(message: 'Invalid', code: 'OTP_INVALID', statusCode: 401);
      expect(error.toLocalizedMessage(l10n), equals(l10n.invalidOtp));
    });

    test('maps 429 status code when code is absent', () {
      const error = AuthException(message: 'Too many requests', statusCode: 429);
      expect(error.toLocalizedMessage(l10n), equals(l10n.otpResendCooldown));
    });

    test('maps 400 status code when code is absent', () {
      const error = AuthException(message: 'Bad request', statusCode: 400);
      expect(error.toLocalizedMessage(l10n), equals(l10n.invalidPhone));
    });

    test('maps 503 status code when code is absent', () {
      const error = AuthException(message: 'Service unavailable', statusCode: 503);
      expect(error.toLocalizedMessage(l10n), equals(l10n.otpDeliveryFailed));
    });

    test('maps NETWORK_ERROR code to localized genericNetworkError', () {
      const error = AuthException(message: 'Failed host lookup', code: 'NETWORK_ERROR');
      expect(error.toLocalizedMessage(l10n), equals(l10n.genericNetworkError));
    });

    test('maps unknown codes and messages to localized authFailed without leaking raw text', () {
      const error = AuthException(
        message: 'Internal Firebase backend error 0x8927429 [sensitive data]',
        code: 'UNKNOWN_PROVIDER_CODE',
        statusCode: 500,
      );
      final localized = error.toLocalizedMessage(l10n);
      expect(localized, equals(l10n.authFailed));
      expect(localized.contains('Internal Firebase'), isFalse);
      expect(localized.contains('sensitive data'), isFalse);
    });
  });
}
