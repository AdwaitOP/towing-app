import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_hi.dart';
import 'app_localizations_mr.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('hi'),
    Locale('mr'),
  ];

  /// The title of the driver application
  ///
  /// In en, this message translates to:
  /// **'Towing Driver'**
  String get appName;

  /// Label for phone number input
  ///
  /// In en, this message translates to:
  /// **'Phone Number'**
  String get phoneNumber;

  /// Hint text for phone number input
  ///
  /// In en, this message translates to:
  /// **'98765 43210'**
  String get phoneNumberHint;

  /// Button to send OTP
  ///
  /// In en, this message translates to:
  /// **'Send OTP'**
  String get sendOtp;

  /// Header for OTP entry
  ///
  /// In en, this message translates to:
  /// **'Enter 6-Digit OTP'**
  String get enterOtp;

  /// Subheading indicating where OTP was sent
  ///
  /// In en, this message translates to:
  /// **'OTP sent via WhatsApp to {phone}'**
  String otpSentTo(String phone);

  /// Button to verify OTP
  ///
  /// In en, this message translates to:
  /// **'Verify OTP'**
  String get verifyOtp;

  /// Button to resend OTP
  ///
  /// In en, this message translates to:
  /// **'Resend OTP'**
  String get resendOtp;

  /// Cooldown timer for resending OTP
  ///
  /// In en, this message translates to:
  /// **'Resend in {seconds}s'**
  String resendOtpCooldown(int seconds);

  /// Error message for invalid phone
  ///
  /// In en, this message translates to:
  /// **'Please enter a valid 10-digit mobile number'**
  String get invalidPhone;

  /// Error message for invalid OTP
  ///
  /// In en, this message translates to:
  /// **'Please enter a valid 6-digit OTP'**
  String get invalidOtp;

  /// Confirmation message when OTP is sent
  ///
  /// In en, this message translates to:
  /// **'OTP has been sent to your WhatsApp'**
  String get otpSent;

  /// Error message when OTP expired
  ///
  /// In en, this message translates to:
  /// **'OTP has expired. Please request a new one.'**
  String get otpExpired;

  /// Error message when verification attempts exceeded
  ///
  /// In en, this message translates to:
  /// **'Maximum attempts exceeded. Please request a new OTP.'**
  String get otpAttemptsExceeded;

  /// Error message when OTP sending is temporarily blocked
  ///
  /// In en, this message translates to:
  /// **'Too many OTP requests. Please try again later.'**
  String get otpSendBlocked;

  /// Error message when requesting OTP too quickly
  ///
  /// In en, this message translates to:
  /// **'Please wait before requesting another OTP.'**
  String get otpResendCooldown;

  /// Error message when WhatsApp delivery fails
  ///
  /// In en, this message translates to:
  /// **'Failed to deliver OTP via WhatsApp. Please try again.'**
  String get otpDeliveryFailed;

  /// Header for profile creation screen
  ///
  /// In en, this message translates to:
  /// **'Driver Profile Setup'**
  String get profileSetup;

  /// Subtitle for profile creation screen
  ///
  /// In en, this message translates to:
  /// **'Complete your profile to get started with towing dispatch.'**
  String get profileSetupSubtitle;

  /// Label for driver full name
  ///
  /// In en, this message translates to:
  /// **'Full Name'**
  String get driverName;

  /// Hint for driver full name
  ///
  /// In en, this message translates to:
  /// **'Enter your full name'**
  String get driverNameHint;

  /// Validation error for empty driver name
  ///
  /// In en, this message translates to:
  /// **'Full name is required'**
  String get driverNameRequired;

  /// Label for truck type selector
  ///
  /// In en, this message translates to:
  /// **'Tow Truck Type'**
  String get truckType;

  /// Flatbed truck label
  ///
  /// In en, this message translates to:
  /// **'Flatbed Tow Truck'**
  String get truckTypeFlatbed;

  /// Tochan truck label
  ///
  /// In en, this message translates to:
  /// **'Tochan (Under-lift)'**
  String get truckTypeTochan;

  /// Hydraulic truck label
  ///
  /// In en, this message translates to:
  /// **'Hydraulic Lift'**
  String get truckTypeHydraulic;

  /// Crane recovery truck label
  ///
  /// In en, this message translates to:
  /// **'Crane Recovery'**
  String get truckTypeCrane;

  /// Label for vehicle registration number
  ///
  /// In en, this message translates to:
  /// **'Vehicle Registration Number'**
  String get vehicleNumber;

  /// Hint for vehicle registration number
  ///
  /// In en, this message translates to:
  /// **'MH 46 AB 1234'**
  String get vehicleNumberHint;

  /// Validation error for empty vehicle number
  ///
  /// In en, this message translates to:
  /// **'Vehicle number is required'**
  String get vehicleNumberRequired;

  /// Text for continue/submit button
  ///
  /// In en, this message translates to:
  /// **'Continue'**
  String get continueButton;

  /// Loading label when saving profile
  ///
  /// In en, this message translates to:
  /// **'Saving...'**
  String get saving;

  /// Button to sign out
  ///
  /// In en, this message translates to:
  /// **'Logout'**
  String get logout;

  /// Generic loading message
  ///
  /// In en, this message translates to:
  /// **'Loading...'**
  String get loading;

  /// Button to retry action
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get retry;

  /// Generic network error message
  ///
  /// In en, this message translates to:
  /// **'Network connection error. Please check your internet connection.'**
  String get genericNetworkError;

  /// Generic authentication failure message
  ///
  /// In en, this message translates to:
  /// **'Authentication failed. Please try again.'**
  String get authFailed;

  /// Header indicating Stage 1 setup is complete
  ///
  /// In en, this message translates to:
  /// **'Driver app setup complete'**
  String get driverSetupComplete;

  /// Subtitle on Stage 1 placeholder screen
  ///
  /// In en, this message translates to:
  /// **'Your profile has been saved. Next stage: KYC & Verification.'**
  String get stage1Subtitle;

  /// Button to go back and change phone number
  ///
  /// In en, this message translates to:
  /// **'Change phone number'**
  String get changePhoneNumber;

  /// Duty status off
  ///
  /// In en, this message translates to:
  /// **'Off Duty'**
  String get statusOffDuty;

  /// Label for duty status field
  ///
  /// In en, this message translates to:
  /// **'Duty Status'**
  String get dutyStatus;

  /// Label for language selector
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get selectLanguage;

  /// Error message when loading profile from Firestore fails
  ///
  /// In en, this message translates to:
  /// **'Failed to load driver profile. Please try again.'**
  String get profileLoadError;

  /// Error message when creating/saving profile fails
  ///
  /// In en, this message translates to:
  /// **'Failed to save driver profile. Please try again.'**
  String get profileSaveError;

  /// Error message when driver profile is corrupted or malformed
  ///
  /// In en, this message translates to:
  /// **'Driver profile data is invalid. Please contact support.'**
  String get profileMalformedError;

  /// Title for the KYC driver verification screens
  ///
  /// In en, this message translates to:
  /// **'Driver Verification'**
  String get kycVerificationTitle;

  /// Subtitle on KYC consent screen
  ///
  /// In en, this message translates to:
  /// **'Complete document verification before accepting towing jobs.'**
  String get kycConsentSubtitle;

  /// Privacy and purpose notice on KYC consent screen
  ///
  /// In en, this message translates to:
  /// **'Privacy and consent notice: Your documents and selfie are collected strictly for driver verification, towing safety, and fraud prevention. All submissions are reviewed by authorized personnel.'**
  String get kycConsentNotice;

  /// Title for ID card upload card
  ///
  /// In en, this message translates to:
  /// **'Driver Photo ID'**
  String get kycDocIdTitle;

  /// Description for ID card upload card
  ///
  /// In en, this message translates to:
  /// **'Clear photo of your Aadhaar Card or Driving License (Rear Camera)'**
  String get kycDocIdDesc;

  /// Title for vehicle RC upload card
  ///
  /// In en, this message translates to:
  /// **'Vehicle RC Document'**
  String get kycDocRcTitle;

  /// Description for vehicle RC upload card
  ///
  /// In en, this message translates to:
  /// **'Clear photo of your vehicle registration certificate (Rear Camera)'**
  String get kycDocRcDesc;

  /// Title for driver selfie upload card
  ///
  /// In en, this message translates to:
  /// **'Driver Selfie'**
  String get kycDocSelfieTitle;

  /// Description for driver selfie upload card
  ///
  /// In en, this message translates to:
  /// **'Front camera photo of your face in good lighting'**
  String get kycDocSelfieDesc;

  /// Consent declaration checkbox label
  ///
  /// In en, this message translates to:
  /// **'I consent to the collection and processing of my ID, vehicle RC, and selfie for driver verification.'**
  String get kycConsentCheckbox;

  /// Button to accept consent and start capture
  ///
  /// In en, this message translates to:
  /// **'Agree & Continue'**
  String get kycAgreeAndContinue;

  /// Error message when camera permission is denied
  ///
  /// In en, this message translates to:
  /// **'Camera permission is required to capture verification documents.'**
  String get cameraPermissionRequired;

  /// Error message when camera hardware is unavailable
  ///
  /// In en, this message translates to:
  /// **'Camera is unavailable on this device.'**
  String get cameraUnavailable;

  /// Camera overlay instruction for ID card
  ///
  /// In en, this message translates to:
  /// **'Fit your Driving License or Photo ID inside the frame.'**
  String get cameraCaptureInstructionId;

  /// Camera overlay instruction for RC document
  ///
  /// In en, this message translates to:
  /// **'Fit your Vehicle RC inside the frame.'**
  String get cameraCaptureInstructionRc;

  /// Camera overlay instruction for selfie
  ///
  /// In en, this message translates to:
  /// **'Position your face inside the oval.'**
  String get cameraCaptureInstructionSelfie;

  /// Button to retake a photo
  ///
  /// In en, this message translates to:
  /// **'Retake'**
  String get retake;

  /// Button to accept captured photo
  ///
  /// In en, this message translates to:
  /// **'Use Photo'**
  String get usePhoto;

  /// Button to capture camera snapshot
  ///
  /// In en, this message translates to:
  /// **'Capture'**
  String get capturePhoto;

  /// Title for KYC review screen
  ///
  /// In en, this message translates to:
  /// **'Review Documents'**
  String get kycReviewTitle;

  /// Subtitle for KYC review screen
  ///
  /// In en, this message translates to:
  /// **'Ensure all details are sharp, readable, and not blurred.'**
  String get kycReviewSubtitle;

  /// Button to submit KYC documents
  ///
  /// In en, this message translates to:
  /// **'Submit for Verification'**
  String get submitVerification;

  /// Progress label during KYC upload and submission
  ///
  /// In en, this message translates to:
  /// **'Submitting verification...'**
  String get submittingVerification;

  /// Title on KYC pending screen
  ///
  /// In en, this message translates to:
  /// **'Verification Under Review'**
  String get kycPendingTitle;

  /// Subtitle on KYC pending screen
  ///
  /// In en, this message translates to:
  /// **'Your documents have been submitted and are under review by our team. You will be notified once verified.'**
  String get kycPendingSubtitle;

  /// Notice text on KYC pending screen
  ///
  /// In en, this message translates to:
  /// **'Document review typically takes a few hours. Tow dispatch features will activate once approved.'**
  String get kycPendingNotice;

  /// Title on KYC rejected screen
  ///
  /// In en, this message translates to:
  /// **'Verification Rejected'**
  String get kycRejectedTitle;

  /// Subtitle on KYC rejected screen
  ///
  /// In en, this message translates to:
  /// **'Your verification was not approved. Please review the reason below and submit fresh documents.'**
  String get kycRejectedSubtitle;

  /// Label for rejection reason box
  ///
  /// In en, this message translates to:
  /// **'Reason for Rejection'**
  String get kycRejectionReasonLabel;

  /// Button to start re-verification flow
  ///
  /// In en, this message translates to:
  /// **'Resubmit Documents'**
  String get kycResubmit;

  /// Fallback rejection reason if none provided by admin
  ///
  /// In en, this message translates to:
  /// **'Documents were unclear or did not match registration details.'**
  String get kycDefaultRejectionReason;

  /// Error message when storage upload fails
  ///
  /// In en, this message translates to:
  /// **'Failed to upload document. Please check your network and try again.'**
  String get kycUploadError;

  /// Error message when callable submission fails
  ///
  /// In en, this message translates to:
  /// **'Verification submission failed. Please try again.'**
  String get kycSubmissionError;

  /// Label for driver name in details table
  ///
  /// In en, this message translates to:
  /// **'Driver'**
  String get driverLabel;

  /// Label for vehicle number in details table
  ///
  /// In en, this message translates to:
  /// **'Vehicle'**
  String get vehicleLabel;

  /// Label for phone number in details table
  ///
  /// In en, this message translates to:
  /// **'Phone'**
  String get phoneLabel;

  /// Label for status in details table
  ///
  /// In en, this message translates to:
  /// **'Status'**
  String get statusLabel;

  /// Status text indicating documents are under review
  ///
  /// In en, this message translates to:
  /// **'Under Review'**
  String get underReview;

  /// Status label indicating photo has been captured
  ///
  /// In en, this message translates to:
  /// **'Captured'**
  String get captured;

  /// Status label indicating photo is missing
  ///
  /// In en, this message translates to:
  /// **'Missing'**
  String get missing;

  /// Error message when required camera lens direction is missing
  ///
  /// In en, this message translates to:
  /// **'Required camera lens is not available on this device.'**
  String get cameraLensUnavailable;

  /// Error message when camera permission is permanently denied
  ///
  /// In en, this message translates to:
  /// **'Camera permission is permanently denied. Please enable it in Settings.'**
  String get cameraPermissionPermanentlyDenied;

  /// Error message when taking photo fails
  ///
  /// In en, this message translates to:
  /// **'Failed to capture photo. Please try again.'**
  String get photoCaptureFailed;

  /// Generic KYC error message
  ///
  /// In en, this message translates to:
  /// **'An error occurred during verification. Please try again.'**
  String get kycGenericError;

  /// Error message when user session expires during KYC
  ///
  /// In en, this message translates to:
  /// **'Session expired. Please log in again.'**
  String get kycSessionExpired;

  /// Error message when documents are missing upon submission
  ///
  /// In en, this message translates to:
  /// **'All required documents must be captured before submission.'**
  String get kycDocumentsMissing;

  /// Error message when network error occurs during KYC
  ///
  /// In en, this message translates to:
  /// **'Network error. Please check your connection and try again.'**
  String get kycNetworkError;

  /// Title of the dispatch hub screen
  ///
  /// In en, this message translates to:
  /// **'Dispatch Hub'**
  String get dispatchHub;

  /// Label for ON DUTY status
  ///
  /// In en, this message translates to:
  /// **'ON DUTY'**
  String get onDuty;

  /// Label for OFF DUTY status
  ///
  /// In en, this message translates to:
  /// **'OFF DUTY'**
  String get offDuty;

  /// Button label to transition to ON DUTY
  ///
  /// In en, this message translates to:
  /// **'GO ON DUTY'**
  String get goOnDuty;

  /// Button label to transition to OFF DUTY
  ///
  /// In en, this message translates to:
  /// **'GO OFF DUTY'**
  String get goOffDuty;

  /// Detailed status when driver is on duty
  ///
  /// In en, this message translates to:
  /// **'You are ON DUTY and available for towing requests.'**
  String get hubStatusOnDuty;

  /// Detailed status when driver is off duty
  ///
  /// In en, this message translates to:
  /// **'You are OFF DUTY. Go ON DUTY to receive dispatches.'**
  String get hubStatusOffDuty;

  /// Title for background location disclosure dialog
  ///
  /// In en, this message translates to:
  /// **'Location Access & Dispatch'**
  String get locationDisclosureTitle;

  /// Body text explaining background location collection
  ///
  /// In en, this message translates to:
  /// **'Towing Driver collects location data to find nearby towing jobs, calculate routes, and update your position while ON DUTY. This location tracking continues even when the app is in the background or closed while you are ON DUTY.'**
  String get locationDisclosureBody;

  /// Continue button label
  ///
  /// In en, this message translates to:
  /// **'Continue'**
  String get continueAction;

  /// Not now button label
  ///
  /// In en, this message translates to:
  /// **'Not Now'**
  String get notNowAction;

  /// Cancel button label
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancelAction;

  /// Error message when location permission is not granted
  ///
  /// In en, this message translates to:
  /// **'Location permission is required to go ON DUTY.'**
  String get locationPermissionRequired;

  /// Error message when location permission is permanently denied
  ///
  /// In en, this message translates to:
  /// **'Location permission is permanently denied. Please enable it in Settings to go ON DUTY.'**
  String get locationPermissionPermanentlyDenied;

  /// Error message when device location services are disabled
  ///
  /// In en, this message translates to:
  /// **'Location services are turned off. Please enable GPS/Location in Settings.'**
  String get locationServicesDisabled;

  /// Error message when background location permission is denied
  ///
  /// In en, this message translates to:
  /// **'Background location permission is required to receive dispatches while navigating.'**
  String get backgroundLocationRequired;

  /// Error message when notification permission is denied
  ///
  /// In en, this message translates to:
  /// **'Notification permission is required to run the foreground dispatch service.'**
  String get notificationPermissionRequired;

  /// Button label to open system settings
  ///
  /// In en, this message translates to:
  /// **'Open Settings'**
  String get openSettings;

  /// Indicator text when location tracking is active
  ///
  /// In en, this message translates to:
  /// **'Location Tracking Active'**
  String get trackingActive;

  /// Indicator text when location tracking cannot run
  ///
  /// In en, this message translates to:
  /// **'Location Tracking Unavailable'**
  String get trackingUnavailable;

  /// Banner message when driver is temporarily banned
  ///
  /// In en, this message translates to:
  /// **'You are temporarily paused until {time} due to cancellations.'**
  String temporaryBanBanner(String time);

  /// Error message preventing off duty transition during active job
  ///
  /// In en, this message translates to:
  /// **'Cannot go off duty while on an active job.'**
  String get cannotGoOffDutyActiveJob;

  /// Error message when duty state reconciliation fails
  ///
  /// In en, this message translates to:
  /// **'Unable to reconcile duty state. Please check your connection or restart the app.'**
  String get reconciliationFailed;

  /// Title for battery optimization card
  ///
  /// In en, this message translates to:
  /// **'Battery Optimization'**
  String get batteryOptimizationTitle;

  /// Subtitle explaining battery optimization impact
  ///
  /// In en, this message translates to:
  /// **'For reliable background tracking, ensure battery optimization is set to Unrestricted.'**
  String get batteryOptimizationSubtitle;

  /// Button to open battery optimization settings
  ///
  /// In en, this message translates to:
  /// **'Battery Settings'**
  String get batteryOptimizationAction;

  /// Foreground service notification title
  ///
  /// In en, this message translates to:
  /// **'Towing Driver'**
  String get foregroundNotificationTitle;

  /// Foreground service notification content
  ///
  /// In en, this message translates to:
  /// **'Sharing live location for dispatch'**
  String get foregroundNotificationText;

  /// Placeholder text when map fails or is disabled
  ///
  /// In en, this message translates to:
  /// **'Map preview is currently unavailable.'**
  String get mapUnavailable;

  /// Placeholder subtitle when mapbox token is empty
  ///
  /// In en, this message translates to:
  /// **'Mapbox access token is not configured.'**
  String get mapTokenMissing;

  /// Loading indicator text during duty state transition
  ///
  /// In en, this message translates to:
  /// **'Updating duty status...'**
  String get dutyTransitionInProgress;

  /// Error message when foreground service startup fails
  ///
  /// In en, this message translates to:
  /// **'Failed to start location service. Please try again.'**
  String get dutyServiceStartupFailed;

  /// Notice when on duty in Firestore but location tracking is unavailable
  ///
  /// In en, this message translates to:
  /// **'Duty status needs attention — live location unavailable'**
  String get dutyAttentionRequired;

  /// Error message when logout is blocked by an active job
  ///
  /// In en, this message translates to:
  /// **'Cannot log out while an active job is assigned.'**
  String get logoutBlockedActiveJob;

  /// Error message when logout is blocked by a pending offer
  ///
  /// In en, this message translates to:
  /// **'Cannot log out while a job offer is pending.'**
  String get logoutBlockedActiveOffer;

  /// Error message when duty deactivation fails during logout
  ///
  /// In en, this message translates to:
  /// **'Failed to end duty session safely. Please try again.'**
  String get logoutFailedDutyTransition;

  /// Title of the incoming job offer sheet
  ///
  /// In en, this message translates to:
  /// **'Incoming Job Offer'**
  String get incomingOfferTitle;

  /// Badge text when the offer has expired
  ///
  /// In en, this message translates to:
  /// **'EXPIRED'**
  String get offerExpired;

  /// Countdown timer badge for expiring offer
  ///
  /// In en, this message translates to:
  /// **'{seconds}s remaining'**
  String offerExpiringIn(int seconds);

  /// Truthful warning banner when wallet balance is insufficient for offer commission
  ///
  /// In en, this message translates to:
  /// **'Insufficient wallet balance. Deposit ₹{commission} to accept this offer.'**
  String insufficientWalletForOffer(String commission);

  /// Label for pickup coordinates or address
  ///
  /// In en, this message translates to:
  /// **'Pickup Location'**
  String get pickupLocation;

  /// Label for destination coordinates or address
  ///
  /// In en, this message translates to:
  /// **'Destination'**
  String get destinationLocation;

  /// Label for distance to pickup
  ///
  /// In en, this message translates to:
  /// **'Distance'**
  String get pickupDistance;

  /// Label for estimated time of arrival to pickup
  ///
  /// In en, this message translates to:
  /// **'ETA'**
  String get pickupEta;

  /// Label for requested truck type
  ///
  /// In en, this message translates to:
  /// **'Truck Type'**
  String get truckTypeLabel;

  /// Label for estimated gross tow fare
  ///
  /// In en, this message translates to:
  /// **'Estimated Fare'**
  String get estimatedEarnings;

  /// Label for platform commission deduction
  ///
  /// In en, this message translates to:
  /// **'Platform Fee'**
  String get commissionFee;

  /// Button to decline incoming job offer
  ///
  /// In en, this message translates to:
  /// **'DECLINE'**
  String get declineOffer;

  /// Button to accept incoming job offer
  ///
  /// In en, this message translates to:
  /// **'ACCEPT JOB'**
  String get acceptOffer;

  /// Button label to retry accept with preserved requestId after network timeout
  ///
  /// In en, this message translates to:
  /// **'RETRY ACCEPT'**
  String get retryAcceptOffer;

  /// Title of active job screen
  ///
  /// In en, this message translates to:
  /// **'Active Job'**
  String get activeJobTitle;

  /// Status badge for newly assigned active job
  ///
  /// In en, this message translates to:
  /// **'ASSIGNED'**
  String get activeJobStatusAssigned;

  /// Label for job ID identifier
  ///
  /// In en, this message translates to:
  /// **'Job ID'**
  String get jobIdLabel;

  /// Heading for route details card
  ///
  /// In en, this message translates to:
  /// **'Route Details'**
  String get routeDetailsTitle;

  /// Heading for payment summary card
  ///
  /// In en, this message translates to:
  /// **'Fare & Commission'**
  String get paymentSummaryTitle;

  /// Heading for cancellation policy card
  ///
  /// In en, this message translates to:
  /// **'Cancellation Policy'**
  String get cancellationPolicyTitle;

  /// Description of cancellation policy snapshot
  ///
  /// In en, this message translates to:
  /// **'You have {freeCount} free cancellation(s) this month. Late cancellations may incur penalties.'**
  String cancellationPolicyDescription(String freeCount);

  /// Notice explaining Batch 1 presentation state on active job screen
  ///
  /// In en, this message translates to:
  /// **'Batch 1 presentation shell: State tracking active. Action buttons (Start Tow, Complete, Cancel) will activate in Batch 2.'**
  String get activeJobBatchNotice;

  /// Label for driver wallet balance
  ///
  /// In en, this message translates to:
  /// **'Wallet Balance'**
  String get walletBalance;

  /// Button label to top up wallet balance
  ///
  /// In en, this message translates to:
  /// **'Top Up'**
  String get walletTopup;

  /// Title of wallet top-up sheet
  ///
  /// In en, this message translates to:
  /// **'Wallet Top-Up'**
  String get walletTopupTitle;

  /// Label for custom top-up amount text field
  ///
  /// In en, this message translates to:
  /// **'Enter Amount'**
  String get enterTopupAmount;

  /// Label for quick select top-up preset chips
  ///
  /// In en, this message translates to:
  /// **'Quick Select'**
  String get topupQuickAmount;

  /// Button to submit wallet top-up
  ///
  /// In en, this message translates to:
  /// **'Top Up Wallet'**
  String get topupSubmit;

  /// Success message after wallet balance is credited
  ///
  /// In en, this message translates to:
  /// **'Wallet top-up initiated (₹{amount}). Balance will update once confirmed.'**
  String topupSuccess(String amount);

  /// Error message when wallet top-up fails
  ///
  /// In en, this message translates to:
  /// **'Wallet top-up failed: {error}'**
  String topupFailed(String error);

  /// Validation error for top-up amount out of range
  ///
  /// In en, this message translates to:
  /// **'Amount must be between ₹1 and ₹1,00,000'**
  String get topupMinMaxError;

  /// Informational banner when wallet balance is low
  ///
  /// In en, this message translates to:
  /// **'Low wallet balance: {balance}. Top up to accept high-commission jobs.'**
  String lowBalanceWarning(String balance);

  /// Badge indicating driver account is under strict cancellation monitoring
  ///
  /// In en, this message translates to:
  /// **'Strict Mode Active'**
  String get strictModeActive;

  /// Warning in cancellation preview when strict mode is active
  ///
  /// In en, this message translates to:
  /// **'Strict Mode Active: Next cancellation incurs 100% penalty and account suspension.'**
  String get strictModeWarning;

  /// Display count of cancellations in current month
  ///
  /// In en, this message translates to:
  /// **'Cancellations this month: {count}'**
  String monthlyCancellations(String count);

  /// Action button to start towing the customer vehicle
  ///
  /// In en, this message translates to:
  /// **'START TOW'**
  String get startTow;

  /// Action button to mark an in-progress tow complete
  ///
  /// In en, this message translates to:
  /// **'MARK COMPLETE'**
  String get markComplete;

  /// Action button for driver to cancel an accepted job
  ///
  /// In en, this message translates to:
  /// **'CANCEL JOB'**
  String get cancelJob;

  /// Success message displayed when job completes
  ///
  /// In en, this message translates to:
  /// **'Job Completed Successfully'**
  String get jobCompletedSuccess;

  /// Button to return to dispatch hub after job completion
  ///
  /// In en, this message translates to:
  /// **'RETURN TO HUB'**
  String get returnToHub;

  /// Notice when customer cancels an assigned job
  ///
  /// In en, this message translates to:
  /// **'Customer cancellation is in progress. No driver penalty applied. Your wallet balance will update once confirmed.'**
  String get customerCancelledNotice;

  /// Title of cancellation preview modal
  ///
  /// In en, this message translates to:
  /// **'Cancellation Preview'**
  String get cancellationPreviewTitle;

  /// Disclaimer indicating preview calculation is non-authoritative
  ///
  /// In en, this message translates to:
  /// **'Estimated preview. The backend server is the sole financial authority.'**
  String get cancellationPreviewNotice;

  /// Count of free cancellations remaining this month
  ///
  /// In en, this message translates to:
  /// **'Free cancellations remaining: {count}'**
  String freeCancellationsRemaining(String count);

  /// Estimated forfeiture amount displayed in preview
  ///
  /// In en, this message translates to:
  /// **'Estimated Forfeiture: ₹{amount}'**
  String estimatedDeduction(String amount);

  /// Estimated refund amount displayed in preview
  ///
  /// In en, this message translates to:
  /// **'Estimated Refund: ₹{amount}'**
  String estimatedRefund(String amount);

  /// Warning in preview when cancellation threshold will be exceeded
  ///
  /// In en, this message translates to:
  /// **'Warning: Cancelling will temporarily suspend your account from duty.'**
  String get banWarning;

  /// Button to confirm driver cancellation
  ///
  /// In en, this message translates to:
  /// **'CONFIRM CANCELLATION'**
  String get confirmCancellation;

  /// Button to dismiss cancellation modal and keep job
  ///
  /// In en, this message translates to:
  /// **'KEEP JOB'**
  String get keepJob;

  /// Status text while action request is in flight
  ///
  /// In en, this message translates to:
  /// **'Please wait...'**
  String get actionInProgress;

  /// Notice that driver cannot cancel after starting tow
  ///
  /// In en, this message translates to:
  /// **'Cancellation is not permitted once tow is in progress.'**
  String get cancelUnavailableInProgress;

  /// Notice that wallet top-up operates in test mode
  ///
  /// In en, this message translates to:
  /// **'Test Mode: Simulates instant payment without real money.'**
  String get testModeNotice;

  /// Button to open external map navigation to customer pickup location
  ///
  /// In en, this message translates to:
  /// **'NAVIGATE TO PICKUP'**
  String get navigateToPickup;

  /// Button to open external map navigation to job drop-off destination
  ///
  /// In en, this message translates to:
  /// **'NAVIGATE TO DESTINATION'**
  String get navigateToDestination;

  /// Error message when external map app fails to open
  ///
  /// In en, this message translates to:
  /// **'Unable to launch external navigation map.'**
  String get navigationLaunchError;

  /// Status badge when tow is in progress
  ///
  /// In en, this message translates to:
  /// **'IN PROGRESS'**
  String get activeJobStatusInProgress;

  /// Status badge when job has completed
  ///
  /// In en, this message translates to:
  /// **'COMPLETED'**
  String get activeJobStatusCompleted;

  /// Status badge when job has been cancelled
  ///
  /// In en, this message translates to:
  /// **'CANCELLED'**
  String get activeJobStatusCancelled;

  /// Notice shown when driver successfully cancels an accepted job
  ///
  /// In en, this message translates to:
  /// **'Job cancelled. Refund: ₹{refund}, Forfeited: ₹{forfeited}'**
  String jobCancelledNotice(String refund, String forfeited);

  /// Button to retry cancellation with same request ID
  ///
  /// In en, this message translates to:
  /// **'RETRY CANCEL'**
  String get retryCancel;

  /// Button to retry wallet top-up with same request ID
  ///
  /// In en, this message translates to:
  /// **'RETRY TOP-UP'**
  String get retryTopup;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'hi', 'mr'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'hi':
      return AppLocalizationsHi();
    case 'mr':
      return AppLocalizationsMr();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
