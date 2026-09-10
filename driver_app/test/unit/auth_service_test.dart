import 'dart:convert';
import 'package:driver_app/core/config/app_config.dart';
import 'package:driver_app/core/errors/auth_error.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('AuthService HTTP Endpoints', () {
    const baseUrl = 'http://localhost:5001/test-app/asia-south1';

    test('sendOtp successfully posts normalized phone', () async {
      late Uri capturedUri;
      late Map<String, dynamic> capturedBody;

      final mockClient = MockClient((request) async {
        capturedUri = request.url;
        capturedBody = jsonDecode(request.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({'success': true, 'message': 'OTP sent'}),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      final service = AuthService(
        httpClient: mockClient,
        functionsBaseUrl: baseUrl,
      );

      await service.sendOtp('9876543210');

      expect(capturedUri.toString(), equals('$baseUrl/driverOtpSend'));
      expect(capturedBody['phone'], equals('+919876543210'));
    });

    test('sendOtp throws AuthException on backend 429 cooldown', () async {
      final mockClient = MockClient((request) async {
        return http.Response(
          jsonEncode({
            'success': false,
            'code': 'OTP_RESEND_COOLDOWN',
            'message': 'Please wait before requesting another OTP',
          }),
          429,
          headers: {'content-type': 'application/json'},
        );
      });

      final service = AuthService(
        httpClient: mockClient,
        functionsBaseUrl: baseUrl,
      );

      expect(
        () => service.sendOtp('9876543210'),
        throwsA(isA<AuthException>()
            .having((e) => e.statusCode, 'statusCode', 429)
            .having((e) => e.code, 'code', 'OTP_RESEND_COOLDOWN')),
      );
    });

    test('verifyOtp fails fast if OTP is not 6 digits without sending request', () async {
      var requestSent = false;
      final mockClient = MockClient((request) async {
        requestSent = true;
        return http.Response('{}', 200);
      });

      final service = AuthService(
        httpClient: mockClient,
        functionsBaseUrl: baseUrl,
      );

      expect(
        () => service.verifyOtp('9876543210', '123'),
        throwsA(isA<AuthException>().having((e) => e.code, 'code', 'INVALID_OTP')),
      );
      expect(requestSent, isFalse);
    });

    test('verifyOtp throws AuthException on backend 401 invalid OTP', () async {
      final mockClient = MockClient((request) async {
        return http.Response(
          jsonEncode({
            'success': false,
            'code': 'OTP_INVALID',
            'message': 'Invalid OTP',
          }),
          401,
          headers: {'content-type': 'application/json'},
        );
      });

      final service = AuthService(
        httpClient: mockClient,
        functionsBaseUrl: baseUrl,
      );

      expect(
        () => service.verifyOtp('9876543210', '999999'),
        throwsA(isA<AuthException>()
            .having((e) => e.statusCode, 'statusCode', 401)
            .having((e) => e.code, 'code', 'OTP_INVALID')),
      );
    });

    group('Real OTP Request Routing Integrity (Emulator vs Production)', () {
      const prodUrl = 'https://asia-south1-production-domain.cloudfunctions.net';

      test('emulator mode routes sendOtp to emulator URL and NEVER to production URL even if defined', () async {
        final resolvedUrl = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: true,
          productionUrl: prodUrl,
        );

        late Uri capturedUri;
        final mockClient = MockClient((request) async {
          capturedUri = request.url;
          return http.Response(
            jsonEncode({'success': true, 'message': 'OTP sent'}),
            200,
            headers: {'content-type': 'application/json'},
          );
        });

        final service = AuthService(
          httpClient: mockClient,
          functionsBaseUrl: resolvedUrl,
        );

        await service.sendOtp('9876543210');

        expect(capturedUri.toString(), equals('http://10.0.2.2:5001/towing-app/asia-south1/driverOtpSend'));
        expect(capturedUri.toString(), isNot(contains(prodUrl)));
      });

      test('emulator mode routes verifyOtp to emulator URL and NEVER to production URL even if defined', () async {
        final resolvedUrl = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: true,
          productionUrl: prodUrl,
        );

        late Uri capturedUri;
        final mockClient = MockClient((request) async {
          capturedUri = request.url;
          return http.Response(
            jsonEncode({'success': false, 'code': 'OTP_INVALID'}),
            401,
            headers: {'content-type': 'application/json'},
          );
        });

        final service = AuthService(
          httpClient: mockClient,
          functionsBaseUrl: resolvedUrl,
        );

        try {
          await service.verifyOtp('9876543210', '123456');
        } catch (_) {}

        expect(capturedUri.toString(), equals('http://10.0.2.2:5001/towing-app/asia-south1/driverOtpVerify'));
        expect(capturedUri.toString(), isNot(contains(prodUrl)));
      });

      test('production mode routes sendOtp and verifyOtp to exact production URL', () async {
        final resolvedUrl = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: false,
          productionUrl: prodUrl,
        );

        late Uri capturedSendUri;
        late Uri capturedVerifyUri;

        final mockClient = MockClient((request) async {
          if (request.url.path.endsWith('/driverOtpSend')) {
            capturedSendUri = request.url;
            return http.Response(
              jsonEncode({'success': true, 'message': 'OTP sent'}),
              200,
              headers: {'content-type': 'application/json'},
            );
          } else {
            capturedVerifyUri = request.url;
            return http.Response(
              jsonEncode({'success': false, 'code': 'OTP_INVALID'}),
              401,
              headers: {'content-type': 'application/json'},
            );
          }
        });

        final service = AuthService(
          httpClient: mockClient,
          functionsBaseUrl: resolvedUrl,
        );

        await service.sendOtp('9876543210');
        try {
          await service.verifyOtp('9876543210', '123456');
        } catch (_) {}

        expect(capturedSendUri.toString(), equals('$prodUrl/driverOtpSend'));
        expect(capturedVerifyUri.toString(), equals('$prodUrl/driverOtpVerify'));
      });

      test('production mode fails closed if production URL is absent or whitespace without making requests', () async {
        var requestMade = false;
        final mockClient = MockClient((request) async {
          requestMade = true;
          return http.Response('{}', 200);
        });

        expect(
          () {
            final url = AppConfig.resolveFunctionsBaseUrl(
              useEmulator: false,
              productionUrl: '',
            );
            return AuthService(httpClient: mockClient, functionsBaseUrl: url);
          },
          throwsStateError,
        );

        expect(
          () {
            final url = AppConfig.resolveFunctionsBaseUrl(
              useEmulator: false,
              productionUrl: '   ',
            );
            return AuthService(httpClient: mockClient, functionsBaseUrl: url);
          },
          throwsStateError,
        );

        expect(requestMade, isFalse);
      });
    });
  });
}
