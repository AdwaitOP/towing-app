import 'package:flutter/material.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';
import '../controllers/auth_controller.dart';

/// Screen allowing the driver to enter the 6-digit WhatsApp OTP.
class OtpVerifyScreen extends StatefulWidget {
  final AuthController controller;
  final String phone;

  const OtpVerifyScreen({
    super.key,
    required this.controller,
    required this.phone,
  });

  @override
  State<OtpVerifyScreen> createState() => _OtpVerifyScreenState();
}

class _OtpVerifyScreenState extends State<OtpVerifyScreen> {
  final _otpController = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _isLocalVerifying = false;

  @override
  void dispose() {
    _otpController.dispose();
    super.dispose();
  }

  void _verify() async {
    if (_isLocalVerifying || widget.controller.isVerifying || widget.controller.isLoading) return;
    if (!_formKey.currentState!.validate()) return;

    _isLocalVerifying = true;
    FocusScope.of(context).unfocus();

    final otp = _otpController.text.trim();
    try {
      final success = await widget.controller.verifyOtp(otp);
      if (success && mounted) {
        // Upon successful authentication, pop back to the root where SessionResolver takes over
        Navigator.of(context).popUntil((route) => route.isFirst);
      }
    } finally {
      if (mounted) {
        setState(() {
          _isLocalVerifying = false;
        });
      }
    }
  }

  void _resend() async {
    final success = await widget.controller.resendOtp();
    if (success && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppLocalizations.of(context)!.otpSent),
          backgroundColor: AppColors.success,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.verifyOtp),
      ),
      body: SafeArea(
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) {
            final isLoading = widget.controller.isLoading;
            final isVerifying = widget.controller.isVerifying || _isLocalVerifying;
            final isBlocked = isLoading || isVerifying;
            final errorMessage = widget.controller.getErrorMessage(l10n);
            final canResend = widget.controller.canResendOtp && !isBlocked;
            final countdown = widget.controller.resendCountdown;

            return SingleChildScrollView(
              padding: const EdgeInsets.all(24.0),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 16.0),
                    Text(
                      l10n.enterOtp,
                      style: AppTypography.headlineMedium,
                    ),
                    const SizedBox(height: 8.0),
                    Text(
                      l10n.otpSentTo(widget.phone),
                      style: AppTypography.bodyMedium,
                    ),
                    const SizedBox(height: 36.0),

                    // 6-digit OTP Field
                    TextFormField(
                      controller: _otpController,
                      keyboardType: TextInputType.number,
                      textAlign: TextAlign.center,
                      maxLength: 6,
                      enabled: !isBlocked,
                      autofocus: true,
                      style: AppTypography.otpDigit,
                      decoration: const InputDecoration(
                        hintText: '••••••',
                        counterText: '',
                        contentPadding: EdgeInsets.symmetric(vertical: 16.0),
                      ),
                      onChanged: (value) {
                        if (value.length == 6 && !isBlocked) {
                          _verify();
                        }
                      },
                      validator: (value) {
                        if (value == null || value.trim().length != 6) {
                          return l10n.invalidOtp;
                        }
                        if (!RegExp(r'^\d{6}$').hasMatch(value.trim())) {
                          return l10n.invalidOtp;
                        }
                        return null;
                      },
                    ),

                    if (errorMessage != null) ...[
                      const SizedBox(height: 16.0),
                      Container(
                        padding: const EdgeInsets.all(14.0),
                        decoration: BoxDecoration(
                          color: AppColors.error.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(AppColors.borderRadius),
                          border: Border.all(color: AppColors.error, width: 1.5),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.error_outline, color: AppColors.error),
                            const SizedBox(width: 12.0),
                            Expanded(
                              child: Text(
                                errorMessage,
                                style: const TextStyle(
                                  color: AppColors.error,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],

                    const SizedBox(height: 32.0),
                    ElevatedButton(
                      onPressed: isBlocked ? null : _verify,
                      child: isBlocked
                          ? const SizedBox(
                              width: 24.0,
                              height: 24.0,
                              child: CircularProgressIndicator(
                                strokeWidth: 3.0,
                                valueColor: AlwaysStoppedAnimation<Color>(AppColors.onPrimary),
                              ),
                            )
                          : Text(l10n.verifyOtp),
                    ),

                    const SizedBox(height: 20.0),
                    // Resend OTP / Cooldown timer
                    OutlinedButton(
                      onPressed: (canResend && !isLoading) ? _resend : null,
                      child: Text(
                        canResend
                            ? l10n.resendOtp
                            : l10n.resendOtpCooldown(countdown),
                      ),
                    ),

                    const SizedBox(height: 16.0),
                    TextButton(
                      onPressed: isLoading
                          ? null
                          : () {
                              widget.controller.clearError();
                              Navigator.of(context).pop();
                            },
                      child: Text(
                        l10n.changePhoneNumber,
                        style: const TextStyle(color: AppColors.primaryLight),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
