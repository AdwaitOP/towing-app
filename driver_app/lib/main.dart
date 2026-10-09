import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'app/driver_app.dart';
import 'core/config/firebase_options.dart';
import 'core/services/auth_service.dart';
import 'core/services/profile_service.dart';

void main() async {
  // 1. Guarantee WidgetsFlutterBinding is initialized.
  WidgetsFlutterBinding.ensureInitialized();

  // 2. Initialize Firebase targeting existing project / emulator boundary.
  Object? bootstrapError;
  try {
    await FirebaseBootstrap.initialize();
  } catch (e, stack) {
    bootstrapError = e;
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: e,
        stack: stack,
        library: 'FirebaseBootstrap',
        context: ErrorDescription('while initializing Firebase'),
      ),
    );
  }

  // 5. Surfacing initialization failure meaningfully rather than allowing [core/no-app] access.
  if (bootstrapError != null || Firebase.apps.isEmpty) {
    runApp(
      FirebaseInitializationErrorApp(
        error: bootstrapError ?? StateError('No Firebase App was created during bootstrap.'),
      ),
    );
    return;
  }

  // 3 & 4. ONLY AFTER Firebase exists may Firebase-dependent services/controllers initialize.
  final authService = AuthService();
  final profileService = ProfileService();

  runApp(
    DriverApp(
      authService: authService,
      profileService: profileService,
    ),
  );
}

/// Standalone fail-closed presentation widget rendered when Firebase bootstrap fails.
/// Strictly isolates the UI from [core/no-app] crashes by avoiding any eager Firebase SDK calls.
class FirebaseInitializationErrorApp extends StatelessWidget {
  final Object error;

  const FirebaseInitializationErrorApp({
    super.key,
    required this.error,
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'TowMitra Driver - Initialization Error',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF121212),
      ),
      home: Scaffold(
        backgroundColor: const Color(0xFF121212),
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24.0),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.cloud_off,
                    color: Color(0xFFE53935),
                    size: 64.0,
                  ),
                  const SizedBox(height: 24.0),
                  const Text(
                    'Firebase Initialization Error',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 20.0,
                      fontWeight: FontWeight.bold,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 12.0),
                  Text(
                    error.toString(),
                    style: const TextStyle(
                      color: Color(0xFFB0B0B0),
                      fontSize: 14.0,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24.0),
                  ElevatedButton(
                    onPressed: () {
                      main();
                    },
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF1976D2),
                      foregroundColor: Colors.white,
                    ),
                    child: const Text('Retry Startup'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
