import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import '../core/models/driver_profile.dart';
import '../core/services/auth_service.dart';
import '../core/services/location_service.dart';
import '../core/services/native_ownership_coordinator.dart';
import '../features/hub/controllers/duty_controller.dart';
import '../features/hub/models/duty_session.dart';
import '../l10n/app_localizations.dart';

/// Result status for coordinated logout operations.
enum LogoutResult {
  success,
  blockedActiveJob,
  blockedActiveOffer,
  failedDutyTransition,
}

/// Centralized coordinator for secure, state-aware driver sign-out across all UI screens.
/// Enforces authoritative duty deactivation and native tracking cleanup before allowing sign-out,
/// even when the Dispatch Hub controller is unmounted.
class AppLogoutCoordinator {
  static final Map<String, Future<LogoutResult>> _inFlightLogouts = {};
  static final Map<String, Object> _logoutOperations = {};
  static int _operationSerial = 0;

  static void resetInFlightLogoutForTesting() {
    _inFlightLogouts.clear();
    _logoutOperations.clear();
  }

  final AuthService authService;
  final LocationService? locationService;
  final DutyController? dutyController;
  final FirebaseFirestore? firestore;

  const AppLogoutCoordinator({
    required this.authService,
    this.locationService,
    this.dutyController,
    this.firestore,
  });

  LocationService get _effectiveLocationService {
    return locationService ??
        dutyController?.locationService ??
        DriverLocationService();
  }

