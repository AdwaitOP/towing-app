import 'package:driver_app/core/errors/auth_error.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AuthService.normalizePhone', () {
    test('normalizes standard 10-digit Indian phone number', () {
      expect(AuthService.normalizePhone('9876543210'), equals('+919876543210'));
      expect(AuthService.normalizePhone('8765432109'), equals('+918765432109'));
      expect(AuthService.normalizePhone('7654321098'), equals('+917654321098'));
      expect(AuthService.normalizePhone('6543210987'), equals('+916543210987'));
    });

    test('preserves existing +91 prefix correctly', () {
      expect(AuthService.normalizePhone('+919876543210'), equals('+919876543210'));
    });

    test('strips leading 91 prefix without plus', () {
      expect(AuthService.normalizePhone('919876543210'), equals('+919876543210'));
    });

    test('strips leading 0 prefix', () {
      expect(AuthService.normalizePhone('09876543210'), equals('+919876543210'));
    });

    test('strips whitespace, dashes, and parentheses', () {
      expect(AuthService.normalizePhone('+91 98765-43210'), equals('+919876543210'));
      expect(AuthService.normalizePhone('(98765) 43210'), equals('+919876543210'));
      expect(AuthService.normalizePhone(' 98765 43210 '), equals('+919876543210'));
    });

    test('throws AuthException for numbers starting with 0-5', () {
      expect(
        () => AuthService.normalizePhone('5876543210'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'INVALID_PHONE')),
      );
      expect(
        () => AuthService.normalizePhone('1234567890'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'INVALID_PHONE')),
      );
    });

    test('throws AuthException for numbers of invalid length', () {
      expect(
        () => AuthService.normalizePhone('98765'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'INVALID_PHONE')),
      );
      expect(
        () => AuthService.normalizePhone('9876543210999'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'INVALID_PHONE')),
      );
    });

    test('throws AuthException for non-numeric input', () {
      expect(
        () => AuthService.normalizePhone('abcdefghij'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'INVALID_PHONE')),
      );
    });
  });
}
