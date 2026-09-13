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

  @override
  String get kycVerificationTitle => 'चालक सत्यापन';

  @override
  String get kycConsentSubtitle =>
      'टोइंग कार्य स्वीकार करने से पहले दस्तावेज़ सत्यापन आवश्यक है।';

  @override
  String get kycConsentNotice =>
      'गोपनीयता और सहमति सूचना: आपके दस्तावेज़ और सेल्फ़ी केवल पहचान सत्यापन, सुरक्षा और धोखाधड़ी की रोकथाम के लिए एकत्र किए जाते हैं। सभी सबमिशन अधिकृत कर्मियों द्वारा जांचे जाते हैं।';

  @override
  String get kycDocIdTitle => 'ड्राइवर पहचान पत्र';

  @override
  String get kycDocIdDesc =>
      'आधार कार्ड या ड्राइविंग लाइसेंस की स्पष्ट फोटो (रियर कैमरा)';

  @override
  String get kycDocRcTitle => 'वाहन आरसी दस्तावेज़';

  @override
  String get kycDocRcDesc =>
      'अपने वाहन पंजीकरण प्रमाण पत्र (आरसी) की स्पष्ट फोटो (रियर कैमरा)';

  @override
  String get kycDocSelfieTitle => 'चालक की सेल्फ़ी';

  @override
  String get kycDocSelfieDesc =>
      'अच्छी रोशनी में अपने चेहरे की फ्रंट कैमरा फोटो';

  @override
  String get kycConsentCheckbox =>
      'मैं चालक सत्यापन के लिए अपनी आईडी, वाहन आरसी और सेल्फ़ी के संग्रह और प्रसंस्करण की सहमति देता हूँ।';

  @override
  String get kycAgreeAndContinue => 'सहमति दें और आगे बढ़ें';

  @override
  String get cameraPermissionRequired =>
      'सत्यापन दस्तावेज़ खींचने के लिए कैमरा अनुमति आवश्यक है।';

  @override
  String get cameraUnavailable => 'इस डिवाइस पर कैमरा उपलब्ध नहीं है।';

  @override
  String get cameraCaptureInstructionId =>
      'अपना पहचान पत्र फ्रेम के अंदर रखें।';

  @override
  String get cameraCaptureInstructionRc =>
      'अपना वाहन आरसी दस्तावेज़ फ्रेम के अंदर रखें।';

  @override
  String get cameraCaptureInstructionSelfie =>
      'अपना चेहरा अंडाकार फ्रेम के अंदर रखें।';

  @override
  String get retake => 'फिर से लें';

  @override
  String get usePhoto => 'फोटो का उपयोग करें';

  @override
  String get capturePhoto => 'फोटो खींचें';

  @override
  String get kycReviewTitle => 'दस्तावेज़ों की समीक्षा करें';

  @override
  String get kycReviewSubtitle =>
      'सुनिश्चित करें कि सभी विवरण स्पष्ट हैं और धुंधले नहीं हैं।';

  @override
  String get submitVerification => 'सत्यापन के लिए सबमिट करें';

  @override
  String get submittingVerification => 'सत्यापन सबमिट हो रहा है...';

  @override
  String get kycPendingTitle => 'सत्यापन समीक्षाधीन है';

  @override
  String get kycPendingSubtitle =>
      'आपके दस्तावेज़ सबमिट हो गए हैं और समीक्षा की जा रही है। स्वीकृत होने पर आपको सूचित किया जाएगा।';

  @override
  String get kycPendingNotice =>
      'दस्तावेज़ समीक्षा में आमतौर पर कुछ घंटे लगते हैं। स्वीकृति के बाद सेवाएं सक्रिय होंगी।';

  @override
  String get kycRejectedTitle => 'सत्यापन अस्वीकृत';

  @override
  String get kycRejectedSubtitle =>
      'आपका सत्यापन स्वीकृत नहीं हुआ। कृपया नीचे दिए गए कारण की समीक्षा करें और पुनः सबमिट करें।';

  @override
  String get kycRejectionReasonLabel => 'अस्वीकृति का कारण';

  @override
  String get kycResubmit => 'दस्तावेज़ पुनः सबमिट करें';

  @override
  String get kycDefaultRejectionReason =>
      'दस्तावेज़ स्पष्ट नहीं थे या विवरण मेल नहीं खाते थे।';

  @override
  String get kycUploadError =>
      'दस्तावेज़ अपलोड करने में विफल। कृपया नेटवर्क जांचें और पुनः प्रयास करें।';

  @override
  String get kycSubmissionError =>
      'सत्यापन सबमिशन विफल रहा। कृपया पुनः प्रयास करें।';

  @override
  String get driverLabel => 'चालक';

  @override
  String get vehicleLabel => 'वाहन';

  @override
  String get phoneLabel => 'फ़ोन';

  @override
  String get statusLabel => 'स्थिति';

  @override
  String get underReview => 'समीक्षाधीन';

  @override
  String get captured => 'कैप्चर किया गया';

  @override
  String get missing => 'अनुपलब्ध';

  @override
  String get cameraLensUnavailable =>
      'इस डिवाइस पर आवश्यक कैमरा लेंस उपलब्ध नहीं है।';

  @override
  String get cameraPermissionPermanentlyDenied =>
      'कैमरा अनुमति स्थायी रूप से अस्वीकृत है। कृपया सेटिंग्स में जाकर सक्षम करें।';

  @override
  String get photoCaptureFailed =>
      'फ़ोटो लेने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get kycGenericError =>
      'सत्यापन के दौरान एक त्रुटि हुई। कृपया पुनः प्रयास करें।';

  @override
  String get kycSessionExpired => 'सत्र समाप्त हो गया। कृपया पुनः लॉगिन करें।';

  @override
  String get kycDocumentsMissing =>
      'जमा करने से पहले सभी आवश्यक दस्तावेज़ कैप्चर किए जाने चाहिए।';

  @override
  String get kycNetworkError =>
      'नेटवर्क त्रुटि। कृपया अपने इंटरनेट कनेक्शन की जाँच करें।';
}
