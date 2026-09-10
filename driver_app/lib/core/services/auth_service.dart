import 'dart:convert';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import '../config/app_config.dart';
import '../errors/auth_error.dart';

/// Service managing WhatsApp OTP authentication and Firebase custom-token sign-in.
class AuthService {
  final FirebaseAuth? firebaseAuth;
  final http.Client _httpClient;
  final String? _explicitFunctionsBaseUrl;

  AuthService({
    this.firebaseAuth,
    http.Client? httpClient,
    String? functionsBaseUrl,
  })  : _httpClient = httpClient ?? http.Client(),
        _explicitFunctionsBaseUrl = functionsBaseUrl;

  String get functionsBaseUrl => _explicitFunctionsBaseUrl ?? AppConfig.functionsBaseUrl;

  FirebaseAuth get _auth => firebaseAuth ?? FirebaseAuth.instance;

  /// Current authenticated user stream.
  Stream<User?> get authStateChanges => _auth.authStateChanges();

  /// Current authenticated user.
  User? get currentUser => _auth.currentUser;

  /// Normalizes an Indian phone number to E.164 format (`+91XXXXXXXXXX`).
  /// Strips whitespace, dashes, leading zeroes, and '+91' prefixes.
  static String normalizePhone(String input) {
    String cleaned = input.replaceAll(RegExp(r'[\s\-\(\)]'), '');
    if (cleaned.startsWith('+91')) {
      cleaned = cleaned.substring(3);
    } else if (cleaned.startsWith('91') && cleaned.length == 12) {
      cleaned = cleaned.substring(2);
    } else if (cleaned.startsWith('0') && cleaned.length == 11) {
      cleaned = cleaned.substring(1);
    }
    if (!RegExp(r'^[6-9]\d{9}$').hasMatch(cleaned)) {
      throw const AuthException(
        message: 'Invalid Indian mobile number. Must be 10 digits starting with 6-9.',
        statusCode: 400,
        code: 'INVALID_PHONE',
      );
    }
    return '+91$cleaned';
  }

  /// Sends WhatsApp OTP via the closed Phase 3 backend `driverOtpSend` endpoint.
  Future<void> sendOtp(String rawPhone) async {
    final normalizedPhone = normalizePhone(rawPhone);
    final url = Uri.parse('$functionsBaseUrl/driverOtpSend');

    try {
      final response = await _httpClient.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'phone': normalizedPhone}),
      ).timeout(AppConfig.requestTimeout);

      final body = _parseJsonBody(response.body);

      if (response.statusCode == 200 && body['success'] == true) {
        return;
      }

      throw AuthException(
        message: body['message'] as String? ?? 'Failed to send OTP',
        code: body['code'] as String?,
        statusCode: response.statusCode,
      );
    } on AuthException {
      rethrow;
    } on http.ClientException {
      throw const AuthException(
        message: 'Network connection failed. Please check your internet.',
        code: 'NETWORK_ERROR',
      );
    } catch (e) {
      if (e is AuthException) rethrow;
      throw AuthException(
        message: 'Unexpected error sending OTP: $e',
        code: 'UNKNOWN_ERROR',
      );
    }
  }

  /// Verifies WhatsApp OTP via `driverOtpVerify` and signs in with the returned custom token.
  Future<UserCredential> verifyOtp(String rawPhone, String otp) async {
    final normalizedPhone = normalizePhone(rawPhone);
    final cleanedOtp = otp.trim();

    if (!RegExp(r'^\d{6}$').hasMatch(cleanedOtp)) {
      throw const AuthException(
        message: 'OTP must be a 6-digit numeric string',
        statusCode: 400,
        code: 'INVALID_OTP',
      );
    }

    final url = Uri.parse('$functionsBaseUrl/driverOtpVerify');

    try {
      final response = await _httpClient.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'phone': normalizedPhone,
          'otp': cleanedOtp,
        }),
      ).timeout(AppConfig.requestTimeout);

      final body = _parseJsonBody(response.body);

      if (response.statusCode != 200 || body['success'] != true) {
        throw AuthException(
          message: body['message'] as String? ?? 'Invalid OTP',
          code: body['code'] as String?,
          statusCode: response.statusCode,
        );
      }

      final customToken = body['token'] as String?;
      if (customToken == null || customToken.isEmpty) {
        throw const AuthException(
          message: 'Server returned empty authentication token',
          code: 'INVALID_TOKEN',
          statusCode: 500,
        );
      }

      // Sign in to Firebase Auth using custom token. Never log the token plaintext!
      return await _auth.signInWithCustomToken(customToken);
    } on AuthException {
      rethrow;
    } on http.ClientException {
      throw const AuthException(
        message: 'Network connection failed. Please check your internet.',
        code: 'NETWORK_ERROR',
      );
    } catch (e) {
      if (e is AuthException) rethrow;
      throw AuthException(
        message: 'Unexpected verification error: $e',
        code: 'UNKNOWN_ERROR',
      );
    }
  }

  /// Signs out of Firebase Auth.
  Future<void> signOut() async {
    await _auth.signOut();
  }

  Map<String, dynamic> _parseJsonBody(String body) {
    try {
      if (body.isEmpty) return {};
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) return decoded;
      return {};
    } catch (_) {
      return {};
    }
  }
}
