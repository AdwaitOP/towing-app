import 'package:flutter/material.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';
import '../controllers/auth_controller.dart';
import 'otp_verify_screen.dart';

/// Screen allowing the driver to enter their Indian phone number and request a WhatsApp OTP.
class PhoneLoginScreen extends StatefulWidget {
  final AuthController controller;
  final Function(Locale)? onLocaleChanged;

  const PhoneLoginScreen({
    super.key,
    required this.controller,
    this.onLocaleChanged,
  });

  @override
  State<PhoneLoginScreen> createState() => _PhoneLoginScreenState();
}

class _PhoneLoginScreenState extends State<PhoneLoginScreen> {
  final _phoneController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  @override
  void initState() {
    super.initState();
    _phoneController.text = widget.controller.phone.replaceFirst('+91', '');
  }

  @override
  void dispose() {
    _phoneController.dispose();
    super.dispose();
  }

  void _submit() async {
    if (!_formKey.currentState!.validate()) return;
    FocusScope.of(context).unfocus();

    final rawPhone = '+91${_phoneController.text.trim()}';
    final success = await widget.controller.sendOtp(rawPhone);

    if (success && mounted) {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (context) => OtpVerifyScreen(
            controller: widget.controller,
            phone: rawPhone,
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.appName),
        actions: [
          if (widget.onLocaleChanged != null)
            PopupMenuButton<Locale>(
              icon: const Icon(Icons.language, color: AppColors.primary),
              tooltip: l10n.selectLanguage,
              onSelected: widget.onLocaleChanged,
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
        ],
      ),
      body: SafeArea(
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) {
            final isLoading = widget.controller.isLoading;
            final errorMessage = widget.controller.getErrorMessage(l10n);

            return SingleChildScrollView(
              padding: const EdgeInsets.all(24.0),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 20.0),
                    // High-contrast safety icon
                    Center(
                      child: Container(
                        width: 80.0,
                        height: 80.0,
                        decoration: BoxDecoration(
                          color: AppColors.primaryContainer,
                          shape: BoxShape.circle,
                          border: Border.all(color: AppColors.primary, width: 2.0),
                        ),
                        child: const Icon(
                          Icons.local_shipping,
                          color: AppColors.primary,
                          size: 44.0,
                        ),
                      ),
                    ),
                    const SizedBox(height: 24.0),
                    Text(
                      l10n.appName,
                      style: AppTypography.displayLarge,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8.0),
                    Text(
                      l10n.profileSetupSubtitle,
                      style: AppTypography.bodyMedium,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 40.0),

                    // Phone input field with fixed +91 prefix
                    Text(
                      l10n.phoneNumber,
                      style: AppTypography.titleLarge,
                    ),
                    const SizedBox(height: 12.0),
                    TextFormField(
                      controller: _phoneController,
                      keyboardType: TextInputType.phone,
                      maxLength: 10,
                      enabled: !isLoading,
                      style: const TextStyle(
                        fontSize: 20.0,
                        fontWeight: FontWeight.bold,
                        color: AppColors.onBackground,
                        letterSpacing: 1.5,
                      ),
                      decoration: InputDecoration(
                        hintText: l10n.phoneNumberHint,
                        counterText: '',
                        prefixIcon: const Padding(
                          padding: EdgeInsets.symmetric(horizontal: 16.0, vertical: 14.0),
                          child: Text(
                            '+91',
                            style: TextStyle(
                              fontSize: 20.0,
                              fontWeight: FontWeight.bold,
                              color: AppColors.primary,
                            ),
                          ),
                        ),
                      ),
                      validator: (value) {
                        if (value == null || value.trim().length != 10) {
                          return l10n.invalidPhone;
                        }
                        if (!RegExp(r'^[6-9]\d{9}$').hasMatch(value.trim())) {
                          return l10n.invalidPhone;
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
                      onPressed: isLoading ? null : _submit,
                      child: isLoading
                          ? const SizedBox(
                              width: 24.0,
                              height: 24.0,
                              child: CircularProgressIndicator(
                                strokeWidth: 3.0,
                                valueColor: AlwaysStoppedAnimation<Color>(AppColors.onPrimary),
                              ),
                            )
                          : Text(l10n.sendOtp),
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
