// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Marathi (`mr`).
class AppLocalizationsMr extends AppLocalizations {
  AppLocalizationsMr([String locale = 'mr']) : super(locale);

  @override
  String get appName => 'टोईंग ड्रायव्हर';

  @override
  String get phoneNumber => 'फोन नंबर';

  @override
  String get phoneNumberHint => '98765 43210';

  @override
  String get sendOtp => 'ओटीपी पाठवा';

  @override
  String get enterOtp => '६-अंकी ओटीपी टाका';

  @override
  String otpSentTo(String phone) {
    return 'व्हॉट्सॲपवर ओटीपी पाठवला: $phone';
  }

  @override
  String get verifyOtp => 'ओटीपी तपासा';

  @override
  String get resendOtp => 'ओटीपी पुन्हा पाठवा';

  @override
  String resendOtpCooldown(int seconds) {
    return '$seconds सेकंदात पुन्हा पाठवा';
  }

  @override
  String get invalidPhone => 'कृपया वैध १०-अंकी मोबाईल नंबर टाका';

  @override
  String get invalidOtp => 'कृपया वैध ६-अंकी ओटीपी टाका';

  @override
  String get otpSent => 'आपल्या व्हॉट्सॲपवर ओटीपी पाठवला गेला आहे';

  @override
  String get otpExpired => 'ओटीपी कालबाह्य झाला आहे. कृपया नवीन ओटीपी मागवा.';

  @override
  String get otpAttemptsExceeded =>
      'जास्तीत जास्त प्रयत्न झाले आहेत. कृपया नवीन ओटीपी मागवा.';

  @override
  String get otpSendBlocked =>
      'खूप जास्त विनंत्या झाल्या आहेत. कृपया थोड्या वेळाने प्रयत्न करा.';

  @override
  String get otpResendCooldown =>
      'कृपया पुढील ओटीपी मागण्यापूर्वी थोडा वेळ थांबा.';

  @override
  String get otpDeliveryFailed =>
      'व्हॉट्सॲपवर ओटीपी पाठवण्यात अयशस्वी. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get profileSetup => 'ड्रायव्हर प्रोफाईल सेटअप';

  @override
  String get profileSetupSubtitle =>
      'टोईंग डिस्पॅच सुरू करण्यासाठी आपले प्रोफाईल पूर्ण करा.';

  @override
  String get driverName => 'पूर्ण नाव';

  @override
  String get driverNameHint => 'आपले पूर्ण नाव टाका';

  @override
  String get driverNameRequired => 'पूर्ण नाव आवश्यक आहे';

  @override
  String get truckType => 'टो ट्रकचा प्रकार';

  @override
  String get truckTypeFlatbed => 'फ्लॅटबेड टो ट्रक';

  @override
  String get truckTypeTochan => 'तोचन (अंडर-लिफ्ट)';

  @override
  String get truckTypeHydraulic => 'हायड्रॉलिक लिफ्ट';

  @override
  String get truckTypeCrane => 'क्रेन रिकव्हरी';

  @override
  String get vehicleNumber => 'गाडी क्रमांक';

  @override
  String get vehicleNumberHint => 'MH 46 AB 1234';

  @override
  String get vehicleNumberRequired => 'गाडी क्रमांक आवश्यक आहे';

  @override
  String get continueButton => 'पुढे जा';

  @override
  String get saving => 'जतन करत आहे...';

  @override
  String get logout => 'लॉगआउट';

  @override
  String get loading => 'लोड होत आहे...';

  @override
  String get retry => 'पुन्हा प्रयत्न करा';

  @override
  String get genericNetworkError =>
      'नेटवर्क त्रुटी. कृपया आपले इंटरनेट कनेक्शन तपासा.';

  @override
  String get authFailed => 'प्रमाणीकरण अयशस्वी झाले. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get driverSetupComplete => 'ड्रायव्हर ॲप सेटअप पूर्ण झाले';

  @override
  String get stage1Subtitle =>
      'आपले प्रोफाईल जतन झाले आहे. पुढील टप्पा: केवायसी आणि पडताळणी.';

  @override
  String get changePhoneNumber => 'फोन नंबर बदला';

  @override
  String get statusOffDuty => 'ड्युटी बंद';

  @override
  String get dutyStatus => 'ड्युटी स्थिती';

  @override
  String get selectLanguage => 'भाषा';

  @override
  String get profileLoadError =>
      'ड्रायव्हर प्रोफाईल लोड करण्यात अयशस्वी. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get profileSaveError =>
      'ड्रायव्हर प्रोफाईल जतन करण्यात अयशस्वी. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get profileMalformedError =>
      'ड्रायव्हर प्रोफाईल डेटा अवैध आहे. कृपया समर्थनाशी संपर्क साधा.';

  @override
  String get kycVerificationTitle => 'चालक पडताळणी';

  @override
  String get kycConsentSubtitle =>
      'टोईंग कार्ये स्वीकारण्यापूर्वी दस्तऐवज पडताळणी आवश्यक आहे.';

  @override
  String get kycConsentNotice =>
      'गोपनीयता आणि संमती सूचना: आपले दस्तऐवज आणि सेल्फी केवळ ड्रायव्हर पडताळणी, सुरक्षा आणि फसवणूक प्रतिबंधासाठी संकलित केले जातात. सर्व सबमिशन अधिकृत कर्मचाऱ्यांद्वारे तपासले जातात.';

