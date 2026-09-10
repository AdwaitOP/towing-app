import '../../l10n/app_localizations.dart';

/// Canonical truck types supported by the Towing Dispatch System.
/// Enforced by Firestore Security Rules and backend validators.
enum TruckType {
  flatbed('flatbed'),
  tochan('tochan'),
  hydraulic('hydraulic'),
  crane('crane');

  final String backendValue;
  const TruckType(this.backendValue);

  /// Safely parses truck type from canonical backend string.
  /// Returns null if value is null, not a String, or not a valid canonical truck type.
  static TruckType? tryParse(dynamic value) {
    if (value == null || value is! String) return null;
    final trimmed = value.trim().toLowerCase();
    for (final type in TruckType.values) {
      if (type.backendValue == trimmed) {
        return type;
      }
    }
    return null;
  }

  /// Parses truck type from canonical backend string.
  /// Throws [FormatException] on null, empty, or unrecognized values.
  static TruckType fromString(String? value) {
    final parsed = tryParse(value);
    if (parsed == null) {
      throw FormatException('Invalid or unrecognized truck type: "$value"');
    }
    return parsed;
  }

  /// Get localized human-readable display name.
  String getLocalizedLabel(AppLocalizations l10n) {
    switch (this) {
      case TruckType.flatbed:
        return l10n.truckTypeFlatbed;
      case TruckType.tochan:
        return l10n.truckTypeTochan;
      case TruckType.hydraulic:
        return l10n.truckTypeHydraulic;
      case TruckType.crane:
        return l10n.truckTypeCrane;
    }
  }
}
