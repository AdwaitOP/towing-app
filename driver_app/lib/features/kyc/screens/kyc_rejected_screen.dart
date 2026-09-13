import 'package:flutter/material.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/services/auth_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../controllers/kyc_controller.dart';
import 'kyc_consent_screen.dart';

class KycRejectedScreen extends StatelessWidget {
  final DriverProfile profile;
  final AuthService authService;
  final KycController? controller;
  final VoidCallback? onResubmit;

  const KycRejectedScreen({
    super.key,
    required this.profile,
    required this.authService,
    this.controller,
    this.onResubmit,
  });

  void _onResubmit(BuildContext context) {
    if (onResubmit != null) {
      onResubmit!();
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => KycConsentScreen(
          profile: profile,
          authService: authService,
          controller: controller,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final reason = (profile.rejectionReason != null && profile.rejectionReason!.trim().isNotEmpty)
        ? profile.rejectionReason!
        : l10n.kycDefaultRejectionReason;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Text(l10n.appName),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: AppColors.error),
            tooltip: l10n.logout,
            onPressed: () => authService.signOut(),
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              const SizedBox(height: 20),
              // Rejection Icon
              Container(
                width: 88,
                height: 88,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: AppColors.error.withValues(alpha: 0.15),
                ),
                child: const Icon(
                  Icons.cancel_outlined,
                  size: 48,
                  color: AppColors.error,
                ),
              ),
              const SizedBox(height: 24),

              // Title & Subtitle
              Text(
                l10n.kycRejectedTitle,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                  color: AppColors.onBackground,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              Text(
                l10n.kycRejectedSubtitle,
                style: const TextStyle(
                  fontSize: 14,
                  height: 1.4,
                  color: AppColors.textSecondary,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 28),

              // Reason Card
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.error.withValues(alpha: 0.4)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.warning_amber_rounded, color: AppColors.error, size: 20),
                        const SizedBox(width: 8),
                        Text(
                          l10n.kycRejectionReasonLabel,
                          style: const TextStyle(
                            color: AppColors.error,
                            fontWeight: FontWeight.bold,
                            fontSize: 14,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Text(
                      reason,
                      style: const TextStyle(
                        fontSize: 14,
                        height: 1.4,
                        color: AppColors.onBackground,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 32),

              // Resubmit Button
              ElevatedButton.icon(
                onPressed: () => _onResubmit(context),
                icon: const Icon(Icons.refresh),
                label: Text(l10n.kycResubmit),
                style: ElevatedButton.styleFrom(
                  minimumSize: const Size.fromHeight(50),
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
              ),
              const SizedBox(height: 16),

              // Sign Out Button
              OutlinedButton.icon(
                onPressed: () => authService.signOut(),
                icon: const Icon(Icons.logout, color: AppColors.error),
                label: Text(l10n.logout, style: const TextStyle(color: AppColors.error)),
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: AppColors.error),
                  minimumSize: const Size.fromHeight(48),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
