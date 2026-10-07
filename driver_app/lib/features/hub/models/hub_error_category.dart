import '../../../l10n/app_localizations.dart';

/// Normalized error categories for the Dispatch Hub and Duty Controller.
/// Encapsulates fail-closed errors without leaking raw platform exception strings.
enum HubErrorCategory {
  servicesDisabled,
  foregroundPermissionDenied,
  foregroundPermissionDeniedForever,
  backgroundPermissionDenied,
  notificationPermissionDenied,
  locationUnavailable,
  serviceStartupFailed,
  dutyUpdateFailed,
  activeJobPreventOffDuty,
  activeOfferPreventOffDuty,
  notApproved,
  reconciliationFailed;

  String localizedMessage(AppLocalizations l10n) {
    switch (this) {
      case HubErrorCategory.servicesDisabled:
        return l10n.locationServicesDisabled;
      case HubErrorCategory.foregroundPermissionDenied:
        return l10n.locationPermissionRequired;
      case HubErrorCategory.foregroundPermissionDeniedForever:
        return l10n.locationPermissionPermanentlyDenied;
      case HubErrorCategory.backgroundPermissionDenied:
        return l10n.backgroundLocationRequired;
      case HubErrorCategory.notificationPermissionDenied:
        return l10n.notificationPermissionRequired;
      case HubErrorCategory.locationUnavailable:
        return l10n.trackingUnavailable;
      case HubErrorCategory.serviceStartupFailed:
        return l10n.dutyServiceStartupFailed;
      case HubErrorCategory.dutyUpdateFailed:
        return l10n.dutyServiceStartupFailed;
      case HubErrorCategory.activeJobPreventOffDuty:
        return l10n.cannotGoOffDutyActiveJob;
      case HubErrorCategory.activeOfferPreventOffDuty:
        return l10n.logoutBlockedActiveOffer;
      case HubErrorCategory.notApproved:
        return l10n.hubStatusOffDuty;
      case HubErrorCategory.reconciliationFailed:
        return l10n.reconciliationFailed;
    }
  }
}
