import 'package:flutter/foundation.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/models/truck_type.dart';
import '../../../core/services/profile_service.dart';

import '../../../l10n/app_localizations.dart';

/// Controller managing driver profile onboarding and validation.
class ProfileController extends ChangeNotifier {
  final ProfileService _profileService;

  ProfileController({ProfileService? profileService})
      : _profileService = profileService ?? ProfileService();

  TruckType _selectedTruckType = TruckType.flatbed;
  bool _isSaving = false;
  bool _isDisposed = false;
  String? _errorCode;

  TruckType get selectedTruckType => _selectedTruckType;
  bool get isSaving => _isSaving;
  String? get errorMessage => _errorCode;

  /// Returns localized user-facing error message.
  String? getErrorMessage(AppLocalizations l10n) {
    if (_errorCode == 'NAME_REQUIRED') return l10n.driverNameRequired;
    if (_errorCode == 'VEHICLE_REQUIRED') return l10n.vehicleNumberRequired;
    if (_errorCode == 'SAVE_FAILED') return l10n.profileSaveError;
    return null;
  }

  void selectTruckType(TruckType type) {
    _selectedTruckType = type;
    notifyListeners();
  }

  void clearError() {
    _errorCode = null;
    notifyListeners();
  }

  /// Validates and saves the initial driver profile in `drivers/{uid}`.
  Future<DriverProfile?> saveProfile({
    required String uid,
    required String phone,
    required String name,
    required String vehicleNumber,
  }) async {
    if (_isSaving || _isDisposed) return null;

    final trimmedName = name.trim();
    final trimmedVehicle = vehicleNumber.trim().toUpperCase();

    if (trimmedName.isEmpty) {
      _errorCode = 'NAME_REQUIRED';
      notifyListeners();
      return null;
    }

    if (trimmedVehicle.isEmpty) {
      _errorCode = 'VEHICLE_REQUIRED';
      notifyListeners();
      return null;
    }

    _isSaving = true;
    _errorCode = null;
    notifyListeners();

    try {
      final profile = DriverProfile(
        uid: uid,
        name: trimmedName,
        phone: phone,
        truckType: _selectedTruckType,
        vehicleNumber: trimmedVehicle,
        isOnDuty: false,
      );

      final saved = await _profileService.createProfile(profile);
      if (_isDisposed) return saved;
      _isSaving = false;
      notifyListeners();
      return saved;
    } catch (e) {
      if (_isDisposed) return null;
      _isSaving = false;
      _errorCode = 'SAVE_FAILED';
      notifyListeners();
      return null;
    }
  }

  @override
  void dispose() {
    _isDisposed = true;
    super.dispose();
  }
}
