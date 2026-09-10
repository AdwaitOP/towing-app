import 'package:flutter/material.dart';
import 'app/driver_app.dart';
import 'core/config/firebase_options.dart';
import 'core/services/auth_service.dart';
import 'core/services/profile_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize Firebase targeting existing project / emulator boundary
  try {
    await FirebaseBootstrap.initialize();
  } catch (e) {
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: e,
        library: 'FirebaseBootstrap',
        context: ErrorDescription('while initializing Firebase'),
      ),
    );
  }

  final authService = AuthService();
  final profileService = ProfileService();

  runApp(
    DriverApp(
      authService: authService,
      profileService: profileService,
    ),
  );
}
