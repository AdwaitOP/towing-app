import 'dart:async';
import 'package:flutter/foundation.dart';
import '../../../core/errors/auth_error.dart';
import '../../../core/services/auth_service.dart';
import '../../../l10n/app_localizations.dart';

/// Controller managing Phone Login and OTP verification UI state.
class AuthController extends ChangeNotifier {
  final AuthService _authService;

  AuthController({AuthService? authService})
      : _authService = authService ?? AuthService();

  String _phone = '';
  String _otp = '';
  bool _isLoading = false;
  bool _isVerifying = false;
  bool _isDisposed = false;
  AuthException? _lastAuthException;
  bool _hasGenericError = false;
  String? _rawErrorMessage;
  int _resendCountdown = 0;
  Timer? _timer;

  String get phone => _phone;
  String get otp => _otp;
  bool get isLoading => _isLoading;
  bool get isVerifying => _isVerifying;
  String? get errorMessage => _rawErrorMessage;
  int get resendCountdown => _resendCountdown;
  bool get canResendOtp => _resendCountdown == 0 && !_isLoading && !_isVerifying;

  /// Returns user-facing localized error string. Never displays raw exception or provider messages.
  String? getErrorMessage(AppLocalizations l10n) {
    if (_lastAuthException != null) {
      return _lastAuthException!.toLocalizedMessage(l10n);
    }
    if (_hasGenericError) {
      return l10n.authFailed;
    }
    return null;
  }

  void setPhone(String phone) {
    _phone = phone;
    _clearError();
    notifyListeners();
  }

  void setOtp(String otp) {
    _otp = otp;
    _clearError();
    notifyListeners();
  }

  void clearError() {
    _clearError();
    notifyListeners();
  }

  void _clearError() {
    _lastAuthException = null;
    _hasGenericError = false;
    _rawErrorMessage = null;
  }

  /// Sends OTP to user's phone via WhatsApp.
  Future<bool> sendOtp(String phoneInput) async {
    if (_isLoading || _isVerifying || _isDisposed) return false;

    _isLoading = true;
    _clearError();
    _phone = phoneInput;
    notifyListeners();

    try {
      await _authService.sendOtp(phoneInput);
      if (_isDisposed) return true;
      _isLoading = false;
      _startResendTimer(60);
      notifyListeners();
      return true;
    } on AuthException catch (e) {
      if (_isDisposed) return false;
      _isLoading = false;
      _lastAuthException = e;
      _rawErrorMessage = e.code ?? 'AUTH_ERROR';
      notifyListeners();
      return false;
    } catch (e) {
      if (_isDisposed) return false;
      _isLoading = false;
      _hasGenericError = true;
      _rawErrorMessage = 'AUTH_ERROR';
      notifyListeners();
      return false;
    }
  }

  /// Verifies OTP and signs into Firebase Auth.
  /// Enforces synchronous in-flight guard to prevent duplicate concurrent verification requests.
  Future<bool> verifyOtp(String otpInput) async {
    // Synchronous guard established before any async gap
    if (_isVerifying || _isLoading || _isDisposed) {
      return false;
    }
    _isVerifying = true;
    _isLoading = true;
    _clearError();
    _otp = otpInput;
    notifyListeners();

    try {
      await _authService.verifyOtp(_phone, otpInput);
      if (_isDisposed) return true;
      _isLoading = false;
      _isVerifying = false;
      _timer?.cancel();
      notifyListeners();
      return true;
    } on AuthException catch (e) {
      if (_isDisposed) return false;
      _isLoading = false;
      _isVerifying = false;
      _lastAuthException = e;
      _rawErrorMessage = e.code ?? 'AUTH_ERROR';
      notifyListeners();
      return false;
    } catch (e) {
      if (_isDisposed) return false;
      _isLoading = false;
      _isVerifying = false;
      _hasGenericError = true;
      _rawErrorMessage = 'AUTH_ERROR';
      notifyListeners();
      return false;
    }
  }

  /// Resends OTP if cooldown has elapsed.
  Future<bool> resendOtp() async {
    if (!canResendOtp) return false;
    return sendOtp(_phone);
  }

  void _startResendTimer(int seconds) {
    _timer?.cancel();
    _resendCountdown = seconds;
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_isDisposed) {
        timer.cancel();
        return;
      }
      if (_resendCountdown > 0) {
        _resendCountdown--;
        notifyListeners();
      } else {
        timer.cancel();
      }
    });
  }

  void reset() {
    _timer?.cancel();
    _phone = '';
    _otp = '';
    _isLoading = false;
    _isVerifying = false;
    _clearError();
    _resendCountdown = 0;
    if (!_isDisposed) {
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _isDisposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
