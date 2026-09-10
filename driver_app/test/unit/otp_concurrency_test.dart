import 'dart:async';
import 'package:driver_app/core/errors/auth_error.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/features/auth/controllers/auth_controller.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeUserCredential implements UserCredential {
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class CountingAuthService extends AuthService {
  int verifyCallCount = 0;
  Completer<void>? inFlightCompleter;
  bool shouldFail = false;

  @override
  Future<UserCredential> verifyOtp(String phone, String otp) async {
    verifyCallCount++;
    if (inFlightCompleter != null) {
      await inFlightCompleter!.future;
    }
    if (shouldFail) {
      throw const AuthException(
        message: 'Invalid OTP',
        code: 'OTP_INVALID',
        statusCode: 401,
      );
    }
    return FakeUserCredential();
  }
}

void main() {
  group('OTP Verification Concurrency & Single-Flight Guard', () {
    late CountingAuthService mockAuth;
    late AuthController controller;

    setUp(() {
      mockAuth = CountingAuthService();
      controller = AuthController(authService: mockAuth);
      controller.setPhone('+919876543210');
    });

    tearDown(() {
      controller.dispose();
    });

    test('auto-submit + immediate tap results in exactly ONE backend request', () async {
      final completer = Completer<void>();
      mockAuth.inFlightCompleter = completer;

      // 1. First trigger (e.g. from 6th digit auto-submit)
      final firstFuture = controller.verifyOtp('123456');
      expect(controller.isVerifying, isTrue);

      // 2. Immediate second trigger (e.g. user tapped Verify button in same microtask)
      final secondFuture = controller.verifyOtp('123456');

      // The second call must have been dropped synchronously
      final secondResult = await secondFuture;
      expect(secondResult, isFalse);
      expect(mockAuth.verifyCallCount, equals(1));

      // Resolve the in-flight request
      completer.complete();
      final firstResult = await firstFuture;
      expect(firstResult, isTrue);
      expect(mockAuth.verifyCallCount, equals(1));
    });

    test('rapid repeated taps issue exactly ONE backend request', () async {
      final completer = Completer<void>();
      mockAuth.inFlightCompleter = completer;

      // Simulate 5 rapid taps on the Verify button
      final f1 = controller.verifyOtp('123456');
      final f2 = controller.verifyOtp('123456');
      final f3 = controller.verifyOtp('123456');
      final f4 = controller.verifyOtp('123456');
      final f5 = controller.verifyOtp('123456');

      expect(mockAuth.verifyCallCount, equals(1));

      completer.complete();
      final results = await Future.wait([f1, f2, f3, f4, f5]);

      expect(results, equals([true, false, false, false, false]));
      expect(mockAuth.verifyCallCount, equals(1));
    });

    test('failed verification safely releases guard so user can retry', () async {
      mockAuth.shouldFail = true;

      final firstAttempt = await controller.verifyOtp('000000');
      expect(firstAttempt, isFalse);
      expect(mockAuth.verifyCallCount, equals(1));
      expect(controller.isVerifying, isFalse);
      expect(controller.errorMessage, equals('OTP_INVALID'));

      // Retry with correct OTP
      mockAuth.shouldFail = false;
      final retryAttempt = await controller.verifyOtp('123456');
      expect(retryAttempt, isTrue);
      expect(mockAuth.verifyCallCount, equals(2));
      expect(controller.isVerifying, isFalse);
    });
  });
}
