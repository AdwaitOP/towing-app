import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

/// Informational guidance card for Android battery optimization.
/// Directs the driver to system settings without automatically requesting exemptions.
class BatteryOptimizationCard extends StatelessWidget {
  final Future<void> Function()? onOpenSettings;

  const BatteryOptimizationCard({
    super.key,
    this.onOpenSettings,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Container(
      key: const ValueKey('battery_optimization_card'),
      padding: const EdgeInsets.all(16.0),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppColors.borderRadius),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.battery_saver,
                color: AppColors.primary,
                size: 24.0,
              ),
              const SizedBox(width: 10.0),
              Expanded(
                child: Text(
                  l10n.batteryOptimizationTitle,
                  style: AppTypography.titleLarge.copyWith(
                    color: AppColors.onBackground,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8.0),
          Text(
            l10n.batteryOptimizationSubtitle,
            style: AppTypography.bodyMedium.copyWith(
              color: AppColors.textSecondary,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 12.0),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              key: const ValueKey('battery_settings_button'),
              onPressed: () async {
                if (onOpenSettings != null) {
                  await onOpenSettings!();
                } else {
                  await FlutterForegroundTask.openIgnoreBatteryOptimizationSettings();
                }
              },
              icon: const Icon(Icons.settings, size: 18.0),
              label: Text(l10n.batteryOptimizationAction),
              style: TextButton.styleFrom(
                foregroundColor: AppColors.primary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
