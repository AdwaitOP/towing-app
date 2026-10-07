import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

/// Prominent status banner displayed when a driver is temporarily paused
/// due to cancellations (`bannedUntil > now`).
///
/// Invariant: This banner is informational only and does NOT disable the ON DUTY toggle.
class TemporaryBanBanner extends StatelessWidget {
  final DateTime? bannedUntil;
  final DateTime Function()? clock;

  const TemporaryBanBanner({
    super.key,
    required this.bannedUntil,
    this.clock,
  });

  @override
  Widget build(BuildContext context) {
    final now = clock != null ? clock!() : DateTime.now();
    if (bannedUntil == null || !bannedUntil!.isAfter(now)) {
      return const SizedBox.shrink();
    }

    final l10n = AppLocalizations.of(context)!;
    final formattedTime = DateFormat.yMMMd().add_jm().format(bannedUntil!);

    return Container(
      key: const ValueKey('temporary_ban_banner'),
      margin: const EdgeInsets.only(bottom: 16.0),
      padding: const EdgeInsets.all(16.0),
      decoration: BoxDecoration(
        color: const Color(0xFF330005),
        borderRadius: BorderRadius.circular(AppColors.borderRadius),
        border: Border.all(color: AppColors.error, width: 2.0),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.warning_amber_rounded,
            color: AppColors.error,
            size: 32.0,
          ),
          const SizedBox(width: 14.0),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.temporaryBanBanner(formattedTime),
                  style: AppTypography.bodyMedium.copyWith(
                    color: AppColors.onBackground,
                    fontWeight: FontWeight.w600,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
