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
