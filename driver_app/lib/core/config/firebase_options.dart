import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'app_config.dart';

/// Clean configuration boundary for Firebase project initialization.
///
/// Targets the existing towing system Firebase project.
/// When running against local Firebase emulators (`--dart-define=USE_FIREBASE_EMULATOR=true`),
/// points Firebase Auth and Cloud Firestore to the respective emulator ports configured in `firebase.json`.
class FirebaseBootstrap {
  /// Validates and constructs production [FirebaseOptions] from authoritative configuration.
  /// Fails closed (throws [StateError]) if any required value is missing, blank, or a fabricated sentinel.
  static FirebaseOptions buildProductionOptions({
    String apiKey = const String.fromEnvironment('FIREBASE_API_KEY'),
    String appId = const String.fromEnvironment('FIREBASE_APP_ID'),
    String projectId = const String.fromEnvironment('FIREBASE_PROJECT_ID'),
    String messagingSenderId = const String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID'),
    String storageBucket = const String.fromEnvironment('FIREBASE_STORAGE_BUCKET'),
  }) {
    final missing = <String>[];
    if (apiKey.trim().isEmpty) missing.add('FIREBASE_API_KEY');
    if (appId.trim().isEmpty) missing.add('FIREBASE_APP_ID');
    if (projectId.trim().isEmpty) missing.add('FIREBASE_PROJECT_ID');
    if (messagingSenderId.trim().isEmpty) missing.add('FIREBASE_MESSAGING_SENDER_ID');

    if (missing.isNotEmpty) {
      throw StateError(
        'Missing required production Firebase configuration: ${missing.join(', ')}. '
        'Supply them via --dart-define or enable emulator mode via --dart-define=USE_FIREBASE_EMULATOR=true.',
      );
    }

    final trimmedSenderId = messagingSenderId.trim();
    if (trimmedSenderId == '0') {
      throw StateError(
        'Invalid FIREBASE_MESSAGING_SENDER_ID: "0" is a fabricated sentinel and cannot be used in production.',
      );
    }

    return FirebaseOptions(
      apiKey: apiKey,
      appId: appId,
      projectId: projectId,
      messagingSenderId: messagingSenderId,
      storageBucket: storageBucket.trim().isNotEmpty ? storageBucket : null,
    );
  }

  static Future<void> initialize() async {
    if (Firebase.apps.isEmpty) {
      if (AppConfig.useFirebaseEmulator) {
        // In EMULATOR mode: use emulator-specific dummy options to bootstrap client SDKs
        await Firebase.initializeApp(
          options: const FirebaseOptions(
            apiKey: 'emulator-dummy-api-key',
            appId: '1:000000000000:android:0000000000000000000000',
            messagingSenderId: '000000000000',
            projectId: AppConfig.emulatorProjectId,
          ),
        );
      } else {
        // In PRODUCTION mode: must come strictly from authoritative environment variables.
        // FAIL CLOSED if any required variable is missing or invalid.
        final options = buildProductionOptions();

        await Firebase.initializeApp(
          options: options,
        );
      }
    }

    if (AppConfig.useFirebaseEmulator) {
      await connectToEmulators();
    }
  }

  /// Connects client SDKs to local Firebase emulator suite.
  static Future<void> connectToEmulators() async {
    final host = AppConfig.emulatorHost;
    await FirebaseAuth.instance.useAuthEmulator(host, AppConfig.authEmulatorPort);
    FirebaseFirestore.instance.useFirestoreEmulator(host, AppConfig.firestoreEmulatorPort);
  }
}
