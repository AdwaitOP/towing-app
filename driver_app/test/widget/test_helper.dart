import 'package:driver_app/l10n/app_localizations.dart';
import 'package:driver_app/theme/app_theme.dart';
import 'package:flutter/material.dart';

/// Wraps a widget with MaterialApp and localization delegates for testing.
Widget createTestWidget({
  required Widget child,
  Locale locale = const Locale('en'),
}) {
  return MaterialApp(
    theme: AppTheme.darkTheme,
    locale: locale,
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    home: child,
  );
}
