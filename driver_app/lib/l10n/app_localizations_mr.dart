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

  @override
  String get dispatchHub => 'डिस्पॅच हब';

  @override
  String get onDuty => 'ऑन ड्युटी';

  @override
  String get offDuty => 'ऑफ ड्युटी';

  @override
  String get goOnDuty => 'ऑन ड्युटी व्हा';

  @override
  String get goOffDuty => 'ऑफ ड्युटी व्हा';

  @override
  String get hubStatusOnDuty =>
      'तुम्ही ऑन ड्युटी आहात आणि टोइंग विनंत्यांसाठी उपलब्ध आहात.';

  @override
  String get hubStatusOffDuty =>
      'तुम्ही ऑफ ड्युटी आहात. डिस्पॅच मिळवण्यासाठी ऑन ड्युटी व्हा.';

  @override
  String get locationDisclosureTitle => 'लोकेशन प्रवेश आणि डिस्पॅच';

  @override
  String get locationDisclosureBody =>
      'टोइंग ड्रायव्हर जवळचे टोइंग काम शोधण्यासाठी, मार्गाची गणना करण्यासाठी आणि ऑन ड्युटी असताना तुमचे स्थान अपडेट करण्यासाठी लोकेशन डेटा गोळा करतो. तुम्ही ऑन ड्युटी असताना ॲप बॅकग्राउंडमध्ये किंवा बंद असतानाही हे ट्रॅकिंग सुरू राहू शकते.';

  @override
  String get continueAction => 'पुढे चालू ठेवा';

  @override
  String get notNowAction => 'आत्ता नाही';

  @override
  String get cancelAction => 'रद्द करा';

  @override
  String get locationPermissionRequired =>
      'ऑन ड्युटी होण्यासाठी लोकेशन परवानगी आवश्यक आहे.';

  @override
  String get locationPermissionPermanentlyDenied =>
      'लोकेशन परवानगी कायमची नाकारली आहे. कृपया ऑन ड्युटी होण्यासाठी सेटिंग्जमध्ये ती सक्षम करा.';

  @override
  String get locationServicesDisabled =>
      'लोकेशन सेवा बंद आहेत. कृपया सेटिंग्जमध्ये जीपीएस/लोकेशन सुरू करा.';

  @override
  String get backgroundLocationRequired =>
      'नेव्हिगेशन दरम्यान डिस्पॅच मिळवण्यासाठी बॅकग्राउंड लोकेशन परवानगी आवश्यक आहे.';

  @override
  String get notificationPermissionRequired =>
      'फोरग्राउंड डिस्पॅच सेवा चालवण्यासाठी सूचना परवानगी आवश्यक आहे.';

  @override
  String get openSettings => 'सेटिंग्ज उघडा';

  @override
  String get trackingActive => 'लोकेशन ट्रॅकिंग सक्रिय आहे';

  @override
  String get trackingUnavailable => 'लोकेशन ट्रॅकिंग अनुपलब्ध आहे';

  @override
  String temporaryBanBanner(String time) {
    return 'रद्दीकरणामुळे आपण $time पर्यंत तात्पुरते थांबवले आहात.';
  }

  @override
  String get cannotGoOffDutyActiveJob =>
      'सक्रिय कामादरम्यान ऑफ ड्युटी जाता येत नाही.';

  @override
  String get reconciliationFailed =>
      'ड्युटी स्थितीची पडताळणी करण्यात अयशस्वी. कृपया कनेक्शन तपासा किंवा ॲप पुन्हा सुरू करा.';

  @override
  String get batteryOptimizationTitle => 'बॅटरी ऑप्टिमायझेशन';

  @override
  String get batteryOptimizationSubtitle =>
      'विश्वासार्ह बॅकग्राउंड ट्रॅकिंगसाठी, बॅटरी ऑप्टिमायझेशन अनरेस्ट्रिक्टेडवर सेट करा.';

  @override
  String get batteryOptimizationAction => 'बॅटरी सेटिंग्ज';

  @override
  String get foregroundNotificationTitle => 'टोइंग ड्रायव्हर';

  @override
  String get foregroundNotificationText =>
      'डिस्पॅचसाठी थेट लोकेशन शेअर करत आहे';

  @override
  String get mapUnavailable => 'नकाशा पूर्वावलोकन सध्या अनुपलब्ध आहे.';

  @override
  String get mapTokenMissing => 'मॅपबॉक्स ॲक्सेस टोकन कॉन्फिगर केलेले नाही.';

  @override
  String get dutyTransitionInProgress => 'ड्युटी स्थिती अपडेट करत आहे...';

  @override
  String get dutyServiceStartupFailed =>
      'लोकेशन सेवा सुरू करण्यात अयशस्वी. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get dutyAttentionRequired =>
      'ड्युटी स्थितीकडे लक्ष देणे आवश्यक आहे — थेट स्थान अनुपलब्ध आहे';

  @override
  String get logoutBlockedActiveJob =>
      'सक्रिय काम सुरू असताना तुम्ही लॉग आउट करू शकत नाही.';

  @override
  String get logoutBlockedActiveOffer =>
      'काम ऑफर प्रलंबित असताना तुम्ही लॉग आउट करू शकत नाही.';

  @override
  String get logoutFailedDutyTransition =>
      'ड्युटी सत्र सुरक्षितपणे समाप्त करण्यात अयशस्वी. कृपया पुन्हा प्रयत्न करा.';

  @override
  String get incomingOfferTitle => 'नवीन काम ऑफर';

  @override
  String get offerExpired => 'कालबाह्य';

  @override
  String offerExpiringIn(int seconds) {
    return '$seconds सेकंद शिल्लक';
  }

  @override
  String insufficientWalletForOffer(String commission) {
    return 'वॉलेटमध्ये अपुरी शिल्लक. हे काम स्वीकारण्यासाठी ₹$commission जमा करा.';
  }

  @override
  String get pickupLocation => 'पिकअप स्थान';

  @override
  String get destinationLocation => 'गंतव्य स्थान';

  @override
  String get pickupDistance => 'अंतर';

  @override
  String get pickupEta => 'अंदाजे वेळ';

  @override
  String get truckTypeLabel => 'ट्रकचा प्रकार';

  @override
  String get estimatedEarnings => 'अंदाजे भाडे';

  @override
  String get commissionFee => 'प्लॅटफॉर्म शुल्क';

  @override
  String get declineOffer => 'नकार द्या';

  @override
  String get acceptOffer => 'स्वीकारा';

  @override
  String get retryAcceptOffer => 'पुन्हा प्रयत्न करा';

  @override
  String get activeJobTitle => 'सक्रिय काम';

  @override
  String get activeJobStatusAssigned => 'नियुक्त';

  @override
  String get jobIdLabel => 'काम आयडी';

  @override
  String get routeDetailsTitle => 'मार्ग तपशील';

  @override
  String get paymentSummaryTitle => 'भाडे आणि कमिशन';

  @override
  String get cancellationPolicyTitle => 'रद्दीकरण धोरण';

  @override
  String cancellationPolicyDescription(String freeCount) {
    return 'या महिन्यात आपल्याकडे $freeCount मोफत रद्दीकरणे आहेत. उशिरा रद्द केल्यास दंड आकारला जाऊ शकतो.';
  }

  @override
  String get activeJobBatchNotice =>
      'बॅच 1 सादरीकरण शेल: काम ट्रॅकिंग सक्रिय आहे. कृती बटणे बॅच 2 मध्ये सुरू होतील.';

  @override
  String get walletBalance => 'वॉलेट शिल्लक';

  @override
  String get walletTopup => 'टॉप अप';

  @override
  String get walletTopupTitle => 'वॉलेट टॉप-अप';

  @override
  String get enterTopupAmount => 'रक्कम टाका';

  @override
  String get topupQuickAmount => 'जलद निवड';

  @override
  String get topupSubmit => 'वॉलेट टॉप अप करा';

  @override
  String topupSuccess(String amount) {
    return 'वॉलेट टॉप-अप सुरू झाले (₹$amount). पुष्टी झाल्यावर बॅलन्स अपडेट होईल.';
  }

  @override
  String topupFailed(String error) {
    return 'वॉलेट टॉप-अप अयशस्वी: $error';
  }

  @override
  String get topupMinMaxError => 'रक्कम ₹1 ते ₹1,00,000 दरम्यान असावी';

  @override
  String lowBalanceWarning(String balance) {
    return 'कमी वॉलेट शिल्लक: $balance. उच्च-कमिशन कामे स्वीकारण्यासाठी टॉप अप करा.';
  }

  @override
  String get strictModeActive => 'स्ट्रिक्ट मोड सक्रिय';

  @override
  String get strictModeWarning =>
      'स्ट्रिक्ट मोड सक्रिय: पुढील रद्द केल्यास 100% दंड आणि खाते निलंबन होईल.';

  @override
  String monthlyCancellations(String count) {
    return 'या महिन्यात रद्द: $count';
  }

  @override
  String get startTow => 'टो सुरू करा';

  @override
  String get markComplete => 'पूर्ण चिन्हांकित करा';

  @override
  String get cancelJob => 'काम रद्द करा';

  @override
  String get jobCompletedSuccess => 'काम यशस्वीरित्या पूर्ण झाले';

  @override
  String get returnToHub => 'हबवर परत जा';

  @override
  String get customerCancelledNotice =>
      'ग्राहकाचे रद्द करणे प्रक्रियेत आहे. कोणताही दंड लागू नाही. पुष्टी झाल्यावर तुमचे वॉलेट बॅलन्स अपडेट होईल.';

  @override
  String get cancellationPreviewTitle => 'रद्द करण्याचे पूर्वावलोकन';

  @override
  String get cancellationPreviewNotice =>
      'अंदाजे पूर्वावलोकन. बॅकएंड सर्व्हर हे एकमेव आर्थिक अधिकार आहे.';

  @override
  String freeCancellationsRemaining(String count) {
    return 'उर्वरित विनामूल्य रद्द: $count';
  }

  @override
  String estimatedDeduction(String amount) {
    return 'अंदाजे जप्ती: ₹$amount';
  }

  @override
  String estimatedRefund(String amount) {
    return 'अंदाजे परतावा: ₹$amount';
  }

  @override
  String get banWarning =>
      'चेतावणी: रद्द केल्याने तुमचे खाते तात्पुरते ड्युटीवरून निलंबित केले जाईल.';

  @override
  String get confirmCancellation => 'रद्द करण्याची पुष्टी करा';

  @override
  String get keepJob => 'काम चालू ठेवा';

  @override
  String get actionInProgress => 'कृपया प्रतीक्षा करा...';

  @override
  String get cancelUnavailableInProgress =>
      'टो सुरू झाल्यावर रद्द करण्याची परवानगी नाही.';

  @override
  String get testModeNotice =>
      'चाचणी मोड: वास्तविक पैशांशिवाय त्वरित पेमेंटचे अनुकरण करते.';

  @override
  String get navigateToPickup => 'पिकअप स्थानावर नेव्हिगेट करा';

  @override
  String get navigateToDestination => 'गंतव्य स्थानावर नेव्हिगेट करा';

  @override
  String get navigationLaunchError => 'बाह्य नेव्हिगेशन नकाशा उघडण्यात अक्षम.';

  @override
  String get activeJobStatusInProgress => 'प्रगतीपथावर';

  @override
  String get activeJobStatusCompleted => 'पूर्ण झाले';

  @override
  String get activeJobStatusCancelled => 'रद्द केले';

  @override
  String jobCancelledNotice(String refund, String forfeited) {
    return 'काम रद्द केले. परतावा: ₹$refund, जप्त रक्कम: ₹$forfeited';
  }

  @override
  String get retryCancel => 'रद्द करण्याचा पुन्हा प्रयत्न करा';

  @override
  String get retryTopup => 'पुन्हा टॉप-अप करा';
}
