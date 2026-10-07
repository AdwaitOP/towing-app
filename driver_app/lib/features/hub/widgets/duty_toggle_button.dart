import 'package:flutter/material.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

/// High-contrast giant ON DUTY / OFF DUTY interactive toggle control.
/// Designed for quick, accessible operation by drivers in towing vehicles.
class DutyToggleButton extends StatelessWidget {
  final bool isOnDuty;
  final bool isLoading;
  final bool isEnabled;
  final VoidCallback onPressed;

  const DutyToggleButton({
    super.key,
    required this.isOnDuty,
    required this.isLoading,
    this.isEnabled = true,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    final backgroundColor = isOnDuty ? AppColors.error : AppColors.primary;
    final foregroundColor = isOnDuty ? Colors.white : AppColors.background;
    final label = isOnDuty ? l10n.goOffDuty : l10n.goOnDuty;
    final bool effectiveEnabled = isEnabled && !isLoading;

    return SizedBox(
      width: double.infinity,
      height: 64.0,
      child: Semantics(
        button: true,
        label: label,
        enabled: effectiveEnabled,
        child: ElevatedButton(
          key: const ValueKey('duty_toggle_button'),
          onPressed: effectiveEnabled ? onPressed : null,
          style: ElevatedButton.styleFrom(
            backgroundColor: backgroundColor,
            foregroundColor: foregroundColor,
            elevation: 4.0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppColors.borderRadius),
            ),
            disabledBackgroundColor: backgroundColor.withValues(alpha: 0.6),
            disabledForegroundColor: foregroundColor.withValues(alpha: 0.6),
          ),
        child: isLoading
            ? Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  SizedBox(
                    width: 24.0,
                    height: 24.0,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      valueColor: AlwaysStoppedAnimation<Color>(foregroundColor),
                    ),
                  ),
                  const SizedBox(width: 16.0),
                  Flexible(
                    child: Text(
                      l10n.dutyTransitionInProgress,
                      style: AppTypography.titleLarge.copyWith(
                        color: foregroundColor,
                        fontWeight: FontWeight.bold,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              )
            : Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    isOnDuty ? Icons.power_settings_new : Icons.navigation,
                    size: 28.0,
                    color: foregroundColor,
                  ),
                  const SizedBox(width: 12.0),
                  Flexible(
                    child: Text(
                      label,
                      style: AppTypography.titleLarge.copyWith(
                        color: foregroundColor,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.2,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
        ),
      ),
    );
  }
}
