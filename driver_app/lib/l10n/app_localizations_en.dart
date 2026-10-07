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

  @override
  String get dispatchHub => 'Dispatch Hub';

  @override
  String get onDuty => 'ON DUTY';

  @override
  String get offDuty => 'OFF DUTY';

  @override
  String get goOnDuty => 'GO ON DUTY';

  @override
  String get goOffDuty => 'GO OFF DUTY';

  @override
  String get hubStatusOnDuty =>
      'You are ON DUTY and available for towing requests.';

  @override
  String get hubStatusOffDuty =>
      'You are OFF DUTY. Go ON DUTY to receive dispatches.';

  @override
  String get locationDisclosureTitle => 'Location Access & Dispatch';

  @override
  String get locationDisclosureBody =>
      'Towing Driver collects location data to find nearby towing jobs, calculate routes, and update your position while ON DUTY. This location tracking continues even when the app is in the background or closed while you are ON DUTY.';

  @override
  String get continueAction => 'Continue';

  @override
  String get notNowAction => 'Not Now';

  @override
  String get cancelAction => 'Cancel';

  @override
  String get locationPermissionRequired =>
      'Location permission is required to go ON DUTY.';

  @override
  String get locationPermissionPermanentlyDenied =>
      'Location permission is permanently denied. Please enable it in Settings to go ON DUTY.';

  @override
  String get locationServicesDisabled =>
      'Location services are turned off. Please enable GPS/Location in Settings.';

  @override
  String get backgroundLocationRequired =>
      'Background location permission is required to receive dispatches while navigating.';

  @override
  String get notificationPermissionRequired =>
      'Notification permission is required to run the foreground dispatch service.';

  @override
  String get openSettings => 'Open Settings';

  @override
  String get trackingActive => 'Location Tracking Active';

  @override
  String get trackingUnavailable => 'Location Tracking Unavailable';

  @override
  String temporaryBanBanner(String time) {
    return 'You are temporarily paused until $time due to cancellations.';
  }

  @override
  String get cannotGoOffDutyActiveJob =>
      'Cannot go off duty while on an active job.';

  @override
  String get reconciliationFailed =>
      'Unable to reconcile duty state. Please check your connection or restart the app.';

  @override
  String get batteryOptimizationTitle => 'Battery Optimization';

  @override
  String get batteryOptimizationSubtitle =>
      'For reliable background tracking, ensure battery optimization is set to Unrestricted.';

  @override
  String get batteryOptimizationAction => 'Battery Settings';

  @override
  String get foregroundNotificationTitle => 'Towing Driver';

  @override
  String get foregroundNotificationText => 'Sharing live location for dispatch';

  @override
  String get mapUnavailable => 'Map preview is currently unavailable.';

  @override
  String get mapTokenMissing => 'Mapbox access token is not configured.';

  @override
  String get dutyTransitionInProgress => 'Updating duty status...';

  @override
  String get dutyServiceStartupFailed =>
      'Failed to start location service. Please try again.';

  @override
  String get dutyAttentionRequired =>
      'Duty status needs attention — live location unavailable';

  @override
  String get logoutBlockedActiveJob =>
      'Cannot log out while an active job is assigned.';

  @override
  String get logoutBlockedActiveOffer =>
      'Cannot log out while a job offer is pending.';

  @override
  String get logoutFailedDutyTransition =>
      'Failed to end duty session safely. Please try again.';

  @override
  String get incomingOfferTitle => 'Incoming Job Offer';

  @override
  String get offerExpired => 'EXPIRED';

  @override
  String offerExpiringIn(int seconds) {
    return '${seconds}s remaining';
  }

  @override
  String insufficientWalletForOffer(String commission) {
    return 'Insufficient wallet balance. Deposit ₹$commission to accept this offer.';
  }

  @override
  String get pickupLocation => 'Pickup Location';

  @override
  String get destinationLocation => 'Destination';

  @override
  String get pickupDistance => 'Distance';

  @override
  String get pickupEta => 'ETA';

  @override
  String get truckTypeLabel => 'Truck Type';

  @override
  String get estimatedEarnings => 'Estimated Fare';

  @override
  String get commissionFee => 'Platform Fee';

  @override
  String get declineOffer => 'DECLINE';

  @override
  String get acceptOffer => 'ACCEPT JOB';

  @override
  String get retryAcceptOffer => 'RETRY ACCEPT';

  @override
  String get activeJobTitle => 'Active Job';

  @override
  String get activeJobStatusAssigned => 'ASSIGNED';

  @override
  String get jobIdLabel => 'Job ID';

  @override
  String get routeDetailsTitle => 'Route Details';

  @override
  String get paymentSummaryTitle => 'Fare & Commission';

  @override
  String get cancellationPolicyTitle => 'Cancellation Policy';

  @override
  String cancellationPolicyDescription(String freeCount) {
    return 'You have $freeCount free cancellation(s) this month. Late cancellations may incur penalties.';
  }

  @override
  String get activeJobBatchNotice =>
      'Batch 1 presentation shell: State tracking active. Action buttons (Start Tow, Complete, Cancel) will activate in Batch 2.';

  @override
  String get walletBalance => 'Wallet Balance';

  @override
  String get walletTopup => 'Top Up';

  @override
  String get walletTopupTitle => 'Wallet Top-Up';

  @override
  String get enterTopupAmount => 'Enter Amount';

  @override
  String get topupQuickAmount => 'Quick Select';

  @override
  String get topupSubmit => 'Top Up Wallet';

  @override
  String topupSuccess(String amount) {
    return 'Wallet top-up initiated (₹$amount). Balance will update once confirmed.';
  }

  @override
  String topupFailed(String error) {
    return 'Wallet top-up failed: $error';
  }

  @override
  String get topupMinMaxError => 'Amount must be between ₹1 and ₹1,00,000';

  @override
  String lowBalanceWarning(String balance) {
    return 'Low wallet balance: $balance. Top up to accept high-commission jobs.';
  }

  @override
  String get strictModeActive => 'Strict Mode Active';

  @override
  String get strictModeWarning =>
      'Strict Mode Active: Next cancellation incurs 100% penalty and account suspension.';

  @override
  String monthlyCancellations(String count) {
    return 'Cancellations this month: $count';
  }

  @override
  String get startTow => 'START TOW';

  @override
  String get markComplete => 'MARK COMPLETE';

  @override
  String get cancelJob => 'CANCEL JOB';

  @override
  String get jobCompletedSuccess => 'Job Completed Successfully';

  @override
  String get returnToHub => 'RETURN TO HUB';

  @override
  String get customerCancelledNotice =>
      'Customer cancellation is in progress. No driver penalty applied. Your wallet balance will update once confirmed.';

  @override
  String get cancellationPreviewTitle => 'Cancellation Preview';

  @override
  String get cancellationPreviewNotice =>
      'Estimated preview. The backend server is the sole financial authority.';

  @override
  String freeCancellationsRemaining(String count) {
    return 'Free cancellations remaining: $count';
  }

  @override
  String estimatedDeduction(String amount) {
    return 'Estimated Forfeiture: ₹$amount';
  }

  @override
  String estimatedRefund(String amount) {
    return 'Estimated Refund: ₹$amount';
  }

  @override
  String get banWarning =>
      'Warning: Cancelling will temporarily suspend your account from duty.';

  @override
  String get confirmCancellation => 'CONFIRM CANCELLATION';

  @override
  String get keepJob => 'KEEP JOB';

  @override
  String get actionInProgress => 'Please wait...';

  @override
  String get cancelUnavailableInProgress =>
      'Cancellation is not permitted once tow is in progress.';

  @override
  String get testModeNotice =>
      'Test Mode: Simulates instant payment without real money.';

  @override
  String get navigateToPickup => 'NAVIGATE TO PICKUP';

  @override
  String get navigateToDestination => 'NAVIGATE TO DESTINATION';

  @override
  String get navigationLaunchError =>
      'Unable to launch external navigation map.';

  @override
  String get activeJobStatusInProgress => 'IN PROGRESS';

  @override
  String get activeJobStatusCompleted => 'COMPLETED';

  @override
  String get activeJobStatusCancelled => 'CANCELLED';

  @override
  String jobCancelledNotice(String refund, String forfeited) {
    return 'Job cancelled. Refund: ₹$refund, Forfeited: ₹$forfeited';
  }

  @override
  String get retryCancel => 'RETRY CANCEL';

  @override
  String get retryTopup => 'RETRY TOP-UP';
}
