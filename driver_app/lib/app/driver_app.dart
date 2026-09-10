import 'package:flutter/material.dart';
import '../core/services/auth_service.dart';
import '../core/services/profile_service.dart';
import '../l10n/app_localizations.dart';
import '../theme/app_theme.dart';
import 'session_resolver.dart';

/// Root application widget for the Towing Driver App.
class DriverApp extends StatefulWidget {
  final AuthService authService;
  final ProfileService profileService;

  const DriverApp({
    super.key,
    required this.authService,
    required this.profileService,
  });

  @override
  State<DriverApp> createState() => _DriverAppState();
}

class _DriverAppState extends State<DriverApp> {
  Locale _locale = const Locale('en');

  void _setLocale(Locale locale) {
    setState(() {
      _locale = locale;
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Towing Driver',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.darkTheme,
      locale: _locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      home: SessionResolver(
        authService: widget.authService,
        profileService: widget.profileService,
        onLocaleChanged: _setLocale,
      ),
    );
  }
}
