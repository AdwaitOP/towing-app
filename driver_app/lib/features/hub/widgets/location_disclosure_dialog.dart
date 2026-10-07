import 'package:flutter/material.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

/// Pre-permission background location disclosure dialog.
/// Displayed BEFORE triggering any operating system permission prompts.
class LocationDisclosureDialog extends StatelessWidget {
  const LocationDisclosureDialog({super.key});

  /// Static helper to display the disclosure dialog modal.
  /// Returns `true` if the user explicitly taps Continue, `false` otherwise.
  static Future<bool> show(BuildContext context) async {
    final result = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => const LocationDisclosureDialog(),
    );
    return result ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) {
          Navigator.of(context).pop(false);
        }
      },
      child: AlertDialog(
        backgroundColor: AppColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppColors.borderRadius),
          side: const BorderSide(color: AppColors.primary, width: 1.5),
        ),
        title: Row(
          children: [
            const Icon(
              Icons.location_on,
              color: AppColors.primary,
              size: 28.0,
            ),
            const SizedBox(width: 12.0),
            Expanded(
              child: Text(
                l10n.locationDisclosureTitle,
                style: AppTypography.titleLarge.copyWith(
                  color: AppColors.onBackground,
                  fontSize: 18.0,
                ),
              ),
            ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              l10n.locationDisclosureBody,
              style: AppTypography.bodyMedium.copyWith(
                color: AppColors.textSecondary,
                height: 1.5,
              ),
            ),
          ],
        ),
        actionsPadding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 16.0),
        actions: [
          OutlinedButton(
            key: const ValueKey('disclosure_not_now_button'),
            onPressed: () => Navigator.of(context).pop(false),
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.border),
              foregroundColor: AppColors.textSecondary,
            ),
            child: Text(l10n.notNowAction),
          ),
          ElevatedButton(
            key: const ValueKey('disclosure_continue_button'),
            onPressed: () => Navigator.of(context).pop(true),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: AppColors.onPrimary,
            ),
            child: Text(l10n.continueAction),
          ),
        ],
      ),
    );
  }
}
