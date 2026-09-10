import 'package:flutter/material.dart';

/// High-contrast safety theme color palette for Towing Driver App.
/// Designed for high visibility, outdoor legibility, and safety-oriented operations.
abstract class AppColors {
  // Safety Yellow / Amber Primaries
  static const Color primary = Color(0xFFFFB300); // Amber 600
  static const Color primaryLight = Color(0xFFFFD54F); // Amber 300
  static const Color primaryDark = Color(0xFFFF8F00); // Amber 800
  static const Color primaryContainer = Color(0xFF332700);

  // Background & Surfaces (High Contrast Dark)
  static const Color background = Color(0xFF121212);
  static const Color surface = Color(0xFF1E1E1E);
  static const Color surfaceVariant = Color(0xFF2C2C2C);
  static const Color border = Color(0xFF3D3D3D);
  static const Color borderFocused = Color(0xFFFFB300);

  // Text & Content (High Contrast)
  static const Color onPrimary = Color(0xFF000000); // Black on yellow
  static const Color onBackground = Color(0xFFFFFFFF);
  static const Color onSurface = Color(0xFFEEEEEE);
  static const Color textSecondary = Color(0xFFB0B0B0);
  static const Color textDisabled = Color(0xFF6E6E6E);

  // Functional / Status
  static const Color error = Color(0xFFCF6679);
  static const Color onError = Color(0xFF000000);
  static const Color success = Color(0xFF4CAF50);
  static const Color warning = Color(0xFFFF9800);

  // Touch Target & Metric Standards
  static const double minTouchTargetSize = 48.0;
  static const double primaryButtonHeight = 56.0;
  static const double inputFieldHeight = 56.0;
  static const double borderRadius = 12.0;
}
