import 'package:flutter/material.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/models/truck_type.dart';
import '../../../core/services/auth_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';
import '../controllers/profile_controller.dart';

/// Screen displayed when an authenticated driver has not yet created their `drivers/{uid}` profile.
class ProfileSetupScreen extends StatefulWidget {
  final String uid;
  final String phone;
  final ProfileController controller;
  final AuthService authService;
  final Function(DriverProfile)? onProfileCreated;

  const ProfileSetupScreen({
    super.key,
    required this.uid,
    required this.phone,
    required this.controller,
    required this.authService,
    this.onProfileCreated,
  });

  @override
  State<ProfileSetupScreen> createState() => _ProfileSetupScreenState();
}

class _ProfileSetupScreenState extends State<ProfileSetupScreen> {
  final _nameController = TextEditingController();
  final _vehicleController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _nameController.dispose();
    _vehicleController.dispose();
    super.dispose();
  }

  void _submit() async {
    if (!_formKey.currentState!.validate()) return;
    FocusScope.of(context).unfocus();

    final result = await widget.controller.saveProfile(
      uid: widget.uid,
      phone: widget.phone,
      name: _nameController.text,
      vehicleNumber: _vehicleController.text,
    );

    if (result != null && widget.onProfileCreated != null) {
      widget.onProfileCreated!(result);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.profileSetup),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: AppColors.error),
            tooltip: l10n.logout,
            onPressed: () => widget.authService.signOut(),
          ),
        ],
      ),
      body: SafeArea(
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) {
            final isSaving = widget.controller.isSaving;
            final errorMessage = widget.controller.getErrorMessage(l10n);

            return SingleChildScrollView(
              padding: const EdgeInsets.all(24.0),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      l10n.profileSetup,
                      style: AppTypography.displayLarge,
                    ),
                    const SizedBox(height: 8.0),
                    Text(
                      l10n.profileSetupSubtitle,
                      style: AppTypography.bodyMedium,
                    ),
                    const SizedBox(height: 24.0),

                    // Authenticated phone display (Read-only banner)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
                      decoration: BoxDecoration(
                        color: AppColors.surfaceVariant,
                        borderRadius: BorderRadius.circular(AppColors.borderRadius),
                        border: Border.all(color: AppColors.border),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.phone, color: AppColors.primary, size: 20.0),
                          const SizedBox(width: 12.0),
                          Text(
                            widget.phone,
                            style: const TextStyle(
                              fontSize: 16.0,
                              fontWeight: FontWeight.bold,
                              color: AppColors.onBackground,
                            ),
                          ),
                          const Spacer(),
                          const Icon(Icons.check_circle, color: AppColors.success, size: 18.0),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24.0),

                    // Driver Full Name
                    Text(
                      l10n.driverName,
                      style: AppTypography.titleLarge,
                    ),
                    const SizedBox(height: 8.0),
                    TextFormField(
                      controller: _nameController,
                      enabled: !isSaving,
                      textCapitalization: TextCapitalization.words,
                      style: const TextStyle(
                        fontSize: 18.0,
                        fontWeight: FontWeight.w600,
                        color: AppColors.onBackground,
                      ),
                      decoration: InputDecoration(
                        hintText: l10n.driverNameHint,
                        prefixIcon: const Icon(Icons.person, color: AppColors.primary),
                      ),
                      validator: (value) {
                        if (value == null || value.trim().isEmpty) {
                          return l10n.driverNameRequired;
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 24.0),

                    // Tow Truck Type Selector
                    Text(
                      l10n.truckType,
                      style: AppTypography.titleLarge,
                    ),
                    const SizedBox(height: 8.0),
                    DropdownButtonFormField<TruckType>(
                      initialValue: widget.controller.selectedTruckType,
                      decoration: const InputDecoration(
                        prefixIcon: Icon(Icons.build_circle, color: AppColors.primary),
                      ),
                      dropdownColor: AppColors.surface,
                      items: TruckType.values.map((type) {
                        return DropdownMenuItem<TruckType>(
                          value: type,
                          child: Text(
                            type.getLocalizedLabel(l10n),
                            style: const TextStyle(
                              fontSize: 16.0,
                              fontWeight: FontWeight.w600,
                              color: AppColors.onBackground,
                            ),
                          ),
                        );
                      }).toList(),
                      onChanged: isSaving
                          ? null
                          : (type) {
                              if (type != null) {
                                widget.controller.selectTruckType(type);
                              }
                            },
                    ),
                    const SizedBox(height: 24.0),

                    // Vehicle Registration Number
                    Text(
                      l10n.vehicleNumber,
                      style: AppTypography.titleLarge,
                    ),
                    const SizedBox(height: 8.0),
                    TextFormField(
                      controller: _vehicleController,
                      enabled: !isSaving,
                      textCapitalization: TextCapitalization.characters,
                      style: const TextStyle(
                        fontSize: 18.0,
                        fontWeight: FontWeight.bold,
                        color: AppColors.onBackground,
                        letterSpacing: 1.5,
                      ),
                      decoration: InputDecoration(
                        hintText: l10n.vehicleNumberHint,
                        prefixIcon: const Icon(Icons.pin, color: AppColors.primary),
                      ),
                      validator: (value) {
                        if (value == null || value.trim().isEmpty) {
                          return l10n.vehicleNumberRequired;
                        }
                        return null;
                      },
                    ),

                    if (errorMessage != null) ...[
                      const SizedBox(height: 20.0),
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

                    const SizedBox(height: 36.0),
                    ElevatedButton(
                      onPressed: isSaving ? null : _submit,
                      child: isSaving
                          ? const SizedBox(
                              width: 24.0,
                              height: 24.0,
                              child: CircularProgressIndicator(
                                strokeWidth: 3.0,
                                valueColor: AlwaysStoppedAnimation<Color>(AppColors.onPrimary),
                              ),
                            )
                          : Text(l10n.continueButton),
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
