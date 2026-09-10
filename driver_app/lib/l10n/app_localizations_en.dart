// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appName => 'Towing Driver';

  @override
  String get phoneNumber => 'Phone Number';

  @override
  String get phoneNumberHint => '98765 43210';

  @override
  String get sendOtp => 'Send OTP';

  @override
  String get enterOtp => 'Enter 6-Digit OTP';

  @override
  String otpSentTo(String phone) {
    return 'OTP sent via WhatsApp to $phone';
  }

  @override
  String get verifyOtp => 'Verify OTP';

  @override
  String get resendOtp => 'Resend OTP';

  @override
  String resendOtpCooldown(int seconds) {
    return 'Resend in ${seconds}s';
  }

  @override
  String get invalidPhone => 'Please enter a valid 10-digit mobile number';

  @override
  String get invalidOtp => 'Please enter a valid 6-digit OTP';

  @override
  String get otpSent => 'OTP has been sent to your WhatsApp';

  @override
  String get otpExpired => 'OTP has expired. Please request a new one.';

  @override
  String get otpAttemptsExceeded =>
      'Maximum attempts exceeded. Please request a new OTP.';

  @override
  String get otpSendBlocked => 'Too many OTP requests. Please try again later.';

  @override
  String get otpResendCooldown => 'Please wait before requesting another OTP.';

  @override
  String get otpDeliveryFailed =>
      'Failed to deliver OTP via WhatsApp. Please try again.';

  @override
  String get profileSetup => 'Driver Profile Setup';

  @override
  String get profileSetupSubtitle =>
      'Complete your profile to get started with towing dispatch.';

  @override
  String get driverName => 'Full Name';

  @override
  String get driverNameHint => 'Enter your full name';

  @override
  String get driverNameRequired => 'Full name is required';

  @override
  String get truckType => 'Tow Truck Type';

  @override
  String get truckTypeFlatbed => 'Flatbed Tow Truck';

  @override
  String get truckTypeTochan => 'Tochan (Under-lift)';

  @override
  String get truckTypeHydraulic => 'Hydraulic Lift';

  @override
  String get truckTypeCrane => 'Crane Recovery';

  @override
  String get vehicleNumber => 'Vehicle Registration Number';

  @override
  String get vehicleNumberHint => 'MH 46 AB 1234';

  @override
  String get vehicleNumberRequired => 'Vehicle number is required';

  @override
  String get continueButton => 'Continue';

  @override
  String get saving => 'Saving...';

  @override
  String get logout => 'Logout';

  @override
  String get loading => 'Loading...';

  @override
  String get retry => 'Retry';

  @override
  String get genericNetworkError =>
      'Network connection error. Please check your internet connection.';

  @override
  String get authFailed => 'Authentication failed. Please try again.';

  @override
  String get driverSetupComplete => 'Driver app setup complete';

  @override
  String get stage1Subtitle =>
      'Your profile has been saved. Next stage: KYC & Verification.';

  @override
  String get changePhoneNumber => 'Change phone number';

  @override
  String get statusOffDuty => 'Off Duty';

  @override
  String get dutyStatus => 'Duty Status';

  @override
  String get selectLanguage => 'Language';

  @override
  String get profileLoadError =>
      'Failed to load driver profile. Please try again.';

  @override
  String get profileSaveError =>
      'Failed to save driver profile. Please try again.';

  @override
  String get profileMalformedError =>
      'Driver profile data is invalid. Please contact support.';
}
