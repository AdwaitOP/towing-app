import 'package:flutter/material.dart';
import 'app_colors.dart';
import 'app_typography.dart';

/// Central ThemeData builder for the Towing Driver App.
abstract class AppTheme {
  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: AppColors.background,
      colorScheme: const ColorScheme.dark(
        primary: AppColors.primary,
        onPrimary: AppColors.onPrimary,
        primaryContainer: AppColors.primaryContainer,
        surface: AppColors.surface,
        onSurface: AppColors.onSurface,
        error: AppColors.error,
        onError: AppColors.onError,
      ),
      textTheme: const TextTheme(
        displayLarge: AppTypography.displayLarge,
        headlineMedium: AppTypography.headlineMedium,
        titleLarge: AppTypography.titleLarge,
        bodyLarge: AppTypography.bodyLarge,
        bodyMedium: AppTypography.bodyMedium,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: AppColors.onPrimary,
          disabledBackgroundColor: AppColors.surfaceVariant,
          disabledForegroundColor: AppColors.textDisabled,
          elevation: 2.0,
          minimumSize: const Size(double.infinity, AppColors.primaryButtonHeight),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppColors.borderRadius),
          ),
          textStyle: AppTypography.button,
          padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 14.0),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.primary,
          disabledForegroundColor: AppColors.textDisabled,
          side: const BorderSide(color: AppColors.primary, width: 2.0),
          minimumSize: const Size(double.infinity, AppColors.primaryButtonHeight),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppColors.borderRadius),
          ),
          textStyle: AppTypography.button,
          padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 14.0),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 20.0, vertical: 18.0),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppColors.borderRadius),
          borderSide: const BorderSide(color: AppColors.border, width: 1.5),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppColors.borderRadius),
          borderSide: const BorderSide(color: AppColors.border, width: 1.5),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppColors.borderRadius),
          borderSide: const BorderSide(color: AppColors.borderFocused, width: 2.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppColors.borderRadius),
          borderSide: const BorderSide(color: AppColors.error, width: 1.5),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppColors.borderRadius),
          borderSide: const BorderSide(color: AppColors.error, width: 2.5),
        ),
        labelStyle: const TextStyle(color: AppColors.textSecondary, fontSize: 16.0),
        hintStyle: const TextStyle(color: AppColors.textDisabled, fontSize: 16.0),
        errorStyle: const TextStyle(color: AppColors.error, fontSize: 13.0, fontWeight: FontWeight.w500),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.surface,
        foregroundColor: AppColors.onBackground,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: AppTypography.titleLarge,
      ),
      cardTheme: CardThemeData(
        color: AppColors.surface,
        elevation: 2.0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppColors.borderRadius),
          side: const BorderSide(color: AppColors.border, width: 1.0),
        ),
        margin: const EdgeInsets.symmetric(vertical: 8.0),
      ),
    );
  }
}
