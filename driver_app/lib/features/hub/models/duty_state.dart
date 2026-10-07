/// Authoritative duty state stored in Cloud Firestore.
enum AuthoritativeDutyState {
  unknown,
  offDuty,
  onDuty,
}

/// Target desired duty state requested by user or system.
enum DesiredDutyState {
  off,
  on,
}

/// Health and lifecycle of background/foreground location tracking.
enum TrackingHealth {
  off,
  starting,
  healthy,
  degraded,
  permissionBlocked,
  serviceUnavailable,
  reconciliationFailed,
}