  @override
  String get kycDocIdTitle => 'ड्रायव्हर ओळखपत्र';

  @override
  String get kycDocIdDesc =>
      'आधार कार्ड किंवा ड्रायव्हिंग लायसन्सचा स्पष्ट फोटो (मागील कॅमेरा)';

  @override
  String get kycDocRcTitle => 'वाहन आरसी दस्तऐवज';

  @override
  String get kycDocRcDesc =>
      'आपल्या वाहन नोंदणी प्रमाणपत्राचा (आरसी) स्पष्ट फोटो (मागील कॅमेरा)';

  @override
  String get kycDocSelfieTitle => 'ड्रायव्हर सेल्फी';

  @override
  String get kycDocSelfieDesc =>
      'चांगल्या प्रकाशात आपल्या चेहऱ्याचा पुढील कॅमेरा फोटो';

  @override
  String get kycConsentCheckbox =>
      'मी चालक पडताळणीसाठी माझे ओळखपत्र, वाहन आरसी आणि सेल्फी संकलित आणि प्रक्रिया करण्यास संमती देतो.';

  @override
  String get kycAgreeAndContinue => 'सहमत व्हा आणि पुढे जा';

  @override
  String get cameraPermissionRequired =>
      'पडताळणी दस्तऐवज काढण्यासाठी कॅमेरा परवानगी आवश्यक आहे.';

  @override
  String get cameraUnavailable => 'या डिव्हाइसवर कॅमेरा उपलब्ध नाही.';

  @override
  String get cameraCaptureInstructionId =>
      'आपले ओळखपत्र फ्रेममध्ये व्यवस्थित ठेवा.';

  @override
  String get cameraCaptureInstructionRc =>
      'आपले वाहन आरसी दस्तऐवज फ्रेममध्ये व्यवस्थित ठेवा.';

  @override
  String get cameraCaptureInstructionSelfie =>
      'आपला चेहरा लंबगोलाकार फ्रेममध्ये ठेवा.';

  @override
  String get retake => 'पुन्हा घ्या';

  @override
  String get usePhoto => 'फोटो वापरा';

  @override
  String get capturePhoto => 'फोटो काढा';

  @override
  String get kycReviewTitle => 'दस्तऐवजांचे पुनरावलोकन करा';

  @override
  String get kycReviewSubtitle =>
      'सर्व तपशील स्पष्ट आणि वाचनीय असल्याची खात्री करा.';

  @override
  String get submitVerification => 'पडताळणीसाठी सबमिट करा';

  @override
  String get submittingVerification => 'पडताळणी सबमिट होत आहे...';

  @override
  String get kycPendingTitle => 'पडताळणी प्रलंबित आहे';

  @override
  String get kycPendingSubtitle =>
      'आपले दस्तऐवज सबमिट झाले असून त्यांची तपासणी सुरू आहे. मंजूर झाल्यावर आपल्याला कळवले जाईल.';

  @override
  String get kycPendingNotice =>
      'दस्तऐवज पडताळणीस साधारणपणे काही तास लागतात. मंजुरीनंतर सेवा सुरू होतील.';

  @override
  String get kycRejectedTitle => 'पडताळणी नाकारली';

  @override
  String get kycRejectedSubtitle =>
      'आपली पडताळणी मंजूर झाली नाही. कृपया खालील कारण तपासा आणि नवीन दस्तऐवज सबमिट करा.';

  @override
  String get kycRejectionReasonLabel => 'नाकारण्याचे कारण';

  @override
  String get kycResubmit => 'दस्तऐवज पुन्हा सबमिट करा';

  @override
  String get kycDefaultRejectionReason =>
      'दस्तऐवज अस्पष्ट होते किंवा नोंदणी तपशिलांशी जुळत नव्हते.';

  @override
  String get kycUploadError =>
      'दस्तऐवज अपलोड करण्यात अयशस्वी. कृपया नेटवर्क तपासा आणि पुन्हा प्रयत्न करा.';

  @override
  String get kycSubmissionError =>
      'पडताळणी सबमिशन अयशस्वी झाले. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get driverLabel => 'चालक';

  @override
  String get vehicleLabel => 'वाहन';

  @override
  String get phoneLabel => 'फोन';

  @override
  String get statusLabel => 'स्थिती';

  @override
  String get underReview => 'तपासणी सुरू आहे';

  @override
  String get captured => 'कॅप्चर केले';

  @override
  String get missing => 'गहाळ';

  @override
  String get cameraLensUnavailable =>
      'या डिव्हाइसवर आवश्यक कॅमेरा लेन्स उपलब्ध नाही.';

  @override
  String get cameraPermissionPermanentlyDenied =>
      'कॅमेरा परवानगी कायमस्वरूपी नाकारली गेली आहे. कृपया सेटिंग्जमध्ये जाऊन सक्षम करा.';

  @override
  String get photoCaptureFailed =>
      'फोटो काढण्यात अयशस्वी. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get kycGenericError =>
      'पडताळणी दरम्यान त्रुटी आली. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get kycSessionExpired => 'सत्र संपले आहे. कृपया पुन्हा लॉग इन करा.';

  @override
  String get kycDocumentsMissing =>
      'सबमिट करण्यापूर्वी सर्व आवश्यक कागदपत्रे कॅप्चर करणे आवश्यक आहे.';

  @override
  String get kycNetworkError =>
      'नेटवर्क त्रुटी. कृपया आपले इंटरनेट कनेक्शन तपासा.';
}
