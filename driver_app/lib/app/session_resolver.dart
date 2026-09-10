import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../core/services/auth_service.dart';
import '../core/services/profile_service.dart';
import '../features/auth/controllers/auth_controller.dart';
import '../features/auth/screens/phone_login_screen.dart';
import '../features/home/screens/stage1_home_screen.dart';
import '../features/profile/controllers/profile_controller.dart';
import '../features/profile/screens/profile_setup_screen.dart';
import '../theme/app_colors.dart';

import '../l10n/app_localizations.dart';

/// Root state-driven widget that resolves between:
/// 1. Unauthenticated -> PhoneLoginScreen
/// 2. Authenticated but profile missing or incomplete -> ProfileSetupScreen
/// 3. Authenticated with completed profile -> Stage1HomeScreen
/// 4. Authenticated with stream error -> Profile error screen with retry
/// 5. Authenticated with malformed profile -> Fail-closed error screen (no setup overwrite)
class SessionResolver extends StatefulWidget {
  final AuthService authService;
  final ProfileService profileService;
  final Function(Locale)? onLocaleChanged;

  const SessionResolver({
    super.key,
    required this.authService,
    required this.profileService,
    this.onLocaleChanged,
  });

  @override
  State<SessionResolver> createState() => _SessionResolverState();
}

class _SessionResolverState extends State<SessionResolver> {
  late final AuthController _authController;
  late final ProfileController _profileController;
  Stream<ProfileState>? _profileStream;
  String? _subscribedUid;
  int _retryKey = 0;

  @override
  void initState() {
    super.initState();
    _authController = AuthController(authService: widget.authService);
    _profileController = ProfileController(profileService: widget.profileService);
  }

  @override
  void didUpdateWidget(SessionResolver oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.profileService != oldWidget.profileService) {
      _profileStream = null;
      _subscribedUid = null;
    }
  }

  @override
  void dispose() {
    _authController.dispose();
    _profileController.dispose();
    super.dispose();
  }

  Stream<ProfileState> _getProfileStream(String uid) {
    if (_profileStream == null || _subscribedUid != uid) {
      _subscribedUid = uid;
      _profileStream = widget.profileService.streamProfileState(uid);
    }
    return _profileStream!;
  }

  void _retryProfileStream(String uid) {
    setState(() {
      _retryKey++;
      _subscribedUid = uid;
      _profileStream = widget.profileService.streamProfileState(uid);
    });
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<User?>(
      stream: widget.authService.authStateChanges,
      builder: (context, authSnapshot) {
        // Checking initial auth state
        if (authSnapshot.connectionState == ConnectionState.waiting) {
          return const _SplashScreen();
        }

        final user = authSnapshot.data;

        // 1. Unauthenticated
        if (user == null) {
          _subscribedUid = null;
          _profileStream = null;
          return PhoneLoginScreen(
            controller: _authController,
            onLocaleChanged: widget.onLocaleChanged,
          );
        }

        // 2. Authenticated -> Stream profile state from drivers/{uid}
        return StreamBuilder<ProfileState>(
          key: ValueKey('profile_stream_${user.uid}_$_retryKey'),
          stream: _getProfileStream(user.uid),
          builder: (context, profileSnapshot) {
            if (profileSnapshot.connectionState == ConnectionState.waiting) {
              return const _SplashScreen();
            }

            final l10n = AppLocalizations.of(context)!;

            if (profileSnapshot.hasError) {
              return _ProfileErrorScreen(
                message: l10n.profileLoadError,
                onRetry: () => _retryProfileStream(user.uid),
                onLogout: () => widget.authService.signOut(),
              );
            }

            final state = profileSnapshot.data;
            if (state == null) {
              return const _SplashScreen();
            }

            switch (state) {
              case ProfileCompleted(:final profile):
                return Stage1HomeScreen(
                  profile: profile,
                  authService: widget.authService,
                  onLocaleChanged: widget.onLocaleChanged,
                );

              case ProfileNotFound():
                final phone = user.phoneNumber ?? _authController.phone;
                return ProfileSetupScreen(
                  uid: user.uid,
                  phone: phone,
                  controller: _profileController,
                  authService: widget.authService,
                );

              case ProfileIncomplete(:final profile):
                final phone = profile.phone.isNotEmpty
                    ? profile.phone
                    : (user.phoneNumber ?? _authController.phone);
                return ProfileSetupScreen(
                  uid: user.uid,
                  phone: phone,
                  controller: _profileController,
                  authService: widget.authService,
                );

              case ProfileMalformed():
                return _ProfileErrorScreen(
                  message: l10n.profileMalformedError,
                  onRetry: null, // Fail-closed: cannot overwrite corrupt backend record
                  onLogout: () => widget.authService.signOut(),
                );

              case ProfileError():
                return _ProfileErrorScreen(
                  message: l10n.profileLoadError,
                  onRetry: () => _retryProfileStream(user.uid),
                  onLogout: () => widget.authService.signOut(),
                );
            }
          },
        );
      },
    );
  }
}

class _ProfileErrorScreen extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  final VoidCallback onLogout;

  const _ProfileErrorScreen({
    required this.message,
    this.onRetry,
    required this.onLogout,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Text(l10n.appName),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: AppColors.error),
            tooltip: l10n.logout,
            onPressed: onLogout,
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24.0),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(
                  Icons.error_outline,
                  color: AppColors.error,
                  size: 64.0,
                ),
                const SizedBox(height: 16.0),
                Text(
                  message,
                  style: const TextStyle(
                    color: AppColors.onBackground,
                    fontSize: 16.0,
                    fontWeight: FontWeight.w600,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 24.0),
                if (onRetry != null)
                  ElevatedButton(
                    onPressed: onRetry,
                    child: Text(l10n.retry),
                  ),
                const SizedBox(height: 12.0),
                OutlinedButton(
                  onPressed: onLogout,
                  child: Text(l10n.logout),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: AppColors.background,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.local_shipping,
              color: AppColors.primary,
              size: 64.0,
            ),
            SizedBox(height: 24.0),
            CircularProgressIndicator(
              valueColor: AlwaysStoppedAnimation<Color>(AppColors.primary),
            ),
          ],
        ),
      ),
    );
  }
}
