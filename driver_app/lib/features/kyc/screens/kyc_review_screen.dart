import 'dart:io';
import 'package:flutter/material.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/models/kyc_error_category.dart';
import '../../../core/services/auth_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../controllers/kyc_controller.dart';
import 'kyc_camera_screen.dart';

class KycReviewScreen extends StatefulWidget {
  final KycController controller;
  final DriverProfile profile;
  final AuthService authService;

  const KycReviewScreen({
    super.key,
    required this.controller,
    required this.profile,
    required this.authService,
  });

  @override
  State<KycReviewScreen> createState() => _KycReviewScreenState();
}

class _KycReviewScreenState extends State<KycReviewScreen> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onControllerChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onControllerChanged);
    super.dispose();
  }

  void _onControllerChanged() {
    if (mounted) {
      setState(() {});
    }
  }

  Future<void> _retakeDoc(KycDocType docType) async {
    final file = await Navigator.of(context).push<File>(
      MaterialPageRoute(
        builder: (_) => KycCameraScreen(
          docType: docType,
          controller: widget.controller,
          profile: widget.profile,
          authService: widget.authService,
          isRetake: true,
        ),
      ),
    );
    if (file != null && mounted) {
      switch (docType) {
        case KycDocType.id:
          widget.controller.setIdFile(file);
          break;
        case KycDocType.rc:
          widget.controller.setRcFile(file);
          break;
        case KycDocType.selfie:
          widget.controller.setSelfieFile(file);
          break;
      }
    }
  }

  Future<void> _handleSubmit() async {
    await widget.controller.submitVerification(profile: widget.profile);
    // Authoritative transition: submit callable succeeds -> Firestore verificationStatus
    // becomes pending -> profile stream emits pending -> SessionResolver stops rendering KycFlow
    // -> KycFlow + nested Navigator + controller are disposed -> SessionResolver renders KycPendingScreen.
    // Review screen does NOT imperatively push, pop, or replace routes.
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final controller = widget.controller;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: Text(l10n.kycReviewTitle),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                l10n.kycReviewTitle,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                  color: AppColors.onBackground,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                l10n.kycReviewSubtitle,
                style: const TextStyle(
                  fontSize: 14,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 20),

              // Error Banner if submission failed
              if (controller.errorCategory != null)
                Container(
                  margin: const EdgeInsets.only(bottom: 20),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColors.error.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.error),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline, color: AppColors.error, size: 24),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          controller.errorCategory!.toLocalizedMessage(l10n),
                          style: const TextStyle(color: AppColors.error, fontSize: 13),
                        ),
                      ),
                    ],
                  ),
                ),

              // Document 1: ID
              _buildDocPreviewCard(
                title: l10n.kycDocIdTitle,
                file: controller.idFile,
                onRetake: () => _retakeDoc(KycDocType.id),
                l10n: l10n,
              ),
              const SizedBox(height: 16),

              // Document 2: RC
              _buildDocPreviewCard(
                title: l10n.kycDocRcTitle,
                file: controller.rcFile,
                onRetake: () => _retakeDoc(KycDocType.rc),
                l10n: l10n,
              ),
              const SizedBox(height: 16),

              // Document 3: Selfie
              _buildDocPreviewCard(
                title: l10n.kycDocSelfieTitle,
                file: controller.selfieFile,
                onRetake: () => _retakeDoc(KycDocType.selfie),
                l10n: l10n,
              ),
              const SizedBox(height: 28),

              // Upload Progress Bar
              if (controller.isSubmitting) ...[
                LinearProgressIndicator(
                  value: controller.uploadProgress > 0 ? controller.uploadProgress : null,
                  backgroundColor: AppColors.surface,
                  valueColor: const AlwaysStoppedAnimation<Color>(AppColors.primary),
                ),
                const SizedBox(height: 12),
                Text(
                  l10n.submittingVerification,
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.textSecondary,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 16),
              ],

              // Submit Button
              ElevatedButton(
                onPressed: controller.isSubmitting || !controller.hasAllDocuments
                    ? null
                    : _handleSubmit,
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  backgroundColor: AppColors.primary,
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: AppColors.primary.withValues(alpha: 0.3),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                child: controller.isSubmitting
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2.5,
                          valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                        ),
                      )
                    : Text(
                        l10n.submitVerification,
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildDocPreviewCard({
    required String title,
    required File? file,
    required VoidCallback onRetake,
    required AppLocalizations l10n,
  }) {
    final hasFile = file != null && file.existsSync();

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: SizedBox(
              width: 72,
              height: 72,
              child: hasFile
                  ? Image.file(
                      file,
                      fit: BoxFit.cover,
                      errorBuilder: (context, error, stackTrace) => Container(
                        color: Colors.black26,
                        child: const Icon(Icons.broken_image, color: Colors.white38),
                      ),
                    )
                  : Container(
                      color: Colors.black26,
                      child: const Icon(Icons.broken_image, color: Colors.white38),
                    ),
            ),
          ),
          const SizedBox(width: 16),
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
                Row(
                  children: [
                    Icon(
                      hasFile ? Icons.check_circle : Icons.error_outline,
                      size: 16,
                      color: hasFile ? AppColors.success : AppColors.error,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      hasFile ? l10n.captured : l10n.missing,
                      style: TextStyle(
                        fontSize: 12,
                        color: hasFile ? AppColors.success : AppColors.error,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          OutlinedButton(
            onPressed: widget.controller.isSubmitting ? null : onRetake,
            style: OutlinedButton.styleFrom(
              minimumSize: Size.zero,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              side: const BorderSide(color: AppColors.primary),
            ),
            child: Text(
              l10n.retake,
              style: const TextStyle(fontSize: 13, color: AppColors.primary),
            ),
          ),
        ],
      ),
    );
  }
}
