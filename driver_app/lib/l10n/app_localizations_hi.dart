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

  @override
  String get dispatchHub => 'डिस्पैच हब';

  @override
  String get onDuty => 'ऑन ड्यूटी';

  @override
  String get offDuty => 'ऑफ ड्यूटी';

  @override
  String get goOnDuty => 'ऑन ड्यूटी जाएं';

  @override
  String get goOffDuty => 'ऑफ ड्यूटी जाएं';

  @override
  String get hubStatusOnDuty =>
      'आप ऑन ड्यूटी हैं और टोइंग अनुरोधों के लिए उपलब्ध हैं।';

  @override
  String get hubStatusOffDuty =>
      'आप ऑफ ड्यूटी हैं। डिस्पैच प्राप्त करने के लिए ऑन ड्यूटी जाएं।';

  @override
  String get locationDisclosureTitle => 'लोकेशन एक्सेस और डिस्पैच';

  @override
  String get locationDisclosureBody =>
      'टोइंग ड्राइवर आस-पास के टोइंग काम खोजने, रूट की गणना करने और ऑन ड्यूटी के दौरान आपकी स्थिति अपडेट करने के लिए लोकेशन डेटा एकत्र करता है। जब आप ऑन ड्यूटी होते हैं, तब ऐप बैकग्राउंड में या बंद होने पर भी यह ट्रैकिंग जारी रह सकती है।';

  @override
  String get continueAction => 'जारी रखें';

  @override
  String get notNowAction => 'अभी नहीं';

  @override
  String get cancelAction => 'रद्द करें';

  @override
  String get locationPermissionRequired =>
      'ऑन ड्यूटी जाने के लिए लोकेशन अनुमति आवश्यक है।';

  @override
  String get locationPermissionPermanentlyDenied =>
      'लोकेशन अनुमति स्थायी रूप से अस्वीकृत है। कृपया ऑन ड्यूटी जाने के लिए सेटिंग्स में इसे सक्षम करें।';

  @override
  String get locationServicesDisabled =>
      'लोकेशन सेवाएं बंद हैं। कृपया सेटिंग्स में जीपीएस/लोकेशन चालू करें।';

  @override
  String get backgroundLocationRequired =>
      'नेविगेशन के दौरान डिस्पैच प्राप्त करने के लिए बैकग्राउंड लोकेशन अनुमति आवश्यक है।';

  @override
  String get notificationPermissionRequired =>
      'फोरग्राउंड डिस्पैच सेवा चलाने के लिए नोटिफिकेशन अनुमति आवश्यक है।';

  @override
  String get openSettings => 'सेटिंग्स खोलें';

  @override
  String get trackingActive => 'लोकेशन ट्रैकिंग सक्रिय है';

  @override
  String get trackingUnavailable => 'लोकेशन ट्रैकिंग अनुपलब्ध है';

  @override
  String temporaryBanBanner(String time) {
    return 'रद्दीकरण के कारण आप $time तक अस्थायी रूप से रुके हुए हैं।';
  }

  @override
  String get cannotGoOffDutyActiveJob =>
      'सक्रिय कार्य के दौरान ऑफ ड्यूटी नहीं जा सकते।';

  @override
  String get reconciliationFailed =>
      'ड्यूटी स्थिति का मिलान करने में असमर्थ। कृपया कनेक्शन जांचें या ऐप पुनः प्रारंभ करें।';

  @override
  String get batteryOptimizationTitle => 'बैटरी ऑप्टिमाइज़ेशन';

  @override
  String get batteryOptimizationSubtitle =>
      'विश्वसनीय बैकग्राउंड ट्रैकिंग के लिए, बैटरी ऑप्टिमाइज़ेशन को अप्रतिबंधित पर सेट करें।';

  @override
  String get batteryOptimizationAction => 'बैटरी सेटिंग्स';

  @override
  String get foregroundNotificationTitle => 'टोइंग ड्राइवर';

  @override
  String get foregroundNotificationText =>
      'डिस्पैच के लिए लाइव लोकेशन साझा कर रहे हैं';

  @override
  String get mapUnavailable => 'मानचित्र पूर्वावलोकन वर्तमान में अनुपलब्ध है।';

  @override
  String get mapTokenMissing => 'मैपबॉक्स एक्सेस टोकन कॉन्फ़िगर नहीं है।';

  @override
  String get dutyTransitionInProgress => 'ड्यूटी स्थिति अपडेट की जा रही है...';

  @override
  String get dutyServiceStartupFailed =>
      'लोकेशन सेवा प्रारंभ करने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get dutyAttentionRequired =>
      'ड्यूटी स्थिति पर ध्यान देने की आवश्यकता है — लाइव स्थान अनुपलब्ध है';

  @override
  String get logoutBlockedActiveJob =>
      'सक्रिय कार्य सौंपे जाने के दौरान आप लॉग आउट नहीं कर सकते।';

  @override
  String get logoutBlockedActiveOffer =>
      'कार्य प्रस्ताव लंबित रहने के दौरान आप लॉग आउट नहीं कर सकते।';

  @override
  String get logoutFailedDutyTransition =>
      'ड्यूटी सत्र सुरक्षित रूप से समाप्त करने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get incomingOfferTitle => 'नया काम का प्रस्ताव';

  @override
  String get offerExpired => 'समाप्त';

  @override
  String offerExpiringIn(int seconds) {
    return '$seconds सेकंड शेष';
  }

  @override
  String insufficientWalletForOffer(String commission) {
    return 'वॉलेट में अपर्याप्त राशि। इस काम को स्वीकार करने के लिए ₹$commission जमा करें।';
  }

  @override
  String get pickupLocation => 'पिकअप स्थान';

  @override
  String get destinationLocation => 'गंतव्य';

  @override
  String get pickupDistance => 'दूरी';

  @override
  String get pickupEta => 'अनुमानित समय';

  @override
  String get truckTypeLabel => 'ट्रक का प्रकार';

  @override
  String get estimatedEarnings => 'अनुमानित किराया';

  @override
  String get commissionFee => 'प्लेटफ़ॉर्म शुल्क';

  @override
  String get declineOffer => 'अस्वीकार करें';

  @override
  String get acceptOffer => 'स्वीकार करें';

  @override
  String get retryAcceptOffer => 'पुनः प्रयास करें';

  @override
  String get activeJobTitle => 'सक्रिय कार्य';

  @override
  String get activeJobStatusAssigned => 'आवंटित';

  @override
  String get jobIdLabel => 'कार्य आईडी';

  @override
  String get routeDetailsTitle => 'मार्ग विवरण';

  @override
  String get paymentSummaryTitle => 'किराया एवं कमीशन';

  @override
  String get cancellationPolicyTitle => 'रद्दीकरण नीति';

  @override
  String cancellationPolicyDescription(String freeCount) {
    return 'इस माह आपके पास $freeCount निःशुल्क रद्दीकरण उपलब्ध हैं। विलंबित रद्दीकरण पर जुर्माना लग सकता है।';
  }

  @override
  String get activeJobBatchNotice =>
      'बैच 1 प्रस्तुति शेल: कार्य ट्रैकिंग सक्रिय है। एक्शन बटन बैच 2 में सक्षम होंगे।';

  @override
  String get walletBalance => 'वॉलेट बैलेंस';

  @override
  String get walletTopup => 'टॉप अप';

  @override
  String get walletTopupTitle => 'वॉलेट टॉप-अप';

  @override
  String get enterTopupAmount => 'राशि दर्ज करें';

  @override
  String get topupQuickAmount => 'त्वरित चयन';

  @override
  String get topupSubmit => 'वॉलेट टॉप अप करें';

  @override
  String topupSuccess(String amount) {
    return 'वॉलेट टॉप-अप शुरू किया गया (₹$amount)। पुष्टि होने पर बैलेंस अपडेट हो जाएगा।';
  }

  @override
  String topupFailed(String error) {
    return 'वॉलेट टॉप-अप विफल: $error';
  }

  @override
  String get topupMinMaxError => 'राशि ₹1 से ₹1,00,000 के बीच होनी चाहिए';

  @override
  String lowBalanceWarning(String balance) {
    return 'कम वॉलेट बैलेंस: $balance। उच्च-कमीशन वाले काम स्वीकार करने के लिए टॉप अप करें।';
  }

  @override
  String get strictModeActive => 'स्ट्रिक्ट मोड सक्रिय';

  @override
  String get strictModeWarning =>
      'स्ट्रिक्ट मोड सक्रिय: अगला रद्दीकरण 100% जुर्माना और खाता निलंबन का कारण बनेगा।';

  @override
  String monthlyCancellations(String count) {
    return 'इस महीने रद्दीकरण: $count';
  }

  @override
  String get startTow => 'टो शुरू करें';

  @override
  String get markComplete => 'पूर्ण चिह्नित करें';

  @override
  String get cancelJob => 'काम रद्द करें';

  @override
  String get jobCompletedSuccess => 'काम सफलतापूर्वक पूरा हुआ';

  @override
  String get returnToHub => 'हब पर वापस जाएं';

  @override
  String get customerCancelledNotice =>
      'ग्राहक द्वारा रद्दीकरण प्रक्रियाधीन है। कोई चालक दंड नहीं लगाया गया। पुष्टि होने पर आपका वॉलेट बैलेंस अपडेट हो जाएगा।';

  @override
  String get cancellationPreviewTitle => 'रद्दीकरण पूर्वावलोकन';

  @override
  String get cancellationPreviewNotice =>
      'अनुमानित पूर्वावलोकन। बैकएंड सर्वर एकमात्र वित्तीय प्राधिकरण है।';

  @override
  String freeCancellationsRemaining(String count) {
    return 'शेष मुफ्त रद्दीकरण: $count';
  }

  @override
  String estimatedDeduction(String amount) {
    return 'अनुमानित जब्ती: ₹$amount';
  }

  @override
  String estimatedRefund(String amount) {
    return 'अनुमानित धनवापसी: ₹$amount';
  }

  @override
  String get banWarning =>
      'चेतावनी: रद्द करने से आपका खाता अस्थायी रूप से ड्यूटी से निलंबित हो जाएगा।';

  @override
  String get confirmCancellation => 'रद्दीकरण की पुष्टि करें';

  @override
  String get keepJob => 'काम जारी रखें';

  @override
  String get actionInProgress => 'कृपया प्रतीक्षा करें...';

  @override
  String get cancelUnavailableInProgress =>
      'एक बार टो प्रगति पर होने के बाद रद्दीकरण की अनुमति नहीं है।';

  @override
  String get testModeNotice =>
      'टेस्ट मोड: वास्तविक पैसे के बिना तत्काल भुगतान का अनुकरण करता है।';

  @override
  String get navigateToPickup => 'पिकअप स्थान पर नेविगेट करें';

  @override
  String get navigateToDestination => 'गंतव्य स्थान पर नेविगेट करें';

  @override
  String get navigationLaunchError => 'बाहरी नेविगेशन मैप खोलने में असमर्थ।';

  @override
  String get activeJobStatusInProgress => 'प्रगति पर';

  @override
  String get activeJobStatusCompleted => 'पूर्ण हुआ';

  @override
  String get activeJobStatusCancelled => 'रद्द किया गया';

  @override
  String jobCancelledNotice(String refund, String forfeited) {
    return 'कार्य रद्द किया गया। रिफंड: ₹$refund, काटी गई राशि: ₹$forfeited';
  }

  @override
  String get retryCancel => 'रद्द करने का पुनः प्रयास करें';

  @override
  String get retryTopup => 'पुनः टॉप-अप करें';
}
