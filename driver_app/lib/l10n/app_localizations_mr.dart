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
}
