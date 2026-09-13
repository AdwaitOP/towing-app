import 'package:flutter/material.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/services/auth_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../controllers/kyc_controller.dart';
import 'kyc_camera_screen.dart';

class KycConsentScreen extends StatefulWidget {
  final DriverProfile profile;
  final AuthService authService;
  final KycController? controller;

  const KycConsentScreen({
    super.key,
    required this.profile,
    required this.authService,
    this.controller,
  });

  @override
  State<KycConsentScreen> createState() => _KycConsentScreenState();
}

class _KycConsentScreenState extends State<KycConsentScreen> {
  late final KycController _controller;
  bool _ownsController = false;
  bool _consentGiven = false;

  @override
  void initState() {
    super.initState();
    if (widget.controller != null) {
      _controller = widget.controller!;
    } else {
      _controller = KycController(authService: widget.authService);
      _ownsController = true;
    }
  }

  @override
  void dispose() {
    if (_ownsController) {
      _controller.dispose();
    }
    super.dispose();
  }

  void _startCapture() {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => KycCameraScreen(
          docType: KycDocType.id,
          controller: _controller,
          profile: widget.profile,
          authService: widget.authService,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Text(l10n.kycVerificationTitle),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: AppColors.error),
            tooltip: l10n.logout,
            onPressed: () => widget.authService.signOut(),
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header Icon & Title
              const Center(
                child: Icon(
                  Icons.verified_user_outlined,
                  size: 64,
                  color: AppColors.primary,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                l10n.kycVerificationTitle,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                  color: AppColors.onBackground,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                l10n.kycConsentSubtitle,
                style: const TextStyle(
                  fontSize: 14,
                  color: AppColors.textSecondary,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),

              // Privacy and consent notice
              Container(
                padding: const EdgeInsets.all(16.0),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.primary.withValues(alpha: 0.3)),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.privacy_tip_outlined, color: AppColors.primary, size: 24),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        l10n.kycConsentNotice,
                        style: const TextStyle(
                          fontSize: 13,
                          height: 1.4,
                          color: AppColors.onBackground,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // Document Cards
              _buildDocItem(
                icon: Icons.badge_outlined,
                title: l10n.kycDocIdTitle,
                description: l10n.kycDocIdDesc,
              ),
              const SizedBox(height: 12),
              _buildDocItem(
                icon: Icons.directions_car_outlined,
                title: l10n.kycDocRcTitle,
                description: l10n.kycDocRcDesc,
              ),
              const SizedBox(height: 12),
              _buildDocItem(
                icon: Icons.face_outlined,
                title: l10n.kycDocSelfieTitle,
                description: l10n.kycDocSelfieDesc,
              ),
              const SizedBox(height: 24),

              // Consent Checkbox
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: _consentGiven,
                activeColor: AppColors.primary,
                title: Text(
                  l10n.kycConsentCheckbox,
                  style: const TextStyle(fontSize: 13, color: AppColors.onBackground),
                ),
                controlAffinity: ListTileControlAffinity.leading,
                onChanged: (val) {
                  setState(() {
                    _consentGiven = val ?? false;
                  });
                },
              ),
              const SizedBox(height: 24),

              // Continue Button
              ElevatedButton(
                onPressed: _consentGiven ? _startCapture : null,
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: AppColors.primary.withValues(alpha: 0.3),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                child: Text(
                  l10n.kycAgreeAndContinue,
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildDocItem({
    required IconData icon,
    required String title,
    required String description,
  }) {
    return Container(
      padding: const EdgeInsets.all(16.0),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: AppColors.primary, size: 28),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: AppColors.onBackground,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  description,
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.textSecondary,
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
