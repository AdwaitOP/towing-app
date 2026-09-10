// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Hindi (`hi`).
class AppLocalizationsHi extends AppLocalizations {
  AppLocalizationsHi([String locale = 'hi']) : super(locale);

  @override
  String get appName => 'टोइंग ड्राइवर';

  @override
  String get phoneNumber => 'फ़ोन नंबर';

  @override
  String get phoneNumberHint => '98765 43210';

  @override
  String get sendOtp => 'ओटीपी भेजें';

  @override
  String get enterOtp => '6-अंकों का ओटीपी दर्ज करें';

  @override
  String otpSentTo(String phone) {
    return 'व्हाट्सएप पर ओटीपी भेजा गया: $phone';
  }

  @override
  String get verifyOtp => 'ओटीपी सत्यापित करें';

  @override
  String get resendOtp => 'ओटीपी पुनः भेजें';

  @override
  String resendOtpCooldown(int seconds) {
    return '$seconds सेकंड में पुनः भेजें';
  }

  @override
  String get invalidPhone => 'कृपया मान्य 10-अंकों का मोबाइल नंबर दर्ज करें';

  @override
  String get invalidOtp => 'कृपया मान्य 6-अंकों का ओटीपी दर्ज करें';

  @override
  String get otpSent => 'आपके व्हाट्सएप पर ओटीपी भेज दिया गया है';

  @override
  String get otpExpired => 'ओटीपी समाप्त हो गया है। कृपया नया अनुरोध करें।';

  @override
  String get otpAttemptsExceeded =>
      'अधिकतम प्रयास पूरे हो गए हैं। कृपया नया ओटीपी मंगाएं।';

  @override
  String get otpSendBlocked =>
      'बहुत अधिक ओटीपी अनुरोध। कृपया कुछ समय बाद प्रयास करें।';

  @override
  String get otpResendCooldown =>
      'कृपया अगला ओटीपी मांगने से पहले प्रतीक्षा करें।';

  @override
  String get otpDeliveryFailed =>
      'व्हाट्सएप पर ओटीपी भेजने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get profileSetup => 'ड्राइवर प्रोफ़ाइल सेटअप';

  @override
  String get profileSetupSubtitle =>
      'टोइंग डिस्पैच शुरू करने के लिए अपनी प्रोफ़ाइल पूरी करें।';

  @override
  String get driverName => 'पूरा नाम';

  @override
  String get driverNameHint => 'अपना पूरा नाम दर्ज करें';

  @override
  String get driverNameRequired => 'पूरा नाम आवश्यक है';

  @override
  String get truckType => 'टो ट्रक का प्रकार';

  @override
  String get truckTypeFlatbed => 'फ्लैटबेड टो ट्रक';

  @override
  String get truckTypeTochan => 'तोचन (अंडर-लिफ्ट)';

  @override
  String get truckTypeHydraulic => 'हाइड्रोलिक लिफ्ट';

  @override
  String get truckTypeCrane => 'क्रेन रिकवरी';

  @override
  String get vehicleNumber => 'गाड़ी का नंबर';

  @override
  String get vehicleNumberHint => 'MH 46 AB 1234';

  @override
  String get vehicleNumberRequired => 'गाड़ी का नंबर आवश्यक है';

  @override
  String get continueButton => 'आगे बढ़ें';

  @override
  String get saving => 'सहेजा जा रहा है...';

  @override
  String get logout => 'लॉगआउट';

  @override
  String get loading => 'लोड हो रहा है...';

  @override
  String get retry => 'पुनः प्रयास करें';

  @override
  String get genericNetworkError =>
      'नेटवर्क त्रुटि। कृपया अपना इंटरनेट कनेक्शन जांचें।';

  @override
  String get authFailed => 'प्रमाणीकरण विफल रहा। कृपया पुनः प्रयास करें।';

  @override
  String get driverSetupComplete => 'ड्राइवर ऐप सेटअप पूरा हुआ';

  @override
  String get stage1Subtitle =>
      'आपकी प्रोफ़ाइल सहेजी गई है। अगला चरण: केवाईसी और सत्यापन।';

  @override
  String get changePhoneNumber => 'फ़ोन नंबर बदलें';

  @override
  String get statusOffDuty => 'ड्यूटी बंद';

  @override
  String get dutyStatus => 'ड्यूटी स्थिति';

  @override
  String get selectLanguage => 'भाषा';

  @override
  String get profileLoadError =>
      'ड्राइवर प्रोफ़ाइल लोड करने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get profileSaveError =>
      'ड्राइवर प्रोफ़ाइल सहेजने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get profileMalformedError =>
      'ड्राइवर प्रोफ़ाइल डेटा अमान्य है। कृपया सहायता से संपर्क करें।';
}
