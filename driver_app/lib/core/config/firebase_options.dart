import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_storage/firebase_storage.dart';
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
    if (storageBucket.trim().isEmpty) missing.add('FIREBASE_STORAGE_BUCKET');

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
      storageBucket: storageBucket.trim(),
    );
  }

  static Future<void> initialize() async {
    if (Firebase.apps.isEmpty) {
      if (AppConfig.useFirebaseEmulator) {
        // In EMULATOR mode: use emulator-specific dummy options to bootstrap client SDKs
        await Firebase.initializeApp(
          options: FirebaseOptions(
            apiKey: 'emulator-dummy-api-key',
            appId: '1:000000000000:android:0000000000000000000000',
            messagingSenderId: '000000000000',
            projectId: AppConfig.emulatorProjectId,
            storageBucket: AppConfig.emulatorStorageBucket,
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

  // Injectable connector hooks for deterministic unit testing of emulator setup.
  static Future<void> Function(String host, int port)? authEmulatorConnector;
  static void Function(String host, int port)? firestoreEmulatorConnector;
  static Future<void> Function(String host, int port)? storageEmulatorConnector;
  static void Function(String host, int port)? functionsEmulatorConnector;

  /// Connects client SDKs to local Firebase emulator suite.
  static Future<void> connectToEmulators() async {
    final host = AppConfig.emulatorHost;
    if (authEmulatorConnector != null) {
      await authEmulatorConnector!(host, AppConfig.authEmulatorPort);
    } else {
      await FirebaseAuth.instance.useAuthEmulator(host, AppConfig.authEmulatorPort);
    }

    if (firestoreEmulatorConnector != null) {
      firestoreEmulatorConnector!(host, AppConfig.firestoreEmulatorPort);
    } else {
      FirebaseFirestore.instance.useFirestoreEmulator(host, AppConfig.firestoreEmulatorPort);
    }

    if (storageEmulatorConnector != null) {
      await storageEmulatorConnector!(host, AppConfig.storageEmulatorPort);
    } else {
      await FirebaseStorage.instance.useStorageEmulator(host, AppConfig.storageEmulatorPort);
    }

    if (functionsEmulatorConnector != null) {
      functionsEmulatorConnector!(host, AppConfig.functionsEmulatorPort);
    } else {
      FirebaseFunctions.instanceFor(region: 'asia-south1').useFunctionsEmulator(host, AppConfig.functionsEmulatorPort);
    }
  }
}
