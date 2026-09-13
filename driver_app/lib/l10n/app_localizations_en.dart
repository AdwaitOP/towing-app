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

  @override
  String get kycVerificationTitle => 'Driver Verification';

  @override
  String get kycConsentSubtitle =>
      'Complete document verification before accepting towing jobs.';

  @override
  String get kycConsentNotice =>
      'Privacy and consent notice: Your documents and selfie are collected strictly for driver verification, towing safety, and fraud prevention. All submissions are reviewed by authorized personnel.';

  @override
  String get kycDocIdTitle => 'Driver Photo ID';

  @override
  String get kycDocIdDesc =>
      'Clear photo of your Aadhaar Card or Driving License (Rear Camera)';

  @override
  String get kycDocRcTitle => 'Vehicle RC Document';

  @override
  String get kycDocRcDesc =>
      'Clear photo of your vehicle registration certificate (Rear Camera)';

  @override
  String get kycDocSelfieTitle => 'Driver Selfie';

  @override
  String get kycDocSelfieDesc =>
      'Front camera photo of your face in good lighting';

  @override
  String get kycConsentCheckbox =>
      'I consent to the collection and processing of my ID, vehicle RC, and selfie for driver verification.';

  @override
  String get kycAgreeAndContinue => 'Agree & Continue';

  @override
  String get cameraPermissionRequired =>
      'Camera permission is required to capture verification documents.';

  @override
  String get cameraUnavailable => 'Camera is unavailable on this device.';

  @override
  String get cameraCaptureInstructionId =>
      'Fit your Driving License or Photo ID inside the frame.';

  @override
  String get cameraCaptureInstructionRc =>
      'Fit your Vehicle RC inside the frame.';

  @override
  String get cameraCaptureInstructionSelfie =>
      'Position your face inside the oval.';

  @override
  String get retake => 'Retake';

  @override
  String get usePhoto => 'Use Photo';

  @override
  String get capturePhoto => 'Capture';

  @override
  String get kycReviewTitle => 'Review Documents';

  @override
  String get kycReviewSubtitle =>
      'Ensure all details are sharp, readable, and not blurred.';

  @override
  String get submitVerification => 'Submit for Verification';

  @override
  String get submittingVerification => 'Submitting verification...';

  @override
  String get kycPendingTitle => 'Verification Under Review';

  @override
  String get kycPendingSubtitle =>
      'Your documents have been submitted and are under review by our team. You will be notified once verified.';

  @override
  String get kycPendingNotice =>
      'Document review typically takes a few hours. Tow dispatch features will activate once approved.';

  @override
  String get kycRejectedTitle => 'Verification Rejected';

  @override
  String get kycRejectedSubtitle =>
      'Your verification was not approved. Please review the reason below and submit fresh documents.';

  @override
  String get kycRejectionReasonLabel => 'Reason for Rejection';

  @override
  String get kycResubmit => 'Resubmit Documents';

  @override
  String get kycDefaultRejectionReason =>
      'Documents were unclear or did not match registration details.';

  @override
  String get kycUploadError =>
      'Failed to upload document. Please check your network and try again.';

  @override
  String get kycSubmissionError =>
      'Verification submission failed. Please try again.';

  @override
  String get driverLabel => 'Driver';

  @override
  String get vehicleLabel => 'Vehicle';

  @override
  String get phoneLabel => 'Phone';

  @override
  String get statusLabel => 'Status';

  @override
  String get underReview => 'Under Review';

  @override
  String get captured => 'Captured';

  @override
  String get missing => 'Missing';

  @override
  String get cameraLensUnavailable =>
      'Required camera lens is not available on this device.';

  @override
  String get cameraPermissionPermanentlyDenied =>
      'Camera permission is permanently denied. Please enable it in Settings.';

  @override
  String get photoCaptureFailed => 'Failed to capture photo. Please try again.';

  @override
  String get kycGenericError =>
      'An error occurred during verification. Please try again.';

  @override
  String get kycSessionExpired => 'Session expired. Please log in again.';

  @override
  String get kycDocumentsMissing =>
      'All required documents must be captured before submission.';

  @override
  String get kycNetworkError =>
      'Network error. Please check your connection and try again.';
}