  void _showError(BuildContext? context, LogoutResult result) {
    if (context == null || !context.mounted) return;
    final l10n = AppLocalizations.of(context);
    String message;
    switch (result) {
      case LogoutResult.blockedActiveJob:
        message =
            l10n?.logoutBlockedActiveJob ??
            'Cannot log out while an active job is assigned.';
        break;
      case LogoutResult.blockedActiveOffer:
        message =
            l10n?.logoutBlockedActiveOffer ??
            'Cannot log out while a job offer is pending.';
        break;
      case LogoutResult.failedDutyTransition:
        message =
            l10n?.logoutFailedDutyTransition ??
            'Failed to end duty session safely. Please try again.';
        break;
      case LogoutResult.success:
        return;
    }

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  /// Checks engagement guards, deactivates duty session cleanly on server, cleans up native worker, and signs out.
  /// Enforces single-flight concurrency scoped by authenticated UID: concurrent calls for the same UID join in flight.
  Future<LogoutResult> coordinateLogout({
    DriverProfile? profile,
    BuildContext? context,
  }) async {
    String? uid;
    try {
      uid =
          authService.currentUser?.uid ??
          profile?.uid ??
          dutyController?.boundUid;
    } catch (_) {
      uid = profile?.uid ?? dutyController?.boundUid;
    }

    if (uid == null) {
      return LogoutResult.failedDutyTransition;
    }

    if (_inFlightLogouts.containsKey(uid)) {
      return await _inFlightLogouts[uid]!;
    }

    final operation = Object();
    _logoutOperations[uid] = operation;
    final future = _coordinateLogoutInternal(
      uid: uid,
      operation: operation,
      profile: profile,
      context: context,
    );
    _inFlightLogouts[uid] = future;
    try {
      return await future;
    } finally {
      if (identical(_logoutOperations[uid], operation)) {
        _logoutOperations.remove(uid);
        _inFlightLogouts.remove(uid);
      }
    }
  }

  Future<LogoutResult> _coordinateLogoutInternal({
    required String uid,
    required Object operation,
    DriverProfile? profile,
    BuildContext? context,
  }) async {
    bool ownsOperation() {
      try {
        return identical(_logoutOperations[uid], operation) &&
            authService.currentUser?.uid == uid;
      } catch (_) {
        return false;
      }
    }

    final controller = dutyController;
    final barrierLease = controller?.beginLogoutBarrier(uid);
    final locService = _effectiveLocationService;
    NativeCleanupAcquisition? acquisition;
    final provider = locService is NativeCleanupProvider
        ? locService as NativeCleanupProvider
        : null;
    try {
      if (provider != null) {
        if (!ownsOperation()) return LogoutResult.failedDutyTransition;
        try {
          acquisition = await provider.beginCleanupAcquisition(
            'logout-${DateTime.now().microsecondsSinceEpoch}-${++_operationSerial}',
            uid,
          );
          if (!ownsOperation()) return LogoutResult.failedDutyTransition;
        } catch (_) {
          return LogoutResult.failedDutyTransition;
        }
      } else if (controller == null) {
        return LogoutResult.failedDutyTransition;
      }

      // Check for headless mock test environment where no Firebase/services are available
      bool hasFirebase = false;
      try {
        hasFirebase = Firebase.apps.isNotEmpty;
      } catch (_) {
        hasFirebase = false;
      }

      // Gate M4-F + M4-G: FRESH SERVER READ!
      // Cached OFF is NOT sufficient to authorize signOut.
      // Every logout path, including non-hub screens, must establish current
      // server-authoritative duty + engagement state before deciding teardown is unnecessary.
      Map<String, dynamic>? freshServerData;
      try {
        final loc = locationService ?? dutyController?.locationService;
        if (loc != null) {
          freshServerData = await loc.fetchServerDriverState(uid);
        } else if (firestore != null) {
          final snap = await firestore!
              .collection('drivers')
              .doc(uid)
              .get(const GetOptions(source: Source.server));
          freshServerData = snap.data();
        } else if (hasFirebase) {
          final db = FirebaseFirestore.instance;
          final snap = await db
              .collection('drivers')
              .doc(uid)
              .get(const GetOptions(source: Source.server));
          freshServerData = snap.data();
        }
      } catch (readErr) {
        // G-FRESH-4: fresh server read throws => fail closed, Auth remains signed in
        if (context != null && context.mounted) {
          _showError(context, LogoutResult.failedDutyTransition);
        }
        return LogoutResult.failedDutyTransition;
      }

      // A missing document, unavailable service, or indeterminate read cannot
      // authorize logout through a cached profile.
      if (freshServerData == null || !ownsOperation()) {
        if (context != null && context.mounted) {
          _showError(context, LogoutResult.failedDutyTransition);
        }
        return LogoutResult.failedDutyTransition;
      }
      late final DriverProfile effProfile;
      try {
        if (freshServerData['isOnDuty'] is! bool) {
          throw const FormatException('Fresh server duty state is unavailable');
        }
        effProfile = DriverProfile.fromMap(freshServerData, uid);
      } catch (_) {
        if (context != null && context.mounted) {
          _showError(context, LogoutResult.failedDutyTransition);
        }
        return LogoutResult.failedDutyTransition;
      }

      // Guard 1: Active job check (Gate M4-F)
      if (effProfile.hasActiveJob) {
        if (context != null && context.mounted) {
          _showError(context, LogoutResult.blockedActiveJob);
        }
        return LogoutResult.blockedActiveJob;
      }

      // Guard 2: Active offer check (Gate M4-F)
      if (effProfile.hasActiveOffer) {
        if (context != null && context.mounted) {
          _showError(context, LogoutResult.blockedActiveOffer);
        }
        return LogoutResult.blockedActiveOffer;
      }

      // Guard 3: If controller is mounted, pass the fresh profile through its
      // logout barrier. Normal profile updates are deliberately ignored there.
      if (dutyController != null) {
        final safeToSignOut = await dutyController!.prepareForSignOut(
          freshProfile: effProfile,
          logoutLease: barrierLease,
        );
        if (!safeToSignOut) {
          if (context != null && context.mounted) {
            _showError(context, LogoutResult.failedDutyTransition);
          }
          return LogoutResult.failedDutyTransition;
        }
      }

      // Guard 4: Non-hub or unmounted controller authoritative check
      if (dutyController == null) {
        final isServerOn = effProfile.isOnDuty;
        final captured = acquisition!.owner;

        DurableDutyOwnerRecord? durableOwner;
        DutySession? durableSession;
        bool isNativeRunning = false;

        try {
          durableOwner = await locService.getDurableOwnerRecord();
          if (!ownsOperation()) {
            return LogoutResult.failedDutyTransition;
          }
        } catch (_) {
          // G-DEFAULT-2: Native durable-owner read unavailable -> fail closed!
          if (context != null && context.mounted) {
            _showError(context, LogoutResult.failedDutyTransition);
          }
          return LogoutResult.failedDutyTransition;
        }

        try {
          isNativeRunning = await locService.isForegroundServiceRunning();
          if (!ownsOperation()) {
            return LogoutResult.failedDutyTransition;
          }
        } catch (_) {
          // G-DEFAULT-1: Native service-running read unavailable -> fail closed!
          if (context != null && context.mounted) {
            _showError(context, LogoutResult.failedDutyTransition);
          }
          return LogoutResult.failedDutyTransition;
        }

        try {
          durableSession = await locService.getDurableSession();
          if (!ownsOperation()) {
            return LogoutResult.failedDutyTransition;
          }
        } catch (_) {
          if (context != null && context.mounted) {
            _showError(context, LogoutResult.failedDutyTransition);
          }
          return LogoutResult.failedDutyTransition;
        }

        // Separate discovery reads cannot combine different exact native epochs
        // into permission to destroy whichever owner arrived last.
        if (durableOwner != null &&
            durableSession != null &&
            (durableOwner.uid != durableSession.uid ||
                durableOwner.sessionId != durableSession.sessionId ||
                durableOwner.generation != durableSession.generation ||
                durableOwner.lifecycleSeq != durableSession.lifecycleSeq)) {
          return LogoutResult.failedDutyTransition;
        }
        bool matchesCapture(
          String ownerUid,
          String sessionId,
          int generation,
          int? seq,
        ) =>
            captured != null &&
            captured.uid == ownerUid &&
            captured.sessionId == sessionId &&
            captured.generation == generation &&
            captured.lifecycleSeq == seq;
        // Observation can only reject a conflict; it cannot grant cleanup authority.
        if ((durableOwner != null &&
                !matchesCapture(
                  durableOwner.uid,
                  durableOwner.sessionId,
                  durableOwner.generation,
                  durableOwner.lifecycleSeq,
                )) ||
            (durableSession != null &&
                !matchesCapture(
                  durableSession.uid,
                  durableSession.sessionId,
                  durableSession.generation,
                  durableSession.lifecycleSeq,
                )) ||
            (captured == null && isNativeRunning)) {
          return LogoutResult.failedDutyTransition;
        }
        if (!ownsOperation() ||
            !await provider!.validateCleanupAcquisition(acquisition) ||
            !ownsOperation()) {
          return LogoutResult.failedDutyTransition;
        }
        // Server authority is independently captured by the fresh server response.
        if (isServerOn) {
          final sid = effProfile.activeDutySessionId;
          final gen = effProfile.dutyGeneration;
          final seq = effProfile.lifecycleSeq;
          if (sid == null || gen == null || seq == null || seq <= 0) {
            return LogoutResult.failedDutyTransition;
          }
          try {
            if (!ownsOperation()) return LogoutResult.failedDutyTransition;
            await locService.endDutySessionCall(
              uid: uid,
              sessionId: sid,
              generation: gen,
              lifecycleSeq: seq,
            );
            if (!ownsOperation()) return LogoutResult.failedDutyTransition;
          } catch (_) {
            return LogoutResult.failedDutyTransition;
          }
        }
        if (captured != null) {
          try {
            if (!ownsOperation()) return LogoutResult.failedDutyTransition;
            await NativeOwnershipCoordinator.withCleanupAcquisition(
              acquisition,
              () => locService.stopForegroundService(
                expectedUid: captured.uid,
                expectedSessionId: captured.sessionId,
                expectedGeneration: captured.generation,
                expectedLifecycleSeq: captured.lifecycleSeq,
              ),
            );
            if (!ownsOperation()) return LogoutResult.failedDutyTransition;
          } catch (_) {
            return LogoutResult.failedDutyTransition;
          }
        }

        // A successful stop call is not proof that native authority is gone.
        try {
          final stillRunning = await locService.isForegroundServiceRunning();
          if (!ownsOperation() || stillRunning) {
            return LogoutResult.failedDutyTransition;
          }
          final remainingOwner = await locService.getDurableOwnerRecord();
          if (!ownsOperation() || remainingOwner != null) {
            return LogoutResult.failedDutyTransition;
          }
          final remainingSession = await locService.getDurableSession();
          if (!ownsOperation() || remainingSession != null) {
            return LogoutResult.failedDutyTransition;
          }
          if (await locService.getDurableOwnerRecord() != null ||
              !ownsOperation() ||
              await locService.isForegroundServiceRunning() ||
              !ownsOperation()) {
            return LogoutResult.failedDutyTransition;
          }
        } catch (_) {
          return LogoutResult.failedDutyTransition;
        }
      }

      // An auth switch while cleanup was in flight must not sign out the new user.
      if (!ownsOperation()) {
        return LogoutResult.failedDutyTransition;
      }

      // Gate Group B (F05): Revalidate lease fence across controller notification.
      if (barrierLease != null &&
          (controller == null || !controller.isLogoutBarrierActive(barrierLease))) {
        return LogoutResult.failedDutyTransition;
      }

      bool canMutateController() {
        if (!ownsOperation()) return false;
        if (authService.currentUser?.uid != uid) return false;
        if (barrierLease != null &&
            (controller == null || !controller.isLogoutBarrierActive(barrierLease))) {
          return false;
        }
        return true;
      }

      void failTransition() {
        if (canMutateController()) {
          controller?.markReconciliationFailedOnLogoutFailure(barrierLease);
        }
      }

      bool isAcquisitionFresh() {
        if (NativeOwnershipCoordinator.hasStartInFlight) return false;
        if (acquisition == null) return true;
        final currentEpoch = NativeOwnershipCoordinator.currentEpoch;
        if (currentEpoch == 0) return true;
        return currentEpoch == acquisition.epoch;
      }

      try {
        if (await locService.isForegroundServiceRunning() ||
            await locService.getDurableOwnerRecord() != null) {
          failTransition();
          return LogoutResult.failedDutyTransition;
        }
      } catch (_) {
        failTransition();
        return LogoutResult.failedDutyTransition;
      }

      if (!isAcquisitionFresh()) {
        failTransition();
        return LogoutResult.failedDutyTransition;
      }

      // Gate Group C (F06/F07): Revalidate native acquisition freshness across all final reads.
      if (acquisition != null && provider != null) {
        if (!await provider.validateCleanupAcquisition(acquisition)) {
          failTransition();
          return LogoutResult.failedDutyTransition;
        }
        try {
          if (await locService.isForegroundServiceRunning() ||
              await locService.getDurableOwnerRecord() != null) {
            failTransition();
            return LogoutResult.failedDutyTransition;
          }
        } catch (_) {
          failTransition();
          return LogoutResult.failedDutyTransition;
        }
        if (!isAcquisitionFresh() ||
            !await provider.validateCleanupAcquisition(acquisition)) {
          failTransition();
          return LogoutResult.failedDutyTransition;
        }
        try {
          if (await locService.isForegroundServiceRunning() ||
              await locService.getDurableOwnerRecord() != null) {
            failTransition();
            return LogoutResult.failedDutyTransition;
          }
        } catch (_) {
          failTransition();
          return LogoutResult.failedDutyTransition;
        }
        if (!isAcquisitionFresh() ||
            !await provider.validateCleanupAcquisition(acquisition)) {
          failTransition();
          return LogoutResult.failedDutyTransition;
        }
      }

      // Final live native finalization proof: prove current native absence directly
      // at the publication boundary so held START replies cannot authorize signOut.
      if (acquisition != null && provider != null) {
        if (!await provider.validateCleanupAcquisition(acquisition)) {
          failTransition();
          return LogoutResult.failedDutyTransition;
        }
      }
      try {
        if (await locService.isForegroundServiceRunning() ||
            await locService.getDurableOwnerRecord() != null) {
          failTransition();
          return LogoutResult.failedDutyTransition;
        }
      } catch (_) {
        failTransition();
        return LogoutResult.failedDutyTransition;
      }

      if (NativeOwnershipCoordinator.hasStartInFlight) {
        failTransition();
        return LogoutResult.failedDutyTransition;
      }

      // Final pre-signout synchronization barrier: zero awaits between these checks and signOut()
      if (!ownsOperation()) return LogoutResult.failedDutyTransition;
      if (barrierLease != null &&
          (controller == null || !controller.isLogoutBarrierActive(barrierLease))) {
        return LogoutResult.failedDutyTransition;
      }
      final currentUid = authService.currentUser?.uid;
      if (currentUid == null || currentUid != uid) {
        failTransition();
        return LogoutResult.failedDutyTransition;
      }
      if (!isAcquisitionFresh()) {
        failTransition();
        return LogoutResult.failedDutyTransition;
      }

      // Clear owned local authority
      if (canMutateController()) {
        dutyController?.clearOwnedAuthority(barrierLease);
      }

      // Recheck ownership and active barrier lease across synchronous clearOwnedAuthority notification:
      // An installed successor lease must not be signed out by a superseded logout operation.
      if (!ownsOperation()) return LogoutResult.failedDutyTransition;
      if (barrierLease != null &&
          (controller == null || !controller.isLogoutBarrierActive(barrierLease))) {
        return LogoutResult.failedDutyTransition;
      }
      final currentUidPostClear = authService.currentUser?.uid;
      if (currentUidPostClear == null || currentUidPostClear != uid) {
        failTransition();
        return LogoutResult.failedDutyTransition;
      }
      if (!isAcquisitionFresh()) {
        failTransition();
        return LogoutResult.failedDutyTransition;
      }

      // Final step: Auth sign-out
      await authService.signOut();
      return LogoutResult.success;
    } finally {
      if (acquisition != null) {
        try {
          await provider!.releaseCleanupAcquisition(acquisition);
        } catch (_) {
          // Release cannot grant sign-out authority or release another token.
        }
      }
      if (barrierLease != null) controller!.endLogoutBarrier(barrierLease);
    }
  }
}
