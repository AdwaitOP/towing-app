import 'package:flutter/material.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/services/auth_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

/// Stage 1 Authenticated Placeholder Screen.
/// Displays driver profile summary and confirmation that Stage 1 setup is complete.
class Stage1HomeScreen extends StatelessWidget {
  final DriverProfile profile;
  final AuthService authService;
  final Function(Locale)? onLocaleChanged;

  const Stage1HomeScreen({
    super.key,
    required this.profile,
    required this.authService,
    this.onLocaleChanged,
  });

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.appName),
        actions: [
          if (onLocaleChanged != null)
            PopupMenuButton<Locale>(
              icon: const Icon(Icons.language, color: AppColors.primary),
              tooltip: l10n.selectLanguage,
              onSelected: onLocaleChanged,
              itemBuilder: (context) => [
                const PopupMenuItem(
                  value: Locale('en'),
                  child: Text('English'),
                ),
                const PopupMenuItem(
                  value: Locale('hi'),
                  child: Text('हिन्दी (Hindi)'),
                ),
                const PopupMenuItem(
                  value: Locale('mr'),
                  child: Text('मराठी (Marathi)'),
                ),
              ],
            ),
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
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 12.0),
              // Success banner
              Container(
                padding: const EdgeInsets.all(20.0),
                decoration: BoxDecoration(
                  color: AppColors.primaryContainer,
                  borderRadius: BorderRadius.circular(AppColors.borderRadius),
                  border: Border.all(color: AppColors.primary, width: 2.0),
                ),
                child: Column(
                  children: [
                    const Icon(
                      Icons.check_circle_outline,
                      color: AppColors.primary,
                      size: 52.0,
                    ),
                    const SizedBox(height: 12.0),
                    Text(
                      l10n.driverSetupComplete,
                      style: AppTypography.headlineMedium.copyWith(color: AppColors.primaryLight),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8.0),
                    Text(
                      l10n.stage1Subtitle,
                      style: AppTypography.bodyMedium,
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 28.0),

              // Profile Details Card
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20.0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.badge, color: AppColors.primary),
                          const SizedBox(width: 12.0),
                          Text(l10n.driverName, style: AppTypography.bodyMedium),
                        ],
                      ),
                      const SizedBox(height: 6.0),
                      Text(
                        profile.name,
                        style: AppTypography.titleLarge,
                      ),
                      const Divider(height: 28.0, color: AppColors.border),

                      Row(
                        children: [
                          const Icon(Icons.phone, color: AppColors.primary),
                          const SizedBox(width: 12.0),
                          Text(l10n.phoneNumber, style: AppTypography.bodyMedium),
                        ],
                      ),
                      const SizedBox(height: 6.0),
                      Text(
                        profile.phone,
                        style: AppTypography.titleLarge,
                      ),
                      const Divider(height: 28.0, color: AppColors.border),

                      Row(
                        children: [
                          const Icon(Icons.local_shipping, color: AppColors.primary),
                          const SizedBox(width: 12.0),
                          Text(l10n.truckType, style: AppTypography.bodyMedium),
                        ],
                      ),
                      const SizedBox(height: 6.0),
                      Text(
                        profile.truckType.getLocalizedLabel(l10n),
                        style: AppTypography.titleLarge,
                      ),
                      const Divider(height: 28.0, color: AppColors.border),

                      Row(
                        children: [
                          const Icon(Icons.pin, color: AppColors.primary),
                          const SizedBox(width: 12.0),
                          Text(l10n.vehicleNumber, style: AppTypography.bodyMedium),
                        ],
                      ),
                      const SizedBox(height: 6.0),
                      Text(
                        profile.vehicleNumber,
                        style: AppTypography.titleLarge.copyWith(letterSpacing: 1.2),
                      ),
                      const Divider(height: 28.0, color: AppColors.border),

                      Row(
                        children: [
                          const Icon(Icons.power_settings_new, color: AppColors.textDisabled),
                          const SizedBox(width: 12.0),
                          Text(l10n.dutyStatus, style: AppTypography.bodyMedium),
                          const Spacer(),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12.0, vertical: 4.0),
                            decoration: BoxDecoration(
                              color: AppColors.surfaceVariant,
                              borderRadius: BorderRadius.circular(20.0),
                              border: Border.all(color: AppColors.border),
                            ),
                            child: Text(
                              l10n.statusOffDuty,
                              style: const TextStyle(
                                color: AppColors.textSecondary,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),

              const SizedBox(height: 36.0),
              OutlinedButton.icon(
                onPressed: () => authService.signOut(),
                icon: const Icon(Icons.logout, color: AppColors.error),
                label: Text(
                  l10n.logout,
                  style: const TextStyle(color: AppColors.error),
                ),
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: AppColors.error, width: 2.0),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
