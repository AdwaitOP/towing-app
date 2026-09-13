class AppConfig {
  /// Whether to connect to local Firebase emulators (Auth, Firestore, Functions).
  /// Must be explicitly enabled via `--dart-define=USE_FIREBASE_EMULATOR=true`.
  static const bool useFirebaseEmulator = bool.fromEnvironment(
    'USE_FIREBASE_EMULATOR',
    defaultValue: false,
  );

  /// Emulator host address (10.0.2.2 for Android emulator, localhost for desktop/tests).
  static const String emulatorHost = String.fromEnvironment(
    'EMULATOR_HOST',
    defaultValue: '10.0.2.2',
  );

  static const int authEmulatorPort = 9099;
  static const int firestoreEmulatorPort = 8080;
  static const int functionsEmulatorPort = 5001;
  static const int storageEmulatorPort = 9199;

  /// Project ID used in emulator mode.
  static const String emulatorProjectId = String.fromEnvironment(
    'FIREBASE_PROJECT_ID',
    defaultValue: 'towing-app',
  );

  /// Storage bucket used in emulator mode.
  static String get emulatorStorageBucket => '$emulatorProjectId.appspot.com';

  /// Resolves the base URL for backend Cloud Functions with strict environment precedence.
  ///
  /// Precedence contract:
  /// 1. If [useEmulator] is true, returns the local emulator URL regardless of any [productionUrl].
  /// 2. If [useEmulator] is false (production mode), [productionUrl] MUST be non-empty and non-whitespace;
  ///    otherwise, throws [StateError] (fails closed).
  static String resolveFunctionsBaseUrl({
    bool useEmulator = useFirebaseEmulator,
    String productionUrl = const String.fromEnvironment('FUNCTIONS_BASE_URL'),
    String host = emulatorHost,
    int port = functionsEmulatorPort,
    String projectId = emulatorProjectId,
  }) {
    if (useEmulator) {
      return 'http://$host:$port/$projectId/asia-south1';
    }

    final trimmed = productionUrl.trim();
    if (trimmed.isEmpty) {
      throw StateError(
        'Missing FUNCTIONS_BASE_URL. In production mode, FUNCTIONS_BASE_URL must be provided via --dart-define=FUNCTIONS_BASE_URL=https://...',
      );
    }
    return productionUrl;
  }

  /// Base URL for backend Cloud Functions.
  /// In emulator mode, ALWAYS resolves to the local Functions emulator suite.
  /// In production mode, this MUST be supplied via `--dart-define=FUNCTIONS_BASE_URL=https://...`.
  static String get functionsBaseUrl => resolveFunctionsBaseUrl();


  /// OTP Resend cooldown duration in seconds.
  static const int defaultResendCooldownSeconds = 60;

  /// Timeout for HTTP requests to Cloud Functions.
  static const Duration requestTimeout = Duration(seconds: 15);
}
