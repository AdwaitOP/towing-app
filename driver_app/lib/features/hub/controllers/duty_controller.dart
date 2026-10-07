import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../../../core/models/driver_profile.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/location_service.dart';
import '../../../core/services/native_ownership_coordinator.dart';
import '../models/duty_session.dart';
import '../models/duty_state.dart';
import '../models/hub_error_category.dart';

/// Typed error model for duty controller operations.
/// Preserves the original typed startup error code, message, and details,
/// and separately records any compensating cleanup failure without overwriting
/// the primary failure. Tracks whether residual state requires cleanup.
class DutyControllerError {
  final String code;
  final String message;
  final dynamic details;

  final String? startupErrorCode;
  final String? startupErrorMessage;
  final dynamic startupErrorDetails;

  final String? cleanupErrorCode;
  final String? cleanupErrorMessage;
  final dynamic cleanupDetails;

  final String? cancellationErrorCode;
  final String? cancellationErrorMessage;
  final dynamic cancellationErrorDetails;

  final bool isCancellationPending;
  final bool cleanupRequired;

  const DutyControllerError({
    required this.code,
    required this.message,
    this.details,
    this.startupErrorCode,
    this.startupErrorMessage,
    this.startupErrorDetails,
    this.cleanupErrorCode,
    this.cleanupErrorMessage,
    this.cleanupDetails,
    this.cancellationErrorCode,
    this.cancellationErrorMessage,
    this.cancellationErrorDetails,
    this.isCancellationPending = false,
    this.cleanupRequired = false,
  });

  @override
  String toString() =>
      'DutyControllerError(code: $code, message: $message, startupError: $startupErrorCode, cleanupError: $cleanupErrorCode, cancellationError: $cancellationErrorCode, cleanupRequired: $cleanupRequired)';
}

/// Retains immutable authority and error details for an unresolved activation cancellation.
class PendingActivationCancellation {
  final String uid;
  final String sessionId;
  final int? generation;
  final int? lifecycleSeq;
  final int? attemptSeq;
  final String? errorCode;
  final String? errorMessage;
  final dynamic errorDetails;

  const PendingActivationCancellation({
    required this.uid,
    required this.sessionId,
    this.generation,
    this.lifecycleSeq,
    this.attemptSeq,
    this.errorCode,
    this.errorMessage,
    this.errorDetails,
  });
}

/// Local controller async intent distinguishing serialized duty lifecycle actions.
enum ControllerIntent { idle, reconcile, goOn, goOff, logoutBarrier }

/// Monotonic local controller operation authority token fencing async continuations.
class ControllerOperationToken {
  final int id;
  final ControllerIntent intent;
  final String uid;

  const ControllerOperationToken({
    required this.id,
    required this.intent,
    required this.uid,
  });

  @override
  String toString() => 'Token(#$id, $intent, $uid)';
}

/// Exact compensation facts. No controller presentation or replacement authority.
class CompensationOutcome {
  final ControllerOperationToken source;
  final DutySession? session;
  final PendingActivationCancellation? cancellationAuthority;
  PendingActivationCancellation? get cancellation =>
      this['cancelCode'] == null ? null : cancellationAuthority;
  final bool serverEnded;
  final bool stopSucceeded;
  final bool nativeAbsenceProven;
  final bool serverDebt;
  final int proofEpoch;
  bool get cancellationSucceeded =>
      cancellationAuthority != null && this['cancelCode'] == null;
  final Map<String, dynamic> _errors;

  CompensationOutcome({
    required this.source,
    required this.session,
    required this.cancellationAuthority,
    required this.serverEnded,
    required this.stopSucceeded,
    required this.nativeAbsenceProven,
    this.serverDebt = false,
    this.proofEpoch = 0,
    required Map<String, dynamic> errors,
  }) : _errors = Map.unmodifiable(errors);

  Map<String, dynamic> get errors => _errors;
  dynamic operator [](String key) => _errors[key];
  bool get unresolved =>
      serverDebt ||
      this['cleanCode'] != null ||
      this['cancelCode'] != null;
}

/// Identity of one logout barrier lifetime on a controller.
class LogoutBarrierLease {
  final String uid;
  final int operationId;

  final ControllerOperationToken predecessor;
  final DutySession? predecessorSession;
  final int generation;

  const LogoutBarrierLease._(
    this.uid,
    this.operationId,
    this.predecessor,
    this.predecessorSession,
    this.generation,
  );
}

/// Controller managing the transactional ON/OFF duty lifecycle,
/// explicit DutySession ownership, single-queue serialization,
/// fail-closed reconciliation, and race condition prevention.
class DutyController extends ChangeNotifier {
  final LocationService locationService;
  final AuthService authService;
  final DateTime Function() clock;

  AuthoritativeDutyState _authoritativeDutyState =
      AuthoritativeDutyState.unknown;
  DesiredDutyState _desiredDutyState = DesiredDutyState.off;
  TrackingHealth _trackingHealth = TrackingHealth.off;
  DutySession? _activeSession;
  int? _activeLifecycleSeq;
  DutySession? _pendingCleanupSession;
  DutySession? _pendingServerDebtSession;
  PendingActivationCancellation? _pendingCancellation;

  bool _isLoading = false;
  bool _isReconciling = false;
  bool _isLogoutInProgress = false;
  LogoutBarrierLease? _logoutBarrierOwner;
  bool _residualCleanupRequired = false;
  bool _isDisposed = false;
  HubErrorCategory? _errorCategory;
  DutyControllerError? _lastError;
  String? _staleStartCleanupError;
  String? get staleStartCleanupError => _staleStartCleanupError;
  String? _errorClearedForUid;
  bool _hasDisclosed = false;
  int _generation = 0;
  int? _lastConfirmedOffGeneration;
  int _opTokenCounter = 0;
  ControllerOperationToken _winningToken = const ControllerOperationToken(
    id: 0,
    intent: ControllerIntent.idle,
    uid: '',
  );
  int _retryAttemptCounter = 0;

  // Deferred facts stay UID-scoped until a legitimate cleanup owner accepts them.
  final List<CompensationOutcome> _deferredCompensation = [];
  List<CompensationOutcome> get deferredCompensation =>
      List.unmodifiable(_deferredCompensation);

  @visibleForTesting
  Future<void> Function()? beforeCompensationHandoff;

  StreamSubscription? _authSubscription;
  String? _boundUid;
  DriverProfile? _currentProfile;

  String? _cachedNotificationTitle;
  String? _cachedNotificationText;
  String? _cachedLocale;

  Future<void> _transitionQueue = Future.value();

  String? get _currentAuthUid {
    try {
      final cur = authService.currentUser?.uid;
      if (cur != null) {
        _boundUid = cur;
        return cur;
      }
      return _boundUid;
    } catch (_) {
      return _boundUid;
    }
  }

  String? get boundUid => _boundUid;
  int? get activeLifecycleSeq =>
      _activeLifecycleSeq ?? _activeSession?.lifecycleSeq;

  bool _isTokenActive(ControllerOperationToken token) {
    if (_isDisposed) return false;
    if (_isLogoutInProgress && token.intent != ControllerIntent.logoutBarrier) {
      return false;
    }
    if (_winningToken.id != token.id) return false;
    if (_winningToken.intent != token.intent) return false;
    final curUid = _currentAuthUid;
    if (curUid != null && token.uid.isNotEmpty && curUid != token.uid) {
      return false;
    }
    return true;
  }

  DutyController({
    required this.locationService,
    required this.authService,
    DateTime Function()? clock,
  }) : clock = clock ?? DateTime.now {
    _boundUid = _currentAuthUid;
    _winningToken = ControllerOperationToken(
      id: 0,
      intent: ControllerIntent.idle,
      uid: _boundUid ?? '',
    );
    try {
      _authSubscription = authService.authStateChanges.listen((user) {
        if (user == null || user.uid != _boundUid) {
          final wasOnDuty =
              _authoritativeDutyState == AuthoritativeDutyState.onDuty ||
              _currentProfile?.isOnDuty == true;
          _boundUid = user?.uid;
          _winningToken = ControllerOperationToken(
            id: ++_opTokenCounter,
            intent: ControllerIntent.idle,
            uid: _boundUid ?? '',
          );
          _generation++;
          _desiredDutyState = DesiredDutyState.off;
          _isLoading = false;
          _isReconciling = false;
          if (_activeSession != null) {
            locationService.stopForegroundService(
              expectedUid: _activeSession!.uid,
              expectedSessionId: _activeSession!.sessionId,
              expectedGeneration: _activeSession!.generation,
              expectedLifecycleSeq:
                  _activeSession!.lifecycleSeq ?? _activeLifecycleSeq,
            ).catchError((_) {});
            _activeSession = null;
            _activeLifecycleSeq = null;
          }
          if (wasOnDuty) {
            _authoritativeDutyState = AuthoritativeDutyState.unknown;
            _trackingHealth = TrackingHealth.degraded;
            _errorCategory = HubErrorCategory.dutyUpdateFailed;
          } else {
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.off;
          }
          _safeNotifyListeners();
        }
      }, onError: (_) {});
    } catch (_) {
      // Graceful fallback in headless tests without Firebase initialization
    }
  }

  AuthoritativeDutyState get authoritativeDutyState => _authoritativeDutyState;
  DesiredDutyState get desiredDutyState => _desiredDutyState;
  TrackingHealth get trackingHealth => _trackingHealth;
  DutySession? get activeSession => _activeSession;
  bool get isLoading => _isLoading;
  HubErrorCategory? get errorCategory => _errorCategory;
  bool get hasDisclosed => _hasDisclosed;
  DriverProfile? get currentProfile => _currentProfile;
  String? get cachedLocale => _cachedLocale;
  DutyControllerError? get lastError {
    if (_lastError != null) {
      if (_pendingCancellation != null &&
          _lastError!.cancellationErrorCode == null) {
        return DutyControllerError(
          code: _lastError!.code,
          message: _lastError!.message,
          details: _lastError!.details,
          startupErrorCode: _lastError!.startupErrorCode,
          startupErrorMessage: _lastError!.startupErrorMessage,
          startupErrorDetails: _lastError!.startupErrorDetails,
          cleanupErrorCode: _lastError!.cleanupErrorCode,
          cleanupErrorMessage: _lastError!.cleanupErrorMessage,
          cleanupDetails: _lastError!.cleanupDetails,
          cancellationErrorCode: _pendingCancellation!.errorCode,
          cancellationErrorMessage: _pendingCancellation!.errorMessage,
          cancellationErrorDetails: _pendingCancellation!.errorDetails,
          isCancellationPending: true,
          cleanupRequired: true,
        );
      }
      return _lastError;
    }
    if (_pendingCancellation != null) {
      return DutyControllerError(
        code: _pendingCancellation!.errorCode ?? 'ACTIVATION_CANCEL_FAILED',
        message:
            _pendingCancellation!.errorMessage ??
            'Activation cancellation pending',
        details: _pendingCancellation!.errorDetails,
        cancellationErrorCode: _pendingCancellation!.errorCode,
        cancellationErrorMessage: _pendingCancellation!.errorMessage,
        cancellationErrorDetails: _pendingCancellation!.errorDetails,
        isCancellationPending: true,
        cleanupRequired: true,
      );
    }
    return null;
  }

  String? get lastErrorCode => lastError?.code;
  String? get lastErrorMessage => lastError?.message;
  dynamic get lastErrorDetails => lastError?.details;
  String? get startupErrorCode => _lastError?.startupErrorCode;
  String? get startupErrorMessage => _lastError?.startupErrorMessage;
  dynamic get startupErrorDetails => _lastError?.startupErrorDetails;
  String? get cleanupErrorCode => _lastError?.cleanupErrorCode;
  String? get cleanupErrorMessage => _lastError?.cleanupErrorMessage;
  dynamic get cleanupDetails => _lastError?.cleanupDetails;
  String? get cancellationErrorCode =>
      _pendingCancellation?.errorCode ?? _lastError?.cancellationErrorCode;
  String? get cancellationErrorMessage =>
      _pendingCancellation?.errorMessage ??
      _lastError?.cancellationErrorMessage;
  dynamic get cancellationErrorDetails =>
      _pendingCancellation?.errorDetails ??
      _lastError?.cancellationErrorDetails;
  bool get isCancellationPending =>
      _pendingCancellation != null ||
      (_lastError?.isCancellationPending ?? false);
  bool get isCleanupRequired =>
      _residualCleanupRequired ||
      _pendingCancellation != null ||
      _pendingCleanupSession != null ||
      _pendingServerDebtSession != null ||
      (_lastError?.cleanupRequired ?? false);
  DutySession? get pendingCleanupSession => _pendingCleanupSession;
  DutySession? get pendingServerDebtSession => _pendingServerDebtSession;
  String? get pendingCancelSessionId => _pendingCancellation?.sessionId;
  String? get pendingCancelUid => _pendingCancellation?.uid;
  PendingActivationCancellation? get pendingCancellation =>
      _pendingCancellation;

  bool get isOnDuty => _authoritativeDutyState == AuthoritativeDutyState.onDuty;
  bool get isHealthyOnDuty =>
      _authoritativeDutyState == AuthoritativeDutyState.onDuty &&
      (_trackingHealth == TrackingHealth.healthy ||
          _trackingHealth == TrackingHealth.starting);
  bool get isReady {
    if (_authoritativeDutyState != AuthoritativeDutyState.onDuty) return false;
    if (_trackingHealth != TrackingHealth.healthy) return false;
    final profile = _currentProfile;
    if (profile == null) return false;
    final curUid = _currentAuthUid;
    if (curUid != null && profile.uid != curUid) return false;
    if (profile.isOnDuty != true) return false;
    if (profile.workerReady != true) return false;

    final session = _activeSession;
    if (session == null) return false;

    if (profile.uid != session.uid) return false;
    if (profile.activeDutySessionId != session.sessionId) return false;
    if (profile.dutyGeneration != session.generation) return false;
    final activeSeq = session.lifecycleSeq ?? _activeLifecycleSeq;
    if (activeSeq == null ||
        profile.lifecycleSeq == null ||
        profile.lifecycleSeq != activeSeq) {
      return false;
    }
    return true;
  }

  bool get isReconciling => _isReconciling;
  bool get isLogoutInProgress => _isLogoutInProgress;

  LogoutBarrierLease beginLogoutBarrier(String uid) {
    final lease = LogoutBarrierLease._(
      uid,
      ++_opTokenCounter,
      _winningToken,
      _activeSession,
      _generation + 1,
    );
    _logoutBarrierOwner = lease;
    _isLogoutInProgress = true;
    _winningToken = ControllerOperationToken(
      id: lease.operationId,
      intent: ControllerIntent.logoutBarrier,
      uid: uid,
    );
    _isReconciling = false;
    _desiredDutyState = DesiredDutyState.off;
    _generation++;
    _safeNotifyListeners();
    return lease;
  }

  void endLogoutBarrier(LogoutBarrierLease lease) {
    if (!identical(_logoutBarrierOwner, lease)) return;
    _logoutBarrierOwner = null;
    _isLogoutInProgress = false;
    if (_winningToken.intent == ControllerIntent.logoutBarrier &&
        _winningToken.id == lease.operationId) {
      _winningToken = ControllerOperationToken(
        id: ++_opTokenCounter,
        intent: ControllerIntent.idle,
        uid: _currentAuthUid ?? '',
      );
    }
    _safeNotifyListeners();
  }

  bool isLogoutBarrierActive(LogoutBarrierLease lease) =>
      identical(_logoutBarrierOwner, lease) &&
      _boundUid == lease.uid &&
      _currentAuthUid == lease.uid;

  void markReconciliationFailedOnLogoutFailure([LogoutBarrierLease? lease]) {
    if (lease != null && !isLogoutBarrierActive(lease)) return;
    if (_logoutBarrierOwner != null && lease == null) return;
    if (lease != null && (_currentAuthUid != lease.uid || _boundUid != lease.uid)) return;
    _authoritativeDutyState = AuthoritativeDutyState.unknown;
    _trackingHealth = TrackingHealth.reconciliationFailed;
    _errorCategory = HubErrorCategory.dutyUpdateFailed;
    _safeNotifyListeners();
  }

  void clearOwnedAuthority([LogoutBarrierLease? lease]) {
    if (lease != null && !isLogoutBarrierActive(lease)) return;
    if (_logoutBarrierOwner != null && lease == null) return;
    if (lease != null && (_currentAuthUid != lease.uid || _boundUid != lease.uid)) return;
    _retryAttemptCounter++;
    _residualCleanupRequired = false;
    _activeSession = null;
    _activeLifecycleSeq = null;
    _pendingCleanupSession = null;
    _pendingServerDebtSession = null;
    _pendingCancellation = null;
    _authoritativeDutyState = AuthoritativeDutyState.offDuty;
    _trackingHealth = TrackingHealth.off;
    _safeNotifyListeners();
  }

  bool get canToggleDuty {
    if (_isLoading) return false;
    if (isReconciling) return false;
    if (isLogoutInProgress) return false;
    if (isCleanupRequired) return false;
    if (authoritativeDutyState == AuthoritativeDutyState.unknown) return false;
    if (trackingHealth == TrackingHealth.reconciliationFailed) return false;
    final profile = _currentProfile;
    if (profile != null) {
      if (!profile.isApproved) return false;
      if (profile.isTemporarilyBannedAt(clock())) return false;
    }
    return true;
  }

  void _safeNotifyListeners() {
    if (!_isDisposed) {
      notifyListeners();
    }
  }

  void clearError() {
    _errorCategory = null;
    _lastError = null;
    _staleStartCleanupError = null;
    _errorClearedForUid = _currentAuthUid;
    _safeNotifyListeners();
  }

  /// Single entry point for live profile synchronization.
  /// Does not overwrite state with stale caller arguments.
  void updateProfile(DriverProfile profile) {
    if (_isLogoutInProgress) {
      return;
    }

    // Fencing rule 3: Profile for another UID cannot mutate current controller (E-PROFILE-3, E-UID)
    final currentUid = _currentAuthUid;
    if (currentUid != null && profile.uid != currentUid) return;

    // Fencing rule 1: If current confirmed state is OFF, late ON snapshot at an older/equal generation must not restore ON (E-PROFILE-1)
    if (_authoritativeDutyState == AuthoritativeDutyState.offDuty &&
        profile.isOnDuty) {
      final lastOffGen =
          _lastConfirmedOffGeneration ?? _activeSession?.generation;
      if (profile.dutyGeneration != null &&
          lastOffGen != null &&
          profile.dutyGeneration! <= lastOffGen) {
        return;
      }
    }

    final prev = _currentProfile;

    // Stale snapshot rejection (Gate M4-E):
    // If active session exists and profile carries a lower generation, reject it.
    if (_activeSession != null &&
        profile.dutyGeneration != null &&
        profile.dutyGeneration! < _activeSession!.generation) {
      return;
    }

    _currentProfile = profile;

    // A profile callback is cached context, not a fresh reconciliation read.
    // Once authority is unresolved it cannot authorize a stop or heal OFF/READY.
    if (_trackingHealth == TrackingHealth.reconciliationFailed) {
      _safeNotifyListeners();
      return;
    }

    // Invalidate pending ON transition if verification downgraded
    if (prev != null && prev.isApproved && !profile.isApproved) {
      _generation++;
      _desiredDutyState = DesiredDutyState.off;
      if (_activeSession != null) {
        locationService.stopForegroundService(
          expectedUid: _activeSession!.uid,
          expectedSessionId: _activeSession!.sessionId,
          expectedGeneration: _activeSession!.generation,
          expectedLifecycleSeq:
              _activeSession!.lifecycleSeq ?? _activeLifecycleSeq,
        );
        _activeSession = null;
        _activeLifecycleSeq = null;
      }
      _isLoading = false;
      if (profile.isOnDuty) {
        _authoritativeDutyState = AuthoritativeDutyState.onDuty;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _errorCategory = HubErrorCategory.reconciliationFailed;
      } else {
        _trackingHealth = TrackingHealth.off;
      }
    }

    // Invalidate pending OFF transition if active job arrived
    if (prev != null && !prev.hasActiveJob && profile.hasActiveJob) {
      if (_desiredDutyState == DesiredDutyState.off && _isLoading) {
        _generation++;
        _isLoading = false;
        _errorCategory = HubErrorCategory.activeJobPreventOffDuty;
      }
    }

    // Invalidate pending OFF transition if active offer arrived (Gate M4-F)
    if (prev != null && !prev.hasActiveOffer && profile.hasActiveOffer) {
      if (_desiredDutyState == DesiredDutyState.off && _isLoading) {
        _generation++;
        _isLoading = false;
        _errorCategory = HubErrorCategory.activeOfferPreventOffDuty;
      }
    }

    if (profile.isOnDuty) {
      if (_trackingHealth == TrackingHealth.reconciliationFailed ||
          _authoritativeDutyState == AuthoritativeDutyState.unknown) {
        // Rule 2: updateProfile MUST NOT promote unknown or reconciliationFailed
        // authority merely because incoming profile says isOnDuty=true, workerReady=true.
        _safeNotifyListeners();
        return;
      }

      _authoritativeDutyState = AuthoritativeDutyState.onDuty;
      final session = _activeSession;
      if (session == null) {
        // Native authority is unconfirmed (Rule 1 & Rule 2).
        // Profile alone must NEVER manufacture confirmed native authority or promote to healthy/READY.
        _trackingHealth = TrackingHealth.starting;
      } else {
        final activeSeq = session.lifecycleSeq ?? _activeLifecycleSeq;
        final bool isExactMatch =
            profile.uid == session.uid &&
            profile.activeDutySessionId == session.sessionId &&
            profile.dutyGeneration == session.generation &&
            activeSeq != null &&
            profile.lifecycleSeq != null &&
            profile.lifecycleSeq == activeSeq;

        if (isExactMatch) {
          if (profile.workerReady == true) {
            _trackingHealth = TrackingHealth.healthy;
          } else {
            _trackingHealth = TrackingHealth.starting;
          }
        } else {
          // Epoch mismatch between confirmed native worker and incoming profile (Rule 4)
          // Cannot promote to healthy.
          if (_trackingHealth == TrackingHealth.healthy) {
            _trackingHealth = TrackingHealth.starting;
          }
        }
      }
    } else {
      _authoritativeDutyState = AuthoritativeDutyState.offDuty;
      _activeSession = null;
      _activeLifecycleSeq = null;
      if (_trackingHealth != TrackingHealth.reconciliationFailed) {
        _trackingHealth = TrackingHealth.off;
      }
    }

    _safeNotifyListeners();
  }

  /// Coordinates app sign-out with DutyController before Firebase auth disposal.
  /// Returns false if compensating OFF transaction fails, blocking sign-out.
  Future<bool> prepareForSignOut({
    DriverProfile? freshProfile,
    LogoutBarrierLease? logoutLease,
  }) async {
    bool ownsLogout() =>
        logoutLease == null ||
        (identical(_logoutBarrierOwner, logoutLease) &&
            _currentAuthUid == logoutLease.uid);
    // Wait for any in-flight duty transaction to settle
    await _transitionQueue;
    if (!ownsLogout()) return false;

    final logoutProfile = freshProfile ?? _currentProfile;

    // Guard against active job and active offer (Gate M4-F)
    if (logoutProfile?.hasActiveJob == true) {
      _errorCategory = HubErrorCategory.activeJobPreventOffDuty;
      _safeNotifyListeners();
      return false;
    }
    if (logoutProfile?.hasActiveOffer == true) {
      _errorCategory = HubErrorCategory.activeOfferPreventOffDuty;
      _safeNotifyListeners();
      return false;
    }

    final uid = _currentAuthUid;
    final isOnDuty =
        freshProfile?.isOnDuty ??
        (_authoritativeDutyState == AuthoritativeDutyState.onDuty ||
            _currentProfile?.isOnDuty == true);

    // Query durable owner with error handling
    DurableDutyOwnerRecord? durableOwner;
    try {
      durableOwner = await locationService.getDurableOwnerRecord();
      if (!ownsLogout()) return false;
    } catch (e) {
      if (!ownsLogout()) return false;
      _authoritativeDutyState = AuthoritativeDutyState.unknown;
      _trackingHealth = TrackingHealth.reconciliationFailed;
      _errorCategory = HubErrorCategory.dutyUpdateFailed;
      _lastError = DutyControllerError(
        code: 'DURABLE_OWNER_READ_FAILED',
        message: e.toString(),
        cleanupRequired: true,
      );
      _safeNotifyListeners();
      return false;
    }

    DutySession? durableSession;
    try {
      durableSession = await locationService.getDurableSession();
      if (!ownsLogout()) return false;
    } catch (_) {
      if (!ownsLogout()) return false;
      _authoritativeDutyState = AuthoritativeDutyState.unknown;
      _trackingHealth = TrackingHealth.reconciliationFailed;
      _errorCategory = HubErrorCategory.dutyUpdateFailed;
      _safeNotifyListeners();
      return false;
    }

    final targetSessionId =
        _activeSession?.sessionId ??
        durableOwner?.sessionId ??
        durableSession?.sessionId ??
        logoutProfile?.activeDutySessionId;
    final targetGen =
        _activeSession?.generation ??
        durableOwner?.generation ??
        durableSession?.generation ??
        logoutProfile?.dutyGeneration;
    final targetSeq =
        _activeSession?.lifecycleSeq ??
        _activeLifecycleSeq ??
        durableOwner?.lifecycleSeq ??
        durableSession?.lifecycleSeq ??
        locationService.currentLifecycleSeq ??
        logoutProfile?.lifecycleSeq;

    if (isOnDuty) {
      if (uid == null || (logoutProfile != null && uid != logoutProfile.uid)) {
        _authoritativeDutyState = AuthoritativeDutyState.unknown;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _errorCategory = HubErrorCategory.dutyUpdateFailed;
        _safeNotifyListeners();
        return false;
      }
      if (targetSessionId == null || targetGen == null) {
        _authoritativeDutyState = AuthoritativeDutyState.onDuty;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _errorCategory = HubErrorCategory.dutyUpdateFailed;
        _safeNotifyListeners();
        return false;
      }
      try {
        await locationService.endDutySessionCall(
          uid: uid,
          sessionId: targetSessionId,
          generation: targetGen,
          lifecycleSeq: targetSeq,
        );
        if (!ownsLogout()) return false;
        _authoritativeDutyState = AuthoritativeDutyState.offDuty;
        _lastConfirmedOffGeneration = targetGen;
      } catch (e) {
        if (!ownsLogout()) return false;
        _authoritativeDutyState = AuthoritativeDutyState.onDuty;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _errorCategory = HubErrorCategory.dutyUpdateFailed;
        _safeNotifyListeners();
        return false;
      }
    }

    _desiredDutyState = DesiredDutyState.off;
    _generation++;

    bool isNativeRunning = false;
    try {
      isNativeRunning = await locationService.isForegroundServiceRunning();
      if (!ownsLogout()) return false;
    } catch (_) {
      if (!ownsLogout()) return false;
      _authoritativeDutyState = AuthoritativeDutyState.unknown;
      _trackingHealth = TrackingHealth.reconciliationFailed;
      _errorCategory = HubErrorCategory.dutyUpdateFailed;
      _safeNotifyListeners();
      return false;
    }

    if (_activeSession != null ||
        durableOwner != null ||
        durableSession != null ||
        isNativeRunning) {
      final stopUid =
          _activeSession?.uid ??
          durableOwner?.uid ??
          durableSession?.uid ??
          uid ??
          '';
      final stopSid =
          targetSessionId ??
          _activeSession?.sessionId ??
          durableOwner?.sessionId ??
          durableSession?.sessionId ??
          '';
      try {
        await locationService.stopForegroundService(
          expectedUid: stopUid,
          expectedSessionId: stopSid,
          expectedGeneration: targetGen,
          expectedLifecycleSeq: targetSeq,
        );
        if (!ownsLogout()) return false;
        _activeSession = null;
        _activeLifecycleSeq = null;
      } catch (e) {
        if (!ownsLogout()) return false;
        _pendingCleanupSession =
            _activeSession ??
            (stopSid.isNotEmpty
                ? DutySession(
                    uid: stopUid,
                    sessionId: stopSid,
                    generation: targetGen ?? 1,
                    lifecycleSeq: targetSeq,
                  )
                : null);
        _activeSession = null;
        _activeLifecycleSeq = null;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _errorCategory = HubErrorCategory.dutyUpdateFailed;
        _lastError = DutyControllerError(
          code: 'NATIVE_STOP_FAILED',
          message: e.toString(),
          cleanupRequired: true,
        );
        _safeNotifyListeners();
        return false;
      }
    }

    // Stop completion alone does not establish that native authority is absent.
    try {
      if (await locationService.isForegroundServiceRunning() ||
          await locationService.getDurableOwnerRecord() != null ||
          await locationService.getDurableSession() != null) {
        if (!ownsLogout()) return false;
        _authoritativeDutyState = AuthoritativeDutyState.unknown;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _errorCategory = HubErrorCategory.dutyUpdateFailed;
        _safeNotifyListeners();
        return false;
      }
    } catch (_) {
      if (!ownsLogout()) return false;
      _authoritativeDutyState = AuthoritativeDutyState.unknown;
      _trackingHealth = TrackingHealth.reconciliationFailed;
      _errorCategory = HubErrorCategory.dutyUpdateFailed;
      _safeNotifyListeners();
      return false;
    }

    if (!ownsLogout()) return false;

    // Gate Group C (F06): Re-verify native absence freshness before finalizing clean OFF.
    // Intervening native START must not hide behind an earlier pre-replacement read.
    try {
      final proofEpoch = NativeOwnershipCoordinator.currentEpoch;
      final finalOwner = await locationService.getDurableOwnerRecord();
      final stillRunning = await locationService.isForegroundServiceRunning();
      if (finalOwner != null || stillRunning) {
        if (ownsLogout()) {
          _authoritativeDutyState = AuthoritativeDutyState.unknown;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _errorCategory = HubErrorCategory.dutyUpdateFailed;
          _safeNotifyListeners();
        }
        return false;
      }
      if (NativeOwnershipCoordinator.hasStartInFlight ||
          NativeOwnershipCoordinator.currentEpoch != proofEpoch) {
        if (ownsLogout()) {
          _authoritativeDutyState = AuthoritativeDutyState.unknown;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _errorCategory = HubErrorCategory.dutyUpdateFailed;
          _safeNotifyListeners();
        }
        return false;
      }
    } catch (_) {
      if (ownsLogout()) {
        _authoritativeDutyState = AuthoritativeDutyState.unknown;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _errorCategory = HubErrorCategory.dutyUpdateFailed;
        _safeNotifyListeners();
      }
      return false;
    }

    if (!ownsLogout()) return false;
    _trackingHealth = TrackingHealth.off;
    _authoritativeDutyState = AuthoritativeDutyState.offDuty;
    _safeNotifyListeners();
    // Gate Group B (F05): Revalidate lease fence across synchronous listener notifications.
    if (!ownsLogout()) return false;
    return true;
  }

  bool _isSessionStale(DutySession session, [int? currentLocalGen]) {
    if (_isDisposed) return true;
    if (currentLocalGen != null && _generation != currentLocalGen) return true;
    if (_activeSession == null) return true;
    if (_activeSession!.sessionId != session.sessionId) return true;
    if (_activeSession!.uid != session.uid) return true;
    if (_activeSession!.generation != session.generation) return true;
    final currentUid = _currentAuthUid;
    if (currentUid != null && currentUid != session.uid) return true;
    if (_currentProfile != null && !_currentProfile!.isApproved) return true;
    return false;
  }

  Future<T> _enqueue<T>(Future<T> Function() action) {
    final completer = Completer<T>();
    _transitionQueue = _transitionQueue
        .then((_) async {
          if (_isDisposed) {
            completer.completeError(StateError('DutyController disposed'));
            return;
          }
          try {
            final result = await action();
            completer.complete(result);
          } catch (e, st) {
            completer.completeError(e, st);
          }
        })
        .catchError((_) {});
    return completer.future;
  }

  /// Transactional startup flow to go ON DUTY.
  /// Operates on controller-owned authoritative profile.
  Future<bool> requestGoOnDuty({
    required Future<bool> Function() onShowDisclosure,
    String? notificationTitle,
    String? notificationText,
    String? locale,
  }) {
    if (_isDisposed || _isLogoutInProgress || _isLoading) {
      return Future.value(false);
    }
    if (_winningToken.intent == ControllerIntent.logoutBarrier ||
        _winningToken.intent == ControllerIntent.goOff) {
      return Future.value(false);
    }

    final currentUid = _currentAuthUid ?? _boundUid ?? _currentProfile?.uid;
    final token = ControllerOperationToken(
      id: ++_opTokenCounter,
      intent: ControllerIntent.goOn,
      uid: currentUid ?? '',
    );
    _winningToken = token;
    _desiredDutyState = DesiredDutyState.on;
    _isReconciling = false;
    _isLoading = true;
    _errorCategory = null;
    _lastError = null;
    if (notificationTitle != null) _cachedNotificationTitle = notificationTitle;
    if (notificationText != null) _cachedNotificationText = notificationText;
    if (locale != null) _cachedLocale = locale;
    _safeNotifyListeners();

    return _enqueue<bool>(() async {
      if (_isDisposed ||
          _isLogoutInProgress ||
          _currentAuthUid != token.uid ||
          _winningToken != token) {
        return false;
      }
      final currentGen = ++_generation;
      bool ownsGoOn() =>
          !_isDisposed &&
          !_isLogoutInProgress &&
          _currentAuthUid == token.uid &&
          _winningToken == token &&
          _generation == currentGen &&
          _desiredDutyState == DesiredDutyState.on;
      DutySession? capturedSession;
      int? preparedGeneration;
      String? registeredSessionId;
      int? authoritativeAttempt;
      try {
        if (!ownsGoOn()) {
          return false;
        }

        final profile = _currentProfile;

        if (profile == null ||
            currentUid == null ||
            currentUid != profile.uid ||
            !profile.isApproved) {
          _errorCategory = HubErrorCategory.notApproved;
          return false;
        }

        // Step 1: Disclosure flow before OS permissions
        if (!_hasDisclosed) {
          final agreed = await onShowDisclosure();
          if (!ownsGoOn()) {
            return false;
          }
          if (!agreed) {
            _desiredDutyState = DesiredDutyState.off;
            _trackingHealth = TrackingHealth.off;
            _activeSession = null;
            _activeLifecycleSeq = null;
            return false;
          }
          _hasDisclosed = true;
        }

        if (!ownsGoOn()) {
          return false;
        }

        // Step 2: Check location services enabled
        final serviceEnabled = await locationService.isLocationServiceEnabled();
        if (!ownsGoOn()) {
          return false;
        }
        if (!serviceEnabled) {
          _errorCategory = HubErrorCategory.servicesDisabled;
          _trackingHealth = TrackingHealth.serviceUnavailable;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return false;
        }

        // Step 3: Foreground location permission
        var fgPermission = await locationService.checkPermission();
        if (!ownsGoOn()) {
          return false;
        }
        if (fgPermission == LocationPermissionStatus.deniedForever) {
          _errorCategory = HubErrorCategory.foregroundPermissionDeniedForever;
          _trackingHealth = TrackingHealth.permissionBlocked;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return false;
        }
        if (fgPermission != LocationPermissionStatus.granted) {
          fgPermission = await locationService.requestForegroundPermission();
          if (!ownsGoOn()) {
            return false;
          }
        }

        if (fgPermission == LocationPermissionStatus.deniedForever) {
          _errorCategory = HubErrorCategory.foregroundPermissionDeniedForever;
          _trackingHealth = TrackingHealth.permissionBlocked;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return false;
        } else if (fgPermission != LocationPermissionStatus.granted) {
          _errorCategory = HubErrorCategory.foregroundPermissionDenied;
          _trackingHealth = TrackingHealth.permissionBlocked;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return false;
        }

        // Step 4: Background location permission (strictly requires LocationPermission.always)
        final bgPermission = await locationService
            .requestBackgroundPermission();
        if (!ownsGoOn()) {
          return false;
        }
        if (bgPermission == LocationPermissionStatus.deniedForever ||
            bgPermission == LocationPermissionStatus.denied) {
          _errorCategory = HubErrorCategory.backgroundPermissionDenied;
          _trackingHealth = TrackingHealth.permissionBlocked;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return false;
        }

        // Step 5: Notification permission (informational)
        await locationService.requestNotificationPermission();
        if (!ownsGoOn()) {
          return false;
        }

        // Step 6: Acquire initial GPS position
        final initialPosition = await locationService.getCurrentPosition();
        if (!ownsGoOn()) {
          return false;
        }
        if (initialPosition == null || !initialPosition.isValid) {
          _errorCategory = HubErrorCategory.locationUnavailable;
          _trackingHealth = TrackingHealth.serviceUnavailable;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return false;
        }

        // Step 7: Server-mediated activation intent preparation
        final clientReqId =
            '${profile.uid}_${clock().microsecondsSinceEpoch}_$currentGen';
        final DutyActivationPreparation prep;
        try {
          prep = await locationService.prepareDutyActivation(
            uid: profile.uid,
            clientRequestId: clientReqId,
          );
          registeredSessionId = prep.sessionId;
          preparedGeneration = prep.generation;
        } catch (_) {
          if (!ownsGoOn()) {
            return false;
          }
          _errorCategory = HubErrorCategory.dutyUpdateFailed;
          _trackingHealth = TrackingHealth.serviceUnavailable;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return false;
        }

        final authoritativeGen = prep.generation;
        authoritativeAttempt = prep.attemptSeq;

        // Gate M4-C / M4-E: Pre-native-start guard
        final bool isPreNativeValid = ownsGoOn();

        if (!isPreNativeValid) {
          if (registeredSessionId.isNotEmpty) {
            String? cancelFailCode;
            try {
              await locationService.cancelDutyActivationCall(
                uid: profile.uid,
                sessionId: registeredSessionId,
                generation: authoritativeGen,
                attemptSeq: authoritativeAttempt,
              );
            } catch (cancelErr) {
              if (cancelErr is PlatformException) {
                cancelFailCode = cancelErr.code;
              } else {
                cancelFailCode = 'ACTIVATION_CANCEL_FAILED';
              }
            }
            if (cancelFailCode != null) {
              final cancelDebt = PendingActivationCancellation(
                uid: profile.uid,
                sessionId: registeredSessionId,
                generation: authoritativeGen,
                attemptSeq: authoritativeAttempt,
                errorCode: cancelFailCode,
              );
              final debtOutcome = CompensationOutcome(
                source: token,
                session: null,
                cancellationAuthority: cancelDebt,
                serverEnded: true,
                stopSucceeded: false,
                nativeAbsenceProven: false,
                errors: {'cancelCode': cancelFailCode},
              );
              _deferredCompensation.add(debtOutcome);
            }
          }
          return false;
        }

        var session = DutySession(
          uid: profile.uid,
          sessionId: registeredSessionId,
          generation: authoritativeGen,
          notificationTitle: notificationTitle ?? _cachedNotificationTitle,
          notificationText: notificationText ?? _cachedNotificationText,
          locale: locale ?? _cachedLocale,
        );
        capturedSession = session;
        _activeSession = session;
        _trackingHealth = TrackingHealth.starting;

        if (_isLogoutInProgress ||
            _winningToken.intent == ControllerIntent.logoutBarrier) {
          final cleanupRes = await _compensateGoOn(
            ownsAttempt: ownsGoOn,
            source: token,
            generation: preparedGeneration,
            session: null,
            registeredSessionId: registeredSessionId,
            uid: profile.uid,
            attemptSeq: authoritativeAttempt,
          );
          if (!ownsGoOn()) {
            return false;
          }
          _activeSession = null;
          _activeLifecycleSeq = null;
          final cancelCode = cleanupRes['cancelCode'] as String?;
          if (cancelCode != null) {
            _lastError = _buildFailureError(
              primaryCode: cancelCode,
              primaryMsg:
                  cleanupRes['cancelMsg'] as String? ?? 'Cancellation failed',
              cancelCode: cancelCode,
              cancelMsg: cleanupRes['cancelMsg'] as String?,
              cancelDetails: cleanupRes['cancelDetails'],
            );
          }
          return false;
        }

        // Step 8: Start native foreground tracking service with durable ownership
        final started = await locationService.startForegroundService(
          session: session,
          notificationTitle: session.notificationTitle,
          notificationText: session.notificationText,
          onAuthorityAllocated: (authority) {
            // Retain this START's exact authority for stale go-on cleanup.
            session = authority;
            capturedSession = authority;
            if (ownsGoOn()) {
              _activeSession = authority;
            }
          },
        );
        final bool isCurrentAfterNativeStart = ownsGoOn();

        if (!isCurrentAfterNativeStart) {
          final cleanupRes = await _compensateGoOn(
            ownsAttempt: ownsGoOn,
            source: token,
            generation: preparedGeneration,
            session: session,
            registeredSessionId: registeredSessionId,
            uid: profile.uid,
            attemptSeq: authoritativeAttempt,
          );
          if (ownsGoOn() && _activeSession?.sessionId == session.sessionId) {
            _activeSession = null;
            _activeLifecycleSeq = null;
            final cleanCode = cleanupRes['cleanCode'] as String?;
            final cancelCode = cleanupRes['cancelCode'] as String?;
            if (cleanCode != null || cancelCode != null) {
              _lastError = _buildFailureError(
                primaryCode: cleanCode ?? cancelCode ?? 'SESSION_STALE',
                primaryMsg:
                    cleanupRes['cleanMsg'] as String? ??
                    cleanupRes['cancelMsg'] as String? ??
                    'Stale session cleanup failed',
                cleanCode: cleanCode,
                cleanMsg: cleanupRes['cleanMsg'] as String?,
                cleanDetails: cleanupRes['cleanDetails'],
                cancelCode: cancelCode,
                cancelMsg: cleanupRes['cancelMsg'] as String?,
                cancelDetails: cleanupRes['cancelDetails'],
              );
            }
          }
          return false;
        }
        if (!started) {
          final cleanupRes = await _compensateGoOn(
            ownsAttempt: ownsGoOn,
            source: token,
            generation: preparedGeneration,
            session: session,
            registeredSessionId: registeredSessionId,
            uid: profile.uid,
            attemptSeq: authoritativeAttempt,
          );
          if (ownsGoOn()) {
            _errorCategory = HubErrorCategory.serviceStartupFailed;
            _trackingHealth = TrackingHealth.serviceUnavailable;
            if (_activeSession?.sessionId == session.sessionId) {
              _activeSession = null;
              _activeLifecycleSeq = null;
            }
            _lastError = _buildFailureError(
              primaryCode: 'NATIVE_START_FAILED',
              primaryMsg: 'Foreground service failed to start',
              cleanCode: cleanupRes['cleanCode'] as String?,
              cleanMsg: cleanupRes['cleanMsg'] as String?,
              cleanDetails: cleanupRes['cleanDetails'],
              cancelCode: cleanupRes['cancelCode'] as String?,
              cancelMsg: cleanupRes['cancelMsg'] as String?,
              cancelDetails: cleanupRes['cancelDetails'],
            );
          }
          return false;
        }

        // Step 9: Authoritative startDutySession call with registered intent & initial coordinates
        // START supplied immutable authority; current native state may already
        // belong to a replacement and must not redefine this attempt.
        final nativeSeq = session.lifecycleSeq;
        if (nativeSeq == null || nativeSeq <= 0) {
          final cleanupRes = await _compensateGoOn(
            ownsAttempt: ownsGoOn,
            source: token,
            generation: preparedGeneration,
            session: session,
            registeredSessionId: registeredSessionId,
            uid: profile.uid,
            attemptSeq: authoritativeAttempt,
          );
          if (ownsGoOn()) {
            if (_activeSession?.sessionId == session.sessionId) {
              _activeSession = null;
              _activeLifecycleSeq = null;
            }
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.serviceUnavailable;
            _errorCategory = HubErrorCategory.serviceStartupFailed;
            _lastError = _buildFailureError(
              primaryCode: 'NATIVE_LIFECYCLE_SEQ_UNAVAILABLE',
              primaryMsg: 'Native lifecycle sequence was not allocated',
              cleanCode: cleanupRes['cleanCode'] as String?,
              cleanMsg: cleanupRes['cleanMsg'] as String?,
              cleanDetails: cleanupRes['cleanDetails'],
              cancelCode: cleanupRes['cancelCode'] as String?,
              cancelMsg: cleanupRes['cancelMsg'] as String?,
              cancelDetails: cleanupRes['cancelDetails'],
            );
          }
          return false;
        }

        final bool isCurrentBeforeServerStart = ownsGoOn();

        if (!isCurrentBeforeServerStart) {
          await _compensateGoOn(
            ownsAttempt: ownsGoOn,
            source: token,
            generation: preparedGeneration,
            session: session,
            registeredSessionId: registeredSessionId,
            uid: profile.uid,
            attemptSeq: authoritativeAttempt,
          );
          if (ownsGoOn() && _activeSession?.sessionId == session.sessionId) {
            _activeSession = null;
            _activeLifecycleSeq = null;
          }
          return false;
        }

        _activeLifecycleSeq = nativeSeq;
        session = DutySession(
          uid: session.uid,
          sessionId: session.sessionId,
          generation: session.generation,
          lifecycleSeq: nativeSeq,
          notificationTitle: session.notificationTitle,
          notificationText: session.notificationText,
          locale: session.locale,
        );
        _activeSession = session;

        try {
          await locationService.startDutySessionCall(
            uid: profile.uid,
            sessionId: registeredSessionId,
            initialLocation: initialPosition,
            lifecycleSeq: nativeSeq,
            generation: session.generation,
            attemptSeq: authoritativeAttempt,
          );
        } catch (callErr) {
          final cleanupRes = await _compensateGoOn(
            ownsAttempt: ownsGoOn,
            source: token,
            generation: preparedGeneration,
            session: session,
            registeredSessionId: registeredSessionId,
            uid: profile.uid,
            attemptSeq: authoritativeAttempt,
          );

          final bool isCurrentOnFailure = ownsGoOn();

          if (isCurrentOnFailure) {
            if (_activeSession?.sessionId == session.sessionId) {
              _activeSession = null;
              _activeLifecycleSeq = null;
            }
            _trackingHealth = TrackingHealth.serviceUnavailable;
            _errorCategory = HubErrorCategory.dutyUpdateFailed;

            final startupCode = (callErr is PlatformException)
                ? callErr.code
                : 'START_DUTY_SESSION_FAILED';
            final startupMsg = (callErr is PlatformException)
                ? (callErr.message ?? callErr.toString())
                : callErr.toString();
            final startupDetails = (callErr is PlatformException)
                ? callErr.details
                : null;

            _lastError = _buildFailureError(
              primaryCode: startupCode,
              primaryMsg: startupMsg,
              primaryDetails: startupDetails,
              cleanCode: cleanupRes['cleanCode'] as String?,
              cleanMsg: cleanupRes['cleanMsg'] as String?,
              cleanDetails: cleanupRes['cleanDetails'],
              cancelCode: cleanupRes['cancelCode'] as String?,
              cancelMsg: cleanupRes['cancelMsg'] as String?,
              cancelDetails: cleanupRes['cancelDetails'],
            );
          }
          return false;
        }

        // Step 10: Layer B Post-write stale check
        if (!_isTokenActive(token) ||
            _isSessionStale(_activeSession ?? session, currentGen) ||
            _desiredDutyState != DesiredDutyState.on ||
            _currentAuthUid != session.uid ||
            _winningToken.uid != session.uid) {
          var compensated = false;
          try {
            await locationService.endDutySessionCall(
              uid: session.uid,
              sessionId: session.sessionId,
              generation: session.generation,
              lifecycleSeq: session.lifecycleSeq,
            );
            compensated = true;
          } catch (_) {}

          final cleanupRes = await _compensateGoOn(
            ownsAttempt: ownsGoOn,
            source: token,
            generation: preparedGeneration,
            session: session,
            serverEnded: compensated,
            serverDebt: !compensated,
            registeredSessionId: null,
            uid: session.uid,
          );

          if (!ownsGoOn()) {
            return false;
          }
          if (_activeSession == session) {
            _activeSession = null;
            _activeLifecycleSeq = null;
          }

          final cleanCode = cleanupRes['cleanCode'] as String?;
          final cleanMsg = cleanupRes['cleanMsg'] as String?;
          final cleanDetails = cleanupRes['cleanDetails'];
          if (compensated && cleanCode == null) {
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.off;
          } else {
            _authoritativeDutyState = compensated
                ? AuthoritativeDutyState.offDuty
                : AuthoritativeDutyState.onDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _errorCategory = HubErrorCategory.dutyUpdateFailed;
            _lastError = DutyControllerError(
              code: cleanCode ?? 'SESSION_STALE',
              message: cleanMsg ?? 'Session became stale before completion',
              details: cleanDetails,
              cleanupErrorCode: cleanCode,
              cleanupErrorMessage: cleanMsg,
              cleanupDetails: cleanDetails,
              cleanupRequired: cleanCode != null || !compensated,
            );
          }
          return false;
        }

        // Step 11: Confirm local controller state ON and awaiting worker readiness.
        // Server workerReady remains FALSE until genuine background worker publishes readiness.
        if (!ownsGoOn()) {
          return false;
        }
        _authoritativeDutyState = AuthoritativeDutyState.onDuty;
        _currentProfile = profile.copyWith(
          isOnDuty: true,
          activeDutySessionId: registeredSessionId,
          dutyGeneration: session.generation,
          lifecycleSeq: session.lifecycleSeq,
        );
        final activeSeq = _activeSession?.lifecycleSeq ?? _activeLifecycleSeq;
        if (_currentProfile?.workerReady == true &&
            _currentProfile?.activeDutySessionId == registeredSessionId &&
            _currentProfile?.dutyGeneration == session.generation &&
            _currentProfile?.lifecycleSeq == activeSeq) {
          _trackingHealth = TrackingHealth.healthy;
        } else {
          _trackingHealth = TrackingHealth.starting;
        }
        return true;
      } catch (e) {
        if (ownsGoOn() ||
            capturedSession != null ||
            registeredSessionId != null) {
          final cleanupRes = await _compensateGoOn(
            ownsAttempt: ownsGoOn,
            source: token,
            generation: preparedGeneration,
            session: capturedSession,
            registeredSessionId: registeredSessionId,
            uid: token.uid,
            attemptSeq: authoritativeAttempt,
          );
          if (!ownsGoOn()) {
            return false;
          }
          _activeSession = null;
          _activeLifecycleSeq = null;
          _trackingHealth = TrackingHealth.off;

          final String primaryCode;
          final String primaryMsg;
          final dynamic primaryDetails;

          if (e is PlatformException) {
            primaryCode = e.code;
            primaryMsg = e.message ?? e.toString();
            primaryDetails = e.details;
          } else {
            primaryCode = 'STARTUP_EXCEPTION';
            primaryMsg = e.toString();
            primaryDetails = null;
          }

          _lastError = _buildFailureError(
            primaryCode: primaryCode,
            primaryMsg: primaryMsg,
            primaryDetails: primaryDetails,
            cleanCode: cleanupRes['cleanCode'] as String?,
            cleanMsg: cleanupRes['cleanMsg'] as String?,
            cleanDetails: cleanupRes['cleanDetails'],
            cancelCode: cleanupRes['cancelCode'] as String?,
            cancelMsg: cleanupRes['cancelMsg'] as String?,
            cancelDetails: cleanupRes['cancelDetails'],
          );

          if (primaryCode == 'STARTUP_TIMEOUT_CLEANUP_FAILED' ||
              primaryCode == 'STARTUP_CLEANUP_FAILED' ||
              primaryCode == 'NATIVE_START_FAILED' ||
              primaryCode.contains('STARTUP')) {
            _errorCategory = HubErrorCategory.serviceStartupFailed;
          } else {
            _errorCategory = HubErrorCategory.dutyUpdateFailed;
          }
        }
        return false;
      } finally {
        if (!_isDisposed &&
            !_isLogoutInProgress &&
            _currentAuthUid == token.uid &&
            _winningToken == token &&
            _generation == currentGen) {
          _winningToken = ControllerOperationToken(
            id: 0,
            intent: ControllerIntent.idle,
            uid: _boundUid ?? '',
          );
          _isLoading = false;
          _safeNotifyListeners();
        }
      }
    });
  }

  DutySession? sessionIfKnown(int gen) => _activeSession;

  /// Transactional shutdown flow to go OFF DUTY.
  /// Blocks transition if driver has an active job or active offer.
  /// Uses authoritative Firestore transaction.
  Future<bool> requestGoOffDuty() {
    if (_isDisposed || _isLogoutInProgress) return Future.value(false);

    final currentUid = _currentAuthUid;
    final token = ControllerOperationToken(
      id: ++_opTokenCounter,
      intent: ControllerIntent.goOff,
      uid: currentUid ?? '',
    );
    _winningToken = token;
    _desiredDutyState = DesiredDutyState.off;
    _isReconciling = false;
    _isLoading = true;
    _errorCategory = null;
    _lastError = null;
    _safeNotifyListeners();

    return _enqueue<bool>(() async {
      if (_isDisposed ||
          _isLogoutInProgress ||
          _currentAuthUid != currentUid ||
          _winningToken != token) {
        return false;
      }
      final currentGen = ++_generation;
      // Success, failure, and finalization share the original attempt's fence.
      bool ownsGoOff() =>
          !_isDisposed &&
          !_isLogoutInProgress &&
          _currentAuthUid == currentUid &&
          _winningToken == token &&
          _generation == currentGen;
      final profile = _currentProfile;
      String? targetSessionId;
      int? targetSeq;
      try {
        if (!ownsGoOff()) {
          return false;
        }

        if (profile == null ||
            currentUid == null ||
            currentUid != profile.uid) {
          return false;
        }

        // Invariant: cannot go off duty while on an active job or active offer (Gate M4-F)
        if (profile.hasActiveJob) {
          _errorCategory = HubErrorCategory.activeJobPreventOffDuty;
          return false;
        }
        if (profile.hasActiveOffer) {
          _errorCategory = HubErrorCategory.activeOfferPreventOffDuty;
          return false;
        }

        final localSession = _activeSession;
        DurableDutyOwnerRecord? durableOwner;
        if (localSession == null) {
          try {
            durableOwner = await locationService.getDurableOwnerRecord();
          } catch (ownerErr) {
            if (!ownsGoOff()) {
              return false;
            }
            // D4-READ-FAIL: durable owner read throws => no clean success result, cleanup visible
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _errorCategory = HubErrorCategory.dutyUpdateFailed;
            _residualCleanupRequired = true;
            _lastError = DutyControllerError(
              code: (ownerErr is PlatformException)
                  ? ownerErr.code
                  : 'DURABLE_OWNER_READ_FAILED',
              message: (ownerErr is PlatformException)
                  ? (ownerErr.message ?? ownerErr.toString())
                  : ownerErr.toString(),
              cleanupRequired: true,
            );
            return false;
          }
        }

        if (!ownsGoOff()) {
          return false;
        }

        final stopUid = localSession?.uid ?? durableOwner?.uid ?? profile.uid;
        final stopSessionId =
            localSession?.sessionId ??
            durableOwner?.sessionId ??
            profile.activeDutySessionId;

        final stopGen =
            localSession?.generation ??
            durableOwner?.generation ??
            profile.dutyGeneration ??
            locationService.currentGeneration;

        final stopSeq =
            localSession?.lifecycleSeq ??
            _activeLifecycleSeq ??
            durableOwner?.lifecycleSeq ??
            locationService.currentLifecycleSeq ??
            profile.lifecycleSeq;

        targetSessionId = stopSessionId;
        targetSeq = stopSeq;

        // Step 1: Authoritative server endDutySession FIRST
        if (stopSessionId != null) {
          if (stopGen == null || stopSeq == null) {
            _errorCategory = HubErrorCategory.dutyUpdateFailed;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _lastError = const DutyControllerError(
              code: 'EXACT_EPOCH_REQUIRED',
              message:
                  'Cannot end active duty session without exact session ID, generation and lifecycle sequence',
            );
            return false;
          }
          try {
            await locationService.endDutySessionCall(
              uid: profile.uid,
              sessionId: stopSessionId,
              generation: stopGen,
              lifecycleSeq: stopSeq,
            );
          } catch (serverErr) {
            if (!ownsGoOff()) {
              return false;
            }
            // Gate M4-D Case 1: Server end failed!
            // DO NOT claim OFF! Keep worker/native authority active! Retain retry!
            _authoritativeDutyState = AuthoritativeDutyState.onDuty;
            _errorCategory = HubErrorCategory.dutyUpdateFailed;
            final String sCode = (serverErr is PlatformException)
                ? serverErr.code
                : 'END_DUTY_SESSION_FAILED';
            final String sMsg = (serverErr is PlatformException)
                ? (serverErr.message ?? serverErr.toString())
                : serverErr.toString();
            final dynamic sDetails = (serverErr is PlatformException)
                ? serverErr.details
                : null;
            _lastError = DutyControllerError(
              code: sCode,
              message: sMsg,
              details: sDetails,
            );
            return false;
          }
        } else {
          try {
            await locationService.executeGoOffDutyTransaction(uid: profile.uid);
          } catch (serverErr) {
            if (!ownsGoOff()) {
              return false;
            }
            _authoritativeDutyState = AuthoritativeDutyState.onDuty;
            _errorCategory = HubErrorCategory.dutyUpdateFailed;
            final String sCode = (serverErr is PlatformException)
                ? serverErr.code
                : 'OFF_DUTY_FAILED';
            final String sMsg = (serverErr is PlatformException)
                ? (serverErr.message ?? serverErr.toString())
                : serverErr.toString();
            _lastError = DutyControllerError(code: sCode, message: sMsg);
            return false;
          }
        }

        if (!ownsGoOff()) {
          return false;
        }

        // Server end SUCCEEDED! Server is now OFF (Gate M4-D Case 2 & 3).
        _authoritativeDutyState = AuthoritativeDutyState.offDuty;
        _currentProfile = profile.copyWith(isOnDuty: false);
        _lastConfirmedOffGeneration = stopGen;

        // Step 2: Stop native service ONLY after server transaction succeeds
        final additionalCleanupSession = _pendingCleanupSession;
        _pendingCleanupSession =
            localSession ??
            (stopSessionId != null && stopGen != null
                ? DutySession(
                    uid: stopUid,
                    sessionId: stopSessionId,
                    generation: stopGen,
                    lifecycleSeq: stopSeq,
                  )
                : additionalCleanupSession);
        _residualCleanupRequired = true;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        bool nativeStopFailed = false;
        String? nativeStopCode;
        String? nativeStopMsg;
        dynamic nativeStopDetails;

        bool isNativeRunning = false;
        try {
          isNativeRunning = await locationService.isForegroundServiceRunning();
        } catch (_) {
          if (!ownsGoOff()) {
            return false;
          }
        }
        if (!ownsGoOff()) {
          return false;
        }

        if (localSession != null || durableOwner != null || isNativeRunning) {
          if (stopSessionId == null) {
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _residualCleanupRequired = true;
            _lastError = const DutyControllerError(
              code: 'EXACT_EPOCH_REQUIRED',
              message: 'Cannot stop native service without exact session ID',
              cleanupRequired: true,
            );
            return false;
          }

          try {
            await locationService.stopForegroundService(
              expectedUid: stopUid,
              expectedSessionId: stopSessionId,
              expectedGeneration: stopGen,
              expectedLifecycleSeq: stopSeq,
            );
          } catch (stopErr) {
            if (!ownsGoOff()) {
              return false;
            }
            nativeStopFailed = true;
            if (stopErr is PlatformException) {
              nativeStopCode = stopErr.code;
              nativeStopMsg = stopErr.message ?? stopErr.toString();
              nativeStopDetails = stopErr.details;
            } else {
              nativeStopCode = 'NATIVE_STOP_FAILED';
              nativeStopMsg = stopErr.toString();
            }
          }
        }

        if (!ownsGoOff()) {
          return false;
        }
        if (additionalCleanupSession != null &&
            additionalCleanupSession != _pendingCleanupSession &&
            !nativeStopFailed) {
          try {
            await locationService.stopForegroundService(
              expectedUid: additionalCleanupSession.uid,
              expectedSessionId: additionalCleanupSession.sessionId,
              expectedGeneration: additionalCleanupSession.generation,
              expectedLifecycleSeq: additionalCleanupSession.lifecycleSeq,
            );
          } catch (_) {
            if (!ownsGoOff()) {
              return false;
            }
          }
          if (!ownsGoOff()) {
            return false;
          }
        }
        if (!nativeStopFailed) {
          try {
            final absent = await _isNativeAbsent(ownsAttempt: ownsGoOff);
            if (!ownsGoOff()) {
              return false;
            }
            if (!absent) {
              throw PlatformException(
                code: 'RESIDUAL_STILL_RUNNING',
                message: 'Native residue still present after server end',
              );
            }
          } catch (verificationErr) {
            if (!ownsGoOff()) {
              return false;
            }
            nativeStopFailed = true;
            nativeStopCode = verificationErr is PlatformException
                ? verificationErr.code
                : 'NATIVE_STOP_FAILED';
            nativeStopMsg = verificationErr is PlatformException
                ? verificationErr.message ?? verificationErr.toString()
                : verificationErr.toString();
            nativeStopDetails = verificationErr is PlatformException
                ? verificationErr.details
                : null;
          }
        }
        if (!ownsGoOff()) {
          return false;
        }
        if (_pendingCancellation != null) {
          try {
            await locationService.cancelDutyActivationCall(
              uid: _pendingCancellation!.uid,
              sessionId: _pendingCancellation!.sessionId,
              generation: _pendingCancellation!.generation,
              lifecycleSeq: _pendingCancellation!.lifecycleSeq,
              attemptSeq: _pendingCancellation!.attemptSeq,
            );
            if (!ownsGoOff()) {
              return false;
            }
            _pendingCancellation = null;
          } catch (_) {
            if (!ownsGoOff()) {
              return false;
            }
          }
          if (!ownsGoOff()) {
            return false;
          }
        }

        if (nativeStopFailed) {
          // Gate M4-D Case 3: Server end succeeded, but native stop failed!
          // Server is OFF! UI must represent OFF / CLEANUP REQUIRED.
          _authoritativeDutyState = AuthoritativeDutyState.offDuty;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _residualCleanupRequired = true;
          _pendingCleanupSession =
              _activeSession ??
              (stopSessionId != null
                  ? DutySession(
                      uid: stopUid,
                      sessionId: stopSessionId,
                      generation: stopGen ?? currentGen,
                      lifecycleSeq: stopSeq,
                    )
                  : null);
          _activeSession = null;
          _activeLifecycleSeq = null;
          _lastError = DutyControllerError(
            code: nativeStopCode ?? 'NATIVE_STOP_FAILED',
            message: nativeStopMsg ?? 'Native stop failed',
            details: nativeStopDetails,
            cleanupErrorCode: nativeStopCode ?? 'NATIVE_STOP_FAILED',
            cleanupErrorMessage: nativeStopMsg,
            cleanupDetails: nativeStopDetails,
            cleanupRequired: true,
          );
          return false;
        }

        // Gate M4-D Case 2: Both server and native stopped cleanly.
        _activeSession = null;
        _activeLifecycleSeq = null;
        _pendingCleanupSession = null;
        _residualCleanupRequired = false;
        _authoritativeDutyState = AuthoritativeDutyState.offDuty;
        _trackingHealth = TrackingHealth.off;
        return true;
      } catch (e) {
        if (ownsGoOff()) {
          final String errCode;
          final String errMsg;
          final dynamic errDetails;
          if (e is PlatformException) {
            errCode = e.code;
            errMsg = e.message ?? e.toString();
            errDetails = e.details;
          } else {
            errCode = 'OFF_DUTY_FAILED';
            errMsg = e.toString();
            errDetails = null;
          }

          final isCleanupFailure =
              errCode == 'NATIVE_STOP_FAILED' ||
              errCode.contains('CLEANUP') ||
              errCode.contains('STOP');

          if (isCleanupFailure) {
            final effectiveUid = profile?.uid ?? currentUid;
            if (effectiveUid != null && targetSessionId != null) {
              _pendingCleanupSession =
                  _activeSession ??
                  DutySession(
                    uid: effectiveUid,
                    sessionId: targetSessionId,
                    generation: currentGen,
                    lifecycleSeq: targetSeq,
                  );
            } else {
              _pendingCleanupSession = _activeSession;
            }
          }

          _lastError = DutyControllerError(
            code: errCode,
            message: errMsg,
            details: errDetails,
            cleanupErrorCode: isCleanupFailure ? errCode : null,
            cleanupErrorMessage: isCleanupFailure ? errMsg : null,
            cleanupDetails: isCleanupFailure ? errDetails : null,
            cleanupRequired: isCleanupFailure,
          );

          if (_currentProfile?.hasActiveJob == true) {
            _errorCategory = HubErrorCategory.activeJobPreventOffDuty;
          } else if (_currentProfile?.hasActiveOffer == true) {
            _errorCategory = HubErrorCategory.activeOfferPreventOffDuty;
          } else {
            _errorCategory = HubErrorCategory.dutyUpdateFailed;
          }
        }
        return false;
      } finally {
        if (ownsGoOff()) {
          _winningToken = ControllerOperationToken(
            id: 0,
            intent: ControllerIntent.idle,
            uid: _boundUid ?? '',
          );
          _isLoading = false;
          _safeNotifyListeners();
        }
      }
    });
  }

  /// Canonical durable/native absence proof. A fenced STOP may successfully
  /// preserve a replacement owner, so any remaining authority blocks clean OFF.
  Future<bool> _isNativeAbsent({bool Function()? ownsAttempt}) async {
    final startEpoch = NativeOwnershipCoordinator.currentEpoch;
    final remainingOwner = await locationService.getDurableOwnerRecord();
    if (ownsAttempt != null && !ownsAttempt()) return false;
    final remainingSession = await locationService.getDurableSession();
    if (ownsAttempt != null && !ownsAttempt()) return false;
    final stillRunning = await locationService.isForegroundServiceRunning();
    if (ownsAttempt != null && !ownsAttempt()) return false;
    if (remainingOwner != null || remainingSession != null || stillRunning) {
      return false;
    }
    // getDurableSession can suppress a non-ACTIVE record when the worker is
    // stopped. Recheck raw storage so an intervening replacement cannot hide
    // behind that conversion and authorize clean OFF.
    final finalOwner = await locationService.getDurableOwnerRecord();
    if (ownsAttempt != null && !ownsAttempt()) return false;
    if (finalOwner != null) return false;

    // Check epoch freshness across the entire absence observation sequence
    if (NativeOwnershipCoordinator.currentEpoch != startEpoch) return false;
    if (NativeOwnershipCoordinator.hasStartInFlight) return false;

    return true;
  }

  /// Performs compensating cleanup when startup or transitional steps fail.
  /// Attempts to stop the native service (if session active) and cancel the
  /// activation intent on the server (if registered).
  /// Captures errors without throwing so both cleanups are attempted and recorded.
  Future<CompensationOutcome> _compensateGoOn({
    required DutySession? session,
    required String? registeredSessionId,
    required String uid,
    required ControllerOperationToken source,
    required bool Function() ownsAttempt,
    int? attemptSeq,
    int? generation,
    bool serverEnded = false,
    bool serverDebt = false,
  }) async {
    final result = await _performCompensatingCleanup(
      session: session,
      registeredSessionId: registeredSessionId,
      uid: uid,
      source: source,
      attemptSeq: attemptSeq,
      generation: generation,
      serverEnded: serverEnded,
      serverDebt: serverDebt,
    );
    if (ownsAttempt()) {
      _publishCompensationDebt(result);
    } else {
      if (result.unresolved) _deferredCompensation.add(result);
      final receiver = _logoutBarrierOwner;
      if (receiver != null && identical(receiver.predecessor, source)) {
        await beforeCompensationHandoff?.call();
        await _acceptLogoutCompensation(receiver, result);
      }
    }
    return result;
  }

  bool _canPublishCompensation(CompensationOutcome result) =>
      (_pendingServerDebtSession == null ||
          _pendingServerDebtSession == result.session) &&
      (_pendingCleanupSession == null ||
          _pendingCleanupSession == result.session) &&
      (_pendingCancellation == null ||
          (_pendingCancellation!.uid == result.cancellationAuthority?.uid &&
              _pendingCancellation!.sessionId ==
                  result.cancellationAuthority?.sessionId &&
              _pendingCancellation!.generation ==
                  result.cancellationAuthority?.generation &&
              _pendingCancellation!.lifecycleSeq ==
                  result.cancellationAuthority?.lifecycleSeq &&
              _pendingCancellation!.attemptSeq ==
                  result.cancellationAuthority?.attemptSeq));

  void _publishCompensationDebt(CompensationOutcome result) {
    if (!_canPublishCompensation(result)) return;
    if (result.serverDebt) {
      _pendingServerDebtSession = result.session;
    } else if (result.serverEnded && _pendingServerDebtSession == result.session) {
      _pendingServerDebtSession = null;
    }
    if (result['cleanCode'] != null) {
      _pendingCleanupSession = result.session;
    } else if (_pendingCleanupSession == result.session) {
      _pendingCleanupSession = null;
    }
    if (result.cancellationAuthority != null) {
      _pendingCancellation = result.cancellation;
    }
  }

  Future<void> _acceptLogoutCompensation(
    LogoutBarrierLease receiver,
    CompensationOutcome result,
  ) async {
    if (_isDisposed ||
        !identical(_logoutBarrierOwner, receiver) ||
        !_isLogoutInProgress ||
        _currentAuthUid != receiver.uid ||
        result.source.uid != receiver.uid ||
        !identical(receiver.predecessor, result.source) ||
        result.source.intent != ControllerIntent.goOn ||
        _winningToken.intent != ControllerIntent.logoutBarrier ||
        _winningToken.id != receiver.operationId ||
        _winningToken.uid != receiver.uid ||
        _generation != receiver.generation ||
        (receiver.predecessorSession != null &&
            receiver.predecessorSession != result.session) ||
        _pendingCleanupSession != null ||
        _pendingCancellation != null ||
        (result.unresolved && !_deferredCompensation.contains(result)) ||
        !_canPublishCompensation(result)) {
      return;
    }
    // The current logout lease maps cleanup facts; it never adopts startup errors.
    if (result['cleanCode'] != null) {
      _publishCompensationDebt(result);
      _deferredCompensation.remove(result);
      _residualCleanupRequired = true;
      _trackingHealth = TrackingHealth.reconciliationFailed;
      _lastError = _cleanupOutcomeError(result);
    } else if (result.serverEnded) {
      bool isAbsent = true;
      if (NativeOwnershipCoordinator.hasStartInFlight) {
        isAbsent = false;
      } else if (result.proofEpoch != 0 &&
          NativeOwnershipCoordinator.currentEpoch != result.proofEpoch) {
        isAbsent = false;
      } else {
        final remainingOwner = await locationService.getDurableOwnerRecord();
        final remainingSession = await locationService.getDurableSession();
        if (remainingOwner != null || remainingSession != null) {
          isAbsent = false;
        } else {
          final finalOwner = await locationService.getDurableOwnerRecord();
          if (finalOwner != null ||
              NativeOwnershipCoordinator.hasStartInFlight ||
              (result.proofEpoch != 0 &&
                  NativeOwnershipCoordinator.currentEpoch != result.proofEpoch)) {
            isAbsent = false;
          }
        }
      }
      if (_isDisposed ||
          !identical(_logoutBarrierOwner, receiver) ||
          !_isLogoutInProgress ||
          _currentAuthUid != receiver.uid ||
          _winningToken.intent != ControllerIntent.logoutBarrier ||
          _winningToken.id != receiver.operationId ||
          _winningToken.uid != receiver.uid ||
          _generation != receiver.generation) {
        return;
      }
      if (!isAbsent) {
        final failedResult = CompensationOutcome(
          source: result.source,
          session: result.session,
          serverEnded: result.serverEnded,
          serverDebt: result.serverDebt,
          stopSucceeded: result.stopSucceeded,
          nativeAbsenceProven: false,
          proofEpoch: 0,
          cancellationAuthority: result.cancellationAuthority,
          errors: {
            ...result.errors,
            'cleanCode': 'NATIVE_STOP_FAILED',
            'cleanMsg': 'Native residue remains after compensating stop',
          },
        );
        _publishCompensationDebt(failedResult);
        _deferredCompensation.remove(result);
        _residualCleanupRequired = true;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _lastError = _cleanupOutcomeError(failedResult);
      } else {
        _deferredCompensation.remove(result);
        _authoritativeDutyState = AuthoritativeDutyState.offDuty;
        _trackingHealth = TrackingHealth.off;
      }
    }
    _safeNotifyListeners();
  }

  DutyControllerError _cleanupOutcomeError(CompensationOutcome result) =>
      DutyControllerError(
        code: result['cleanCode'] ?? result['cancelCode'] ?? 'CLEANUP_FAILED',
        message: result['cleanMsg'] ?? result['cancelMsg'] ?? 'Cleanup failed',
        cleanupErrorCode: result['cleanCode'],
        cleanupErrorMessage: result['cleanMsg'],
        cleanupDetails: result['cleanDetails'],
        cancellationErrorCode: result['cancelCode'],
        cancellationErrorMessage: result['cancelMsg'],
        cancellationErrorDetails: result['cancelDetails'],
        isCancellationPending: result.cancellation != null,
        cleanupRequired: result.unresolved,
      );

  // Explicit retry is the existing cleanup owner. Deferred A facts never publish
  // into B, and a pending newer obligation always takes precedence.
  Future<bool> _retryDeferredCompensation(CompensationOutcome debt) async {
    final retryAttempt = ++_retryAttemptCounter;
    final receiver = _winningToken;
    final generation = _generation;
    final cancellation = debt.cancellation;
    var endSucceeded = debt.serverEnded;
    if (debt.session != null && !debt.serverEnded) {
      try {
        await locationService.endDutySessionCall(
          uid: debt.session!.uid,
          sessionId: debt.session!.sessionId,
          generation: debt.session!.generation,
          lifecycleSeq: debt.session!.lifecycleSeq,
        );
        endSucceeded = true;
      } catch (_) {
        endSucceeded = false;
      }
    }
    final result = await _performCompensatingCleanup(
      source: debt.source,
      session: debt.session,
      uid: debt.source.uid,
      registeredSessionId: cancellation?.sessionId,
      generation: cancellation?.generation,
      attemptSeq: cancellation?.attemptSeq,
      serverEnded: endSucceeded,
      serverDebt: !endSucceeded && debt.serverDebt,
    );
    if (_isDisposed ||
        retryAttempt != _retryAttemptCounter ||
        !identical(_winningToken, receiver) ||
        _generation != generation ||
        _currentAuthUid != debt.source.uid ||
        _pendingCleanupSession != null ||
        _pendingCancellation != null) {
      return false;
    }
    final index = _deferredCompensation.indexOf(debt);
    if (result.unresolved) {
      if (index != -1) {
        _deferredCompensation[index] = result;
      } else {
        _deferredCompensation.add(result);
      }
    } else {
      if (index != -1) {
        _deferredCompensation.removeAt(index);
      } else {
        _deferredCompensation.remove(debt);
      }
    }
    _residualCleanupRequired = _deferredCompensation.any((d) => d.unresolved);
    if (result.unresolved) {
      _lastError = _cleanupOutcomeError(result);
      _trackingHealth = TrackingHealth.reconciliationFailed;
    } else {
      final hasOtherCleanup =
          _residualCleanupRequired ||
          _pendingCancellation != null ||
          _pendingCleanupSession != null;
      if (!hasOtherCleanup) {
        _lastError = null;
        _errorCategory = null;
        if (_trackingHealth == TrackingHealth.reconciliationFailed) {
          _trackingHealth = TrackingHealth.off;
        }
      }
    }
    _safeNotifyListeners();
    return !result.unresolved;
  }

  Future<CompensationOutcome> _performCompensatingCleanup({
    required DutySession? session,
    required String? registeredSessionId,
    required String uid,
    int? attemptSeq,
    required ControllerOperationToken source,
    bool serverEnded = false,
    bool serverDebt = false,
    int? generation,
  }) async {
    var stopSucceeded = false;
    var nativeAbsenceProven = false;
    String? cleanCode;
    String? cleanMsg;
    dynamic cleanDetails;

    String? cancelCode;
    String? cancelMsg;
    dynamic cancelDetails;

    final endSucceeded = serverEnded;

    // Capture cancellation authority before either cleanup await.
    final cancelGen = session?.generation ?? generation;
    final cancelSeq = session?.lifecycleSeq;
    if (session != null) {
      try {
        await locationService.stopForegroundService(
          expectedUid: session.uid,
          expectedSessionId: session.sessionId,
          expectedGeneration: session.generation,
          expectedLifecycleSeq: session.lifecycleSeq,
        );
        stopSucceeded = true;
        if (!await _isNativeAbsent()) {
          throw StateError('Native residue remains after compensating stop');
        }
        nativeAbsenceProven = true;
      } catch (cleanErr) {
        if (cleanErr is PlatformException) {
          cleanCode = cleanErr.code;
          cleanMsg = cleanErr.message ?? cleanErr.toString();
          cleanDetails = cleanErr.details;
        } else {
          cleanCode = 'NATIVE_STOP_FAILED';
          cleanMsg = cleanErr.toString();
        }
      }
    }

    if (registeredSessionId != null && uid.isNotEmpty) {
      try {
        await locationService.cancelDutyActivationCall(
          uid: uid,
          sessionId: registeredSessionId,
          generation: cancelGen,
          lifecycleSeq: cancelSeq,
          attemptSeq: attemptSeq,
        );
      } catch (cancelErr) {
        if (cancelErr is PlatformException) {
          cancelCode = cancelErr.code;
          cancelMsg = cancelErr.message ?? cancelErr.toString();
          cancelDetails = cancelErr.details;
        } else {
          cancelCode = 'ACTIVATION_CANCEL_FAILED';
          cancelMsg = cancelErr.toString();
        }
      }
    }

    return CompensationOutcome(
      source: source,
      session: session,
      serverEnded: endSucceeded,
      serverDebt: serverDebt,
      stopSucceeded: stopSucceeded,
      nativeAbsenceProven: nativeAbsenceProven,
      proofEpoch: nativeAbsenceProven ? NativeOwnershipCoordinator.currentEpoch : 0,
      cancellationAuthority: registeredSessionId == null
          ? null
          : PendingActivationCancellation(
              uid: uid,
              sessionId: registeredSessionId,
              generation: cancelGen,
              lifecycleSeq: cancelSeq,
              attemptSeq: attemptSeq,
              errorCode: cancelCode,
              errorMessage: cancelMsg,
              errorDetails: cancelDetails,
            ),
      errors: {
        'cleanCode': cleanCode,
        'cleanMsg': cleanMsg,
        'cleanDetails': cleanDetails,
        'cancelCode': cancelCode,
        'cancelMsg': cancelMsg,
        'cancelDetails': cancelDetails,
      },
    );
  }

  /// Builds a [DutyControllerError] preserving typed primary failure codes
  /// while separately recording cleanup and cancellation outcomes.
  /// [cleanupRequired] is strictly true if and only if compensating STOP or
  /// cancellation failed, leaving residual state.
  DutyControllerError _buildFailureError({
    required String primaryCode,
    required String primaryMsg,
    dynamic primaryDetails,
    String? cleanCode,
    String? cleanMsg,
    dynamic cleanDetails,
    String? cancelCode,
    String? cancelMsg,
    dynamic cancelDetails,
  }) {
    final bool cleanupReq = cleanCode != null || cancelCode != null;
    final bool cancelPending = cancelCode != null;
    if (cleanupReq) {
      _residualCleanupRequired = true;
    }

    return DutyControllerError(
      code: primaryCode,
      message: primaryMsg,
      details: primaryDetails,
      startupErrorCode: primaryCode,
      startupErrorMessage: primaryMsg,
      startupErrorDetails: primaryDetails,
      cleanupErrorCode: cleanCode,
      cleanupErrorMessage: cleanMsg,
      cleanupDetails: cleanDetails,
      cancellationErrorCode: cancelCode,
      cancellationErrorMessage: cancelMsg,
      cancellationErrorDetails: cancelDetails,
      isCancellationPending: cancelPending,
      cleanupRequired: cleanupReq,
    );
  }

  /// Retries outstanding cleanup operations (native service stop and/or activation cancellation).
  /// Updates [lastError] with the result. If all retries succeed, [cleanupRequired] becomes false.
  Future<bool> retryCleanup() async {
    if (_isDisposed) return false;
    final sessionToClean = _pendingCleanupSession;
    final cancelAuth = _pendingCancellation;
    final serverSessionToClean = _pendingServerDebtSession;
    if (sessionToClean == null && cancelAuth == null && serverSessionToClean == null) {
      for (final debt in _deferredCompensation) {
        if (debt.source.uid == _currentAuthUid ||
            debt.session?.uid == _currentAuthUid ||
            debt.cancellation?.uid == _currentAuthUid) {
          return _retryDeferredCompensation(debt);
        }
      }
    }

    if (sessionToClean == null && cancelAuth == null && serverSessionToClean == null) {
      _residualCleanupRequired = false;
      if (_lastError != null && _lastError!.cleanupRequired) {
        _lastError = DutyControllerError(
          code: _lastError!.code,
          message: _lastError!.message,
          details: _lastError!.details,
          startupErrorCode: _lastError!.startupErrorCode,
          startupErrorMessage: _lastError!.startupErrorMessage,
          startupErrorDetails: _lastError!.startupErrorDetails,
          cleanupErrorCode: null,
          cleanupErrorMessage: null,
          cleanupDetails: null,
          cancellationErrorCode: null,
          cancellationErrorMessage: null,
          cancellationErrorDetails: null,
          isCancellationPending: false,
          cleanupRequired: false,
        );
        _safeNotifyListeners();
      }
      return true;
    }

    final initialGen = _generation;
    final initialToken = _winningToken;
    final initialUid = _currentAuthUid;
    final retryAttempt = ++_retryAttemptCounter;

    bool ownsRetry() =>
        !_isDisposed &&
        _generation == initialGen &&
        _winningToken.id == initialToken.id &&
        _currentAuthUid == initialUid &&
        retryAttempt == _retryAttemptCounter;

    String? serverEndCode;
    String? serverEndMsg;
    dynamic serverEndDetails;
    if (serverSessionToClean != null) {
      try {
        await locationService.endDutySessionCall(
          uid: serverSessionToClean.uid,
          sessionId: serverSessionToClean.sessionId,
          generation: serverSessionToClean.generation,
          lifecycleSeq: serverSessionToClean.lifecycleSeq,
        );
      } catch (endErr) {
        if (endErr is PlatformException) {
          serverEndCode = endErr.code;
          serverEndMsg = endErr.message ?? endErr.toString();
          serverEndDetails = endErr.details;
        } else {
          serverEndCode = 'END_DUTY_SESSION_FAILED';
          serverEndMsg = endErr.toString();
        }
      }

      if (ownsRetry() && _pendingServerDebtSession == serverSessionToClean) {
        if (serverEndCode != null) {
          _pendingServerDebtSession = serverSessionToClean;
        } else {
          _pendingServerDebtSession = null;
        }
      }
    }

    String? cleanCode;
    String? cleanMsg;
    dynamic cleanDetails;
    if (sessionToClean != null) {
      try {
        await locationService.stopForegroundService(
          expectedUid: sessionToClean.uid,
          expectedSessionId: sessionToClean.sessionId,
          expectedGeneration: sessionToClean.generation,
          expectedLifecycleSeq: sessionToClean.lifecycleSeq,
        );
        if (!await _isNativeAbsent(ownsAttempt: ownsRetry)) {
          cleanCode = 'RESIDUAL_STILL_RUNNING';
          cleanMsg =
              'Foreground service or durable owner residue still present after stop';
        }
      } catch (cleanErr) {
        if (cleanErr is PlatformException) {
          cleanCode = cleanErr.code;
          cleanMsg = cleanErr.message ?? cleanErr.toString();
          cleanDetails = cleanErr.details;
        } else {
          cleanCode = 'NATIVE_STOP_FAILED';
          cleanMsg = cleanErr.toString();
        }
      }

      if (ownsRetry() && _pendingCleanupSession == sessionToClean) {
        if (cleanCode != null) {
          _pendingCleanupSession = sessionToClean;
        } else {
          _pendingCleanupSession = null;
        }
      }
    }

    String? cancelCode;
    String? cancelMsg;
    dynamic cancelDetails;
    if (cancelAuth != null) {
      try {
        await locationService.cancelDutyActivationCall(
          uid: cancelAuth.uid,
          sessionId: cancelAuth.sessionId,
          generation: cancelAuth.generation,
          lifecycleSeq: cancelAuth.lifecycleSeq,
          attemptSeq: cancelAuth.attemptSeq,
        );
      } catch (cancelErr) {
        if (cancelErr is PlatformException) {
          cancelCode = cancelErr.code;
          cancelMsg = cancelErr.message ?? cancelErr.toString();
          cancelDetails = cancelErr.details;
        } else {
          cancelCode = 'ACTIVATION_CANCEL_FAILED';
          cancelMsg = cancelErr.toString();
        }
      }

      if (ownsRetry() &&
          _pendingCancellation?.sessionId == cancelAuth.sessionId &&
          _pendingCancellation?.attemptSeq == cancelAuth.attemptSeq) {
        if (cancelCode != null) {
          _pendingCancellation = PendingActivationCancellation(
            uid: cancelAuth.uid,
            sessionId: cancelAuth.sessionId,
            generation: cancelAuth.generation,
            lifecycleSeq: cancelAuth.lifecycleSeq,
            attemptSeq: cancelAuth.attemptSeq,
            errorCode: cancelCode,
            errorMessage: cancelMsg,
            errorDetails: cancelDetails,
          );
        } else {
          _pendingCancellation = null;
        }
      }
    }

    if (!ownsRetry()) {
      return false;
    }

    final bool stillRequired = cleanCode != null ||
        cancelCode != null ||
        serverEndCode != null ||
        _pendingServerDebtSession != null ||
        _pendingCleanupSession != null ||
        _pendingCancellation != null;
    _residualCleanupRequired = stillRequired;

    if (!stillRequired) {
      if (_authoritativeDutyState == AuthoritativeDutyState.offDuty) {
        _trackingHealth = TrackingHealth.off;
      }
      _errorCategory = null;
    }

    final effectiveCleanCode = cleanCode ?? serverEndCode;
    final effectiveCleanMsg = cleanMsg ?? serverEndMsg;
    final effectiveCleanDetails = cleanDetails ?? serverEndDetails;

    if (_lastError != null) {
      _lastError = DutyControllerError(
        code: _lastError!.code,
        message: _lastError!.message,
        details: _lastError!.details,
        startupErrorCode: _lastError!.startupErrorCode,
        startupErrorMessage: _lastError!.startupErrorMessage,
        startupErrorDetails: _lastError!.startupErrorDetails,
        cleanupErrorCode: effectiveCleanCode,
        cleanupErrorMessage: effectiveCleanMsg,
        cleanupDetails: effectiveCleanDetails,
        cancellationErrorCode: cancelCode,
        cancellationErrorMessage: cancelMsg,
        cancellationErrorDetails: cancelDetails,
        isCancellationPending: cancelCode != null,
        cleanupRequired: stillRequired,
      );
    } else if (stillRequired) {
      _lastError = DutyControllerError(
        code: effectiveCleanCode ?? cancelCode ?? 'CLEANUP_FAILED',
        message: effectiveCleanMsg ?? cancelMsg ?? 'Cleanup retry failed',
        details: effectiveCleanDetails ?? cancelDetails,
        cleanupErrorCode: effectiveCleanCode,
        cleanupErrorMessage: effectiveCleanMsg,
        cleanupDetails: effectiveCleanDetails,
        cancellationErrorCode: cancelCode,
        cancellationErrorMessage: cancelMsg,
        cancellationErrorDetails: cancelDetails,
        isCancellationPending: cancelCode != null,
        cleanupRequired: true,
      );
    }

    _safeNotifyListeners();
    return !stillRequired;
  }

  /// Reconciles local tracking service with authoritative Firestore duty state.
  Future<void> reconcileDutyState() {
    if (_isDisposed || _isLogoutInProgress) return Future.value();

    final enqueueGen = _generation;
    final enqueueDesired = _desiredDutyState;
    final token = ControllerOperationToken(
      id: ++_opTokenCounter,
      intent: ControllerIntent.reconcile,
      uid: _currentAuthUid ?? _boundUid ?? '',
    );
    if (_winningToken.intent.index <= ControllerIntent.reconcile.index &&
        !_isLoading) {
      _winningToken = token;
    }

    return _enqueue<void>(() async {
      if (!_isTokenActive(token)) return;
      if (_winningToken.intent == ControllerIntent.logoutBarrier ||
          _winningToken.intent == ControllerIntent.goOff ||
          _winningToken.intent == ControllerIntent.goOn ||
          _isLoading) {
        return;
      }
      _isReconciling = true;
      _safeNotifyListeners();

      try {
        final profile = _currentProfile;
        final currentUid = _currentAuthUid;
        if (profile == null ||
            currentUid == null ||
            currentUid != profile.uid ||
            currentUid != token.uid) {
          return;
        }

        // Validate latest desired state and generation inside execution closure
        if ((enqueueDesired == DesiredDutyState.off &&
                _desiredDutyState == DesiredDutyState.on &&
                isHealthyOnDuty) ||
            (enqueueGen != _generation && isHealthyOnDuty)) {
          return;
        }

        final currentGen = ++_generation;
        bool ownsAttempt() =>
            _generation == currentGen &&
            _isTokenActive(token) &&
            _currentAuthUid == token.uid;

        Future<void> compensateStaleStart(DutySession? authority) async {
          if (authority?.lifecycleSeq == null) return;
          try {
            final owner = await locationService.getDurableOwnerRecord();
            if (owner == null) {
              if (await locationService.isForegroundServiceRunning()) {
                throw StateError(
                  'Native service runs without a verifiable owner',
                );
              }
              return;
            }
            if (owner.uid != authority!.uid ||
                owner.sessionId != authority.sessionId ||
                owner.generation != authority.generation ||
                owner.lifecycleSeq != authority.lifecycleSeq) {
              return; // A newer or different worker owns native authority.
            }
            await locationService.stopForegroundService(
              expectedUid: authority.uid,
              expectedSessionId: authority.sessionId,
              expectedGeneration: authority.generation,
              expectedLifecycleSeq: authority.lifecycleSeq,
            );
            final remaining = await locationService.getDurableOwnerRecord();
            if (remaining != null &&
                remaining.uid == authority.uid &&
                remaining.sessionId == authority.sessionId &&
                remaining.generation == authority.generation &&
                remaining.lifecycleSeq == authority.lifecycleSeq) {
              throw StateError(
                'Exact stale native authority remains after stop',
              );
            }
            if (remaining == null &&
                await locationService.isForegroundServiceRunning()) {
              throw StateError(
                'Native service still runs without an owner after exact stop',
              );
            }
          } catch (error) {
            debugPrint(
              'Stale native start cleanup failed: $authority: $error',
            );
            // Gate Group E (F10): Stale controller writes remain forbidden under R14.
            // Presentation ownership is governed strictly by current controller state.
            bool shouldSuppressDiagnostic = false;
            final currentUid = _currentAuthUid;
            final isSuccessor = (currentUid != null && currentUid != authority?.uid) ||
                (_currentProfile != null &&
                    _currentProfile!.uid.isNotEmpty &&
                    _currentProfile!.uid != authority?.uid);
            if (isSuccessor) {
              try {
                await locationService.getDurableOwnerRecord();
                await locationService.isForegroundServiceRunning();
              } catch (_) {}
              shouldSuppressDiagnostic = true;
            } else if (currentUid == authority?.uid) {
              // Same UID: suppress if generation advanced, token inactive, logout in progress, or error cleared
              if (_generation != currentGen ||
                  !_isTokenActive(token) ||
                  _isLogoutInProgress ||
                  _errorClearedForUid == currentUid) {
                shouldSuppressDiagnostic = true;
              }
            } else if (_isLogoutInProgress || _isDisposed) {
              shouldSuppressDiagnostic = true;
            }

            if (!shouldSuppressDiagnostic) {
              _staleStartCleanupError = '$authority: $error';
            }
          }
        }

        // Gate M4-H: Fail-closed native authority reads
        DurableDutyOwnerRecord? durableRecord;
        DutySession? durableSession;
        bool isRunning = false;
        try {
          durableRecord = await locationService.getDurableOwnerRecord();
          if (!ownsAttempt()) return;
          durableSession = await locationService.getDurableSession();
          if (!ownsAttempt()) return;
          isRunning = await locationService.isForegroundServiceRunning();
        } catch (readErr) {
          if (!ownsAttempt()) return;
          _authoritativeDutyState = AuthoritativeDutyState.unknown;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _errorCategory = HubErrorCategory.reconciliationFailed;
          _activeSession = null;
          _activeLifecycleSeq = null;
          _lastError = DutyControllerError(
            code: (readErr is PlatformException)
                ? readErr.code
                : 'NATIVE_READ_FAILED',
            message: (readErr is PlatformException)
                ? (readErr.message ?? readErr.toString())
                : readErr.toString(),
            details: (readErr is PlatformException) ? readErr.details : null,
          );
          _safeNotifyListeners();
          return;
        }

        if (!ownsAttempt()) return;

        // Effective native owner record (4-field identity)
        final effectiveRecord =
            durableRecord ??
            (durableSession != null &&
                    durableSession.lifecycleSeq != null &&
                    durableSession.lifecycleSeq! > 0
                ? DurableDutyOwnerRecord(
                    sessionId: durableSession.sessionId,
                    uid: durableSession.uid,
                    generation: durableSession.generation,
                    lifecycleSeq: durableSession.lifecycleSeq!,
                    notificationTitle: durableSession.notificationTitle,
                    notificationText: durableSession.notificationText,
                    locale: durableSession.locale,
                    startedAt: DateTime.now(),
                  )
                : null);

        // Every authority-establishing reconciliation requires a usable current
        // server read. Even an exact cached/native match cannot establish READY.
        late final DriverProfile effectiveProfile;
        try {
          final freshServerData = await locationService.fetchServerDriverState(
            profile.uid,
          );
          if (!ownsAttempt()) return;
          if (freshServerData == null) {
            throw StateError('Fresh server driver state unavailable');
          }
          // The profile parser defaults an absent duty flag to false for
          // non-authoritative callers. A fresh reconciliation must not turn
          // that default into permission to stop a native worker.
          if (freshServerData['isOnDuty'] is! bool) {
            throw const FormatException(
              'Fresh isOnDuty must be an explicit boolean',
            );
          }
          effectiveProfile = DriverProfile.fromMap(
            freshServerData,
            profile.uid,
          );
          if (effectiveProfile.isOnDuty &&
              (effectiveProfile.activeDutySessionId == null ||
                  effectiveProfile.dutyGeneration == null ||
                  effectiveProfile.dutyGeneration! <= 0)) {
            throw const FormatException('Fresh ON duty identity is incomplete');
          }
        } catch (serverReadErr) {
          if (!ownsAttempt()) return;
          _authoritativeDutyState = AuthoritativeDutyState.unknown;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _errorCategory = HubErrorCategory.reconciliationFailed;
          _activeSession = null;
          _activeLifecycleSeq = null;
          _lastError = DutyControllerError(
            code: (serverReadErr is PlatformException)
                ? serverReadErr.code
                : 'SERVER_READ_FAILED',
            message: (serverReadErr is PlatformException)
                ? (serverReadErr.message ?? serverReadErr.toString())
                : serverReadErr.toString(),
          );
          _safeNotifyListeners();
          return;
        }
        if (!ownsAttempt()) return;
        _currentProfile = effectiveProfile;

        // Native storage can change between these reads. An incomplete session
        // or conflicting exact tuples cannot establish one worker's authority.
        final nativeSeq = durableSession?.lifecycleSeq;
        final unverifiableNativeSession =
            durableSession != null && (nativeSeq == null || nativeSeq <= 0);
        final nativeReadsDisagree =
            durableRecord != null &&
            durableSession != null &&
            (durableRecord.uid != durableSession.uid ||
                durableRecord.sessionId != durableSession.sessionId ||
                durableRecord.generation != durableSession.generation ||
                durableRecord.lifecycleSeq != nativeSeq);
        if (unverifiableNativeSession || nativeReadsDisagree) {
          _authoritativeDutyState = AuthoritativeDutyState.unknown;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _errorCategory = HubErrorCategory.reconciliationFailed;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return;
        }

        // Startup Matrix Case 1, 2, 3: Server OFF
        if (!effectiveProfile.isOnDuty) {
          if (!isRunning &&
              durableRecord == null &&
              durableSession == null &&
              _activeSession == null &&
              _pendingCleanupSession == null) {
            // Initial native reads preceded the fresh server await. They do
            // not prove absence after that await if a worker appeared meanwhile.
            late final bool absent;
            try {
              absent = await _isNativeAbsent(ownsAttempt: ownsAttempt);
            } catch (readErr) {
              if (!ownsAttempt()) return;
              _authoritativeDutyState = AuthoritativeDutyState.offDuty;
              _trackingHealth = TrackingHealth.reconciliationFailed;
              _errorCategory = HubErrorCategory.reconciliationFailed;
              _lastError = DutyControllerError(
                code: readErr is PlatformException
                    ? readErr.code
                    : 'NATIVE_READ_FAILED',
                message: readErr is PlatformException
                    ? readErr.message ?? readErr.toString()
                    : readErr.toString(),
                details: readErr is PlatformException ? readErr.details : null,
              );
              return;
            }
            if (!ownsAttempt()) return;
            if (!absent) {
              _authoritativeDutyState = AuthoritativeDutyState.offDuty;
              _trackingHealth = TrackingHealth.reconciliationFailed;
              _errorCategory = HubErrorCategory.reconciliationFailed;
              _lastError = const DutyControllerError(
                code: 'NATIVE_AUTHORITY_CHANGED',
                message:
                    'Native authority changed during server reconciliation',
              );
              return;
            }
            // Startup Case 1: Server OFF + No Native Owner -> OFF
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.off;
            _activeSession = null;
            _activeLifecycleSeq = null;
            return;
          }

          // Startup Case 2 & 3: Server OFF + Residual exact native owner / service
          // Reconciliation is also a cleanup retry. Once captured, the exact
          // selector must survive later observations of replacement authority.
          final cleanupSession =
              _pendingCleanupSession ??
              _activeSession?.copyWith(
                lifecycleSeq:
                    _activeSession?.lifecycleSeq ?? _activeLifecycleSeq,
              ) ??
              DutySession(
                uid:
                    durableRecord?.uid ??
                    durableSession?.uid ??
                    _activeSession?.uid ??
                    effectiveProfile.uid,
                sessionId:
                    durableRecord?.sessionId ??
                    durableSession?.sessionId ??
                    _activeSession?.sessionId ??
                    '',
                generation:
                    durableRecord?.generation ??
                    durableSession?.generation ??
                    _activeSession?.generation ??
                    currentGen,
                lifecycleSeq:
                    durableRecord?.lifecycleSeq ??
                    durableSession?.lifecycleSeq ??
                    locationService.currentLifecycleSeq,
              );
          _authoritativeDutyState = AuthoritativeDutyState.offDuty;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _pendingCleanupSession = cleanupSession;
          _residualCleanupRequired = true;
          _activeSession = null;
          _activeLifecycleSeq = null;
          try {
            await locationService.stopForegroundService(
              expectedUid: cleanupSession.uid,
              expectedSessionId: cleanupSession.sessionId,
              expectedGeneration: cleanupSession.generation,
              expectedLifecycleSeq: cleanupSession.lifecycleSeq,
            );
            if (!ownsAttempt()) return;
            // Removal of the old target is not global absence: a fenced STOP
            // can preserve replacement ownership even with no running worker.
            final absent = await _isNativeAbsent(ownsAttempt: ownsAttempt);
            if (!ownsAttempt()) return;
            if (!absent) {
              throw StateError(
                'Residual native authority still present after stop',
              );
            }
            // Startup Case 2: All required native truth proves absence -> OFF.
            _trackingHealth = TrackingHealth.off;
            _pendingCleanupSession = null;
            _residualCleanupRequired = false;
            _lastError = null;
            _errorCategory = null;
          } catch (e) {
            if (!ownsAttempt()) return;
            // Keep the captured selector; never substitute a replacement owner.
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _residualCleanupRequired = true;
            _pendingCleanupSession = cleanupSession;
            _errorCategory = HubErrorCategory.reconciliationFailed;
            _lastError = DutyControllerError(
              code: 'NATIVE_STOP_FAILED',
              message: e.toString(),
              cleanupErrorCode: 'NATIVE_STOP_FAILED',
              cleanupErrorMessage: e.toString(),
              cleanupRequired: true,
            );
          }
          return;
        }

        // Server is ON from here on.
        // Startup Matrix Case 10: native owner belongs to different authenticated UID
        if (effectiveRecord != null &&
            effectiveRecord.uid != effectiveProfile.uid) {
          try {
            await locationService.stopForegroundService(
              expectedUid: effectiveRecord.uid,
              expectedSessionId: effectiveRecord.sessionId,
              expectedGeneration: effectiveRecord.generation,
              expectedLifecycleSeq: effectiveRecord.lifecycleSeq,
            );
          } catch (_) {}
          if (!ownsAttempt()) return;
          _authoritativeDutyState = AuthoritativeDutyState.onDuty;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _errorCategory = HubErrorCategory.reconciliationFailed;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return;
        }

        // Profile says isOnDuty == true in Firestore, but profile is NOT approved:
        if (!effectiveProfile.isApproved) {
          // Reconstruction can leave volatile adoption empty while an exact
          // durable native owner still needs cleanup. Keep cleanup authority
          // separate from healthy adopted authority.
          final cleanupSession = effectiveRecord != null
              ? DutySession(
                  uid: effectiveRecord.uid,
                  sessionId: effectiveRecord.sessionId,
                  generation: effectiveRecord.generation,
                  lifecycleSeq: effectiveRecord.lifecycleSeq,
                )
              : _activeSession;
          var serverEnded = false;
          try {
            await locationService.endDutySessionCall(
              uid: effectiveProfile.uid,
              sessionId: effectiveProfile.activeDutySessionId!,
              generation: effectiveProfile.dutyGeneration,
              lifecycleSeq: effectiveProfile.lifecycleSeq,
            );
            if (!ownsAttempt()) return;
            serverEnded = true;
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _pendingCleanupSession = cleanupSession;
            _residualCleanupRequired = true;
            if (cleanupSession != null) {
              if (cleanupSession.lifecycleSeq == null ||
                  cleanupSession.lifecycleSeq! <= 0) {
                throw StateError(
                  'Native cleanup requires exact lifecycle authority',
                );
              }
              await locationService.stopForegroundService(
                expectedUid: cleanupSession.uid,
                expectedSessionId: cleanupSession.sessionId,
                expectedGeneration: cleanupSession.generation,
                expectedLifecycleSeq: cleanupSession.lifecycleSeq,
              );
              if (!ownsAttempt()) return;
            }
            // STOP completion is not absence, including when exact fencing
            // preserved a replacement owner. Never collapse that residue to OFF.
            final absent = await _isNativeAbsent(ownsAttempt: ownsAttempt);
            if (!ownsAttempt()) return;
            if (!absent) {
              throw StateError('Native residue still present after server end');
            }
            _activeSession = null;
            _activeLifecycleSeq = null;
            _pendingCleanupSession = null;
            _residualCleanupRequired = false;
            _lastError = null;
            _errorCategory = null;
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.off;
            return;
          } catch (e) {
            if (!ownsAttempt()) return;
            if (serverEnded) {
              _pendingCleanupSession = cleanupSession;
              _residualCleanupRequired = true;
              _lastError = DutyControllerError(
                code: 'NATIVE_STOP_FAILED',
                message: e.toString(),
                cleanupErrorCode: 'NATIVE_STOP_FAILED',
                cleanupErrorMessage: e.toString(),
                cleanupRequired: true,
              );
            }
            _authoritativeDutyState = serverEnded
                ? AuthoritativeDutyState.offDuty
                : AuthoritativeDutyState.onDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _errorCategory = HubErrorCategory.reconciliationFailed;
            return;
          }
        }

        // Check prerequisites using the SAME rule as startup
        final serviceEnabled = await locationService.isLocationServiceEnabled();
        if (!ownsAttempt()) return;

        final fgPermission = await locationService.checkPermission();
        if (!ownsAttempt()) return;

        final bgPermission = await locationService
            .requestBackgroundPermission();
        if (!ownsAttempt()) return;

        final hasValidPermissions =
            serviceEnabled &&
            fgPermission == LocationPermissionStatus.granted &&
            bgPermission == LocationPermissionStatus.granted;

        if (!hasValidPermissions) {
          if (effectiveProfile.hasActiveJob) {
            // Cannot turn off duty while engaged in active job
            _authoritativeDutyState = AuthoritativeDutyState.onDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            if (!serviceEnabled) {
              _errorCategory = HubErrorCategory.servicesDisabled;
            } else if (fgPermission == LocationPermissionStatus.deniedForever) {
              _errorCategory =
                  HubErrorCategory.foregroundPermissionDeniedForever;
            } else if (bgPermission == LocationPermissionStatus.denied ||
                bgPermission == LocationPermissionStatus.deniedForever) {
              _errorCategory = HubErrorCategory.backgroundPermissionDenied;
            } else {
              _errorCategory = HubErrorCategory.foregroundPermissionDenied;
            }
            return;
          }

          // Capture immutable native authority before END or any replacement.
          final cleanupSession =
              _activeSession ??
              (effectiveRecord == null
                  ? durableSession
                  : DutySession(
                      uid: effectiveRecord.uid,
                      sessionId: effectiveRecord.sessionId,
                      generation: effectiveRecord.generation,
                      lifecycleSeq: effectiveRecord.lifecycleSeq,
                    ));
          var serverEnded = false;
          try {
            await locationService.endDutySessionCall(
              uid: effectiveProfile.uid,
              sessionId: effectiveProfile.activeDutySessionId!,
              generation: effectiveProfile.dutyGeneration,
              lifecycleSeq: effectiveProfile.lifecycleSeq,
            );
            if (!ownsAttempt()) return;
            serverEnded = true;
            _authoritativeDutyState = AuthoritativeDutyState.offDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _pendingCleanupSession = cleanupSession;
            _residualCleanupRequired = true;
            _activeSession = null;
            _activeLifecycleSeq = null;
            if (cleanupSession != null) {
              if (cleanupSession.lifecycleSeq == null ||
                  cleanupSession.lifecycleSeq! <= 0) {
                throw StateError(
                  'Native cleanup requires exact lifecycle authority',
                );
              }
              await locationService.stopForegroundService(
                expectedUid: cleanupSession.uid,
                expectedSessionId: cleanupSession.sessionId,
                expectedGeneration: cleanupSession.generation,
                expectedLifecycleSeq: cleanupSession.lifecycleSeq,
              );
              if (!ownsAttempt()) return;
            }
            final absent = await _isNativeAbsent(ownsAttempt: ownsAttempt);
            if (!ownsAttempt()) return;
            if (!absent) {
              throw StateError(
                'Native residue still present after permission-loss teardown',
              );
            }
            _pendingCleanupSession = null;
            _residualCleanupRequired = false;
            _lastError = null;
            _trackingHealth = TrackingHealth.off;
            if (!serviceEnabled) {
              _errorCategory = HubErrorCategory.servicesDisabled;
            } else if (fgPermission == LocationPermissionStatus.deniedForever) {
              _errorCategory =
                  HubErrorCategory.foregroundPermissionDeniedForever;
            } else if (bgPermission == LocationPermissionStatus.denied ||
                bgPermission == LocationPermissionStatus.deniedForever) {
              _errorCategory = HubErrorCategory.backgroundPermissionDenied;
            } else {
              _errorCategory = HubErrorCategory.foregroundPermissionDenied;
            }
          } catch (error) {
            if (!ownsAttempt()) return;
            // END failure never authorizes native STOP. Once END succeeded,
            // retain the exact selector until a retry positively proves absence.
            if (serverEnded) {
              _pendingCleanupSession = cleanupSession;
              _residualCleanupRequired = true;
              _lastError = DutyControllerError(
                code: 'NATIVE_STOP_FAILED',
                message: error.toString(),
                cleanupErrorCode: 'NATIVE_STOP_FAILED',
                cleanupErrorMessage: error.toString(),
                cleanupRequired: true,
              );
            }
            _authoritativeDutyState = serverEnded
                ? AuthoritativeDutyState.offDuty
                : AuthoritativeDutyState.onDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _errorCategory = HubErrorCategory.reconciliationFailed;
          }
          return;
        }

        // Startup Matrix Case 3: Server ON + exact matching native owner/service
        // Match exact 4 fields: (uid, sessionId, generation, lifecycleSeq)
        if (isRunning && effectiveRecord != null) {
          final isUidMatch = effectiveRecord.uid == effectiveProfile.uid;
          final isSidMatch =
              effectiveProfile.activeDutySessionId != null &&
              effectiveRecord.sessionId == effectiveProfile.activeDutySessionId;
          final isGenMatch =
              effectiveProfile.dutyGeneration != null &&
              effectiveRecord.generation == effectiveProfile.dutyGeneration;
          final isSeqMatch =
              effectiveProfile.lifecycleSeq != null &&
              effectiveProfile.lifecycleSeq! > 0 &&
              effectiveRecord.lifecycleSeq == effectiveProfile.lifecycleSeq;

          if (isUidMatch && isSidMatch && isGenMatch && isSeqMatch) {
            // Outcome B & D: Exact 4-field match confirmed -> Adopt current epoch
            final adoptedSession = DutySession(
              uid: effectiveRecord.uid,
              sessionId: effectiveRecord.sessionId,
              generation: effectiveRecord.generation,
              lifecycleSeq: effectiveRecord.lifecycleSeq,
              notificationTitle:
                  effectiveRecord.notificationTitle ?? _cachedNotificationTitle,
              notificationText:
                  effectiveRecord.notificationText ?? _cachedNotificationText,
              locale: effectiveRecord.locale ?? _cachedLocale,
            );
            _activeSession = adoptedSession;
            _activeLifecycleSeq = effectiveRecord.lifecycleSeq;
            if (effectiveRecord.notificationTitle != null) {
              _cachedNotificationTitle = effectiveRecord.notificationTitle;
            }
            if (effectiveRecord.notificationText != null) {
              _cachedNotificationText = effectiveRecord.notificationText;
            }
            if (effectiveRecord.locale != null) {
              _cachedLocale = effectiveRecord.locale;
            }
            _authoritativeDutyState = AuthoritativeDutyState.onDuty;

            // When native worker is confirmed running with matching 4-tuple and valid permissions:
            // bootstrap is confirmed. Only mark healthy/READY if effectiveProfile.workerReady is literally true!
            // Never fabricate workerReady: true.
            if (effectiveProfile.workerReady == true) {
              _currentProfile = effectiveProfile;
              _trackingHealth = TrackingHealth.healthy;
            } else {
              _currentProfile = effectiveProfile;
              _trackingHealth = TrackingHealth.starting;
            }
            _pendingCleanupSession = null;
            return;
          }

          // If fresh server state still has null/missing lifecycleSeq while on duty,
          // do NOT adopt as exact active worker, do NOT mark READY, but do NOT destructively stop the native worker!
          if (isUidMatch &&
              (effectiveProfile.lifecycleSeq == null ||
                  effectiveProfile.lifecycleSeq! <= 0)) {
            _authoritativeDutyState = AuthoritativeDutyState.onDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _errorCategory = HubErrorCategory.reconciliationFailed;
            _activeSession = null;
            _activeLifecycleSeq = null;
            _currentProfile = effectiveProfile;
            return;
          }

          // Also, if native worker has a NEWER lifecycle sequence than the server,
          // do NOT stop the newer native worker!
          if (isUidMatch &&
              ((effectiveProfile.dutyGeneration != null &&
                      effectiveRecord.generation >
                          effectiveProfile.dutyGeneration!) ||
                  (isSidMatch &&
                      effectiveProfile.lifecycleSeq != null &&
                      effectiveRecord.lifecycleSeq >
                          effectiveProfile.lifecycleSeq!))) {
            _authoritativeDutyState = AuthoritativeDutyState.onDuty;
            _trackingHealth = TrackingHealth.reconciliationFailed;
            _errorCategory = HubErrorCategory.reconciliationFailed;
            _activeSession = null;
            _activeLifecycleSeq = null;
            _currentProfile = effectiveProfile;
            return;
          }

          // Outcome A: Fresh server confirmed native is genuinely stale (or generation/lifecycleSeq mismatch)
          // Safe exact stale cleanup using effectiveRecord's exact epoch:
          try {
            await locationService.stopForegroundService(
              expectedUid: effectiveRecord.uid,
              expectedSessionId: effectiveRecord.sessionId,
              expectedGeneration: effectiveRecord.generation,
              expectedLifecycleSeq: effectiveRecord.lifecycleSeq,
            );
          } catch (_) {}
          if (!ownsAttempt()) return;

          _authoritativeDutyState = AuthoritativeDutyState.onDuty;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _errorCategory = HubErrorCategory.reconciliationFailed;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return;
        }

        // Startup Matrix Case 9: durable owner exists but service is not running
        if (!isRunning && effectiveRecord != null) {
          _authoritativeDutyState = AuthoritativeDutyState.onDuty;
          _trackingHealth = TrackingHealth.reconciliationFailed;
          _errorCategory = HubErrorCategory.reconciliationFailed;
          _activeSession = null;
          _activeLifecycleSeq = null;
          return;
        }

        // Startup Matrix Case 7: Server ON + no native authority + active job
        if (effectiveProfile.hasActiveJob) {
          final sourceSessionId = effectiveProfile.activeDutySessionId;
          final sourceGen = effectiveProfile.dutyGeneration;
          final sourceSeq = effectiveProfile.lifecycleSeq;
          final sourceJobId = effectiveProfile.activeJobId;
          if (sourceSessionId != null &&
              sourceGen != null &&
              sourceSeq != null &&
              sourceJobId != null) {
            try {
              final rec = await locationService.recoverActiveJobSessionCall(
                uid: effectiveProfile.uid,
                activeDutySessionId: sourceSessionId,
                dutyGeneration: sourceGen,
                lifecycleSeq: sourceSeq,
                expectedActiveJobId: sourceJobId,
              );
              if (!ownsAttempt()) return;
              final recSessionId = rec['sessionId'];
              final recGen = rec['dutyGeneration'];
              final recStatus = rec['status'];

              final bool isResponseValid =
                  recStatus is String &&
                  (recStatus == 'recovered' ||
                      recStatus == 'already_recovered') &&
                  recSessionId is String &&
                  recSessionId.trim().isNotEmpty &&
                  recSessionId == recSessionId.trim() &&
                  recGen is int &&
                  recGen > 0;

              if (isResponseValid) {
                if (!ownsAttempt()) return;

                Map<String, dynamic>? serverState;
                try {
                  serverState = await locationService.fetchServerDriverState(
                    effectiveProfile.uid,
                  );
                } catch (_) {
                  serverState = null;
                }
                if (!ownsAttempt()) return;

                final bool isServerAuthorityMatching =
                    serverState != null &&
                    serverState['isOnDuty'] == true &&
                    serverState['activeDutySessionId'] == recSessionId &&
                    serverState['dutyGeneration'] == recGen &&
                    serverState['activeJobId'] == sourceJobId &&
                    serverState['workerReady'] == false &&
                    serverState['lifecycleSeq'] == null;

                if (isServerAuthorityMatching) {
                  final recSession = DutySession(
                    uid: effectiveProfile.uid,
                    sessionId: recSessionId,
                    generation: recGen,
                    lifecycleSeq: 1,
                    notificationTitle: _cachedNotificationTitle,
                    notificationText: _cachedNotificationText,
                    locale: _cachedLocale,
                  );
                  if (!ownsAttempt()) return;
                  DutySession? exactStartAuthority;
                  bool started = false;
                  try {
                    started = await locationService.startForegroundService(
                      session: recSession,
                      onAuthorityAllocated: (authority) =>
                          exactStartAuthority = authority,
                    );
                  } catch (_) {
                    if (!ownsAttempt()) {
                      await compensateStaleStart(exactStartAuthority);
                      return;
                    }
                    rethrow;
                  }
                  if (!ownsAttempt()) {
                    await compensateStaleStart(exactStartAuthority);
                    return;
                  }
                  if (started) {
                    final nativeAuthority = exactStartAuthority!;
                    _activeSession = nativeAuthority;
                    _activeLifecycleSeq = nativeAuthority.lifecycleSeq;
                    _authoritativeDutyState = AuthoritativeDutyState.onDuty;
                    _trackingHealth = TrackingHealth.starting;
                    return;
                  }
                }
              }
            } catch (_) {}
            if (!ownsAttempt()) return;
          }
        }

        // Resume active session held by controller if applicable
        if (_activeSession != null) {
          final session = _activeSession!;
          if (!ownsAttempt()) return;
          DutySession? exactStartAuthority;
          bool started = false;
          try {
            started = await locationService.startForegroundService(
              session: session,
              notificationTitle:
                  session.notificationTitle ?? _cachedNotificationTitle,
              notificationText:
                  session.notificationText ?? _cachedNotificationText,
              onAuthorityAllocated: (authority) =>
                  exactStartAuthority = authority,
            );
          } catch (_) {
            if (!ownsAttempt()) {
              await compensateStaleStart(exactStartAuthority);
              return;
            }
            rethrow;
          }
          if (!ownsAttempt()) {
            await compensateStaleStart(exactStartAuthority);
            return;
          }
          if (started) {
            final nativeAuthority = exactStartAuthority!;
            _activeSession = nativeAuthority;
            _activeLifecycleSeq = nativeAuthority.lifecycleSeq;
            _authoritativeDutyState = AuthoritativeDutyState.onDuty;
            final activeSeq = nativeAuthority.lifecycleSeq;
            if (effectiveProfile.workerReady == true &&
                effectiveProfile.activeDutySessionId ==
                    nativeAuthority.sessionId &&
                effectiveProfile.dutyGeneration == nativeAuthority.generation &&
                (activeSeq != null &&
                    effectiveProfile.lifecycleSeq == activeSeq)) {
              _trackingHealth = TrackingHealth.healthy;
            } else {
              _trackingHealth = TrackingHealth.starting;
            }
            return;
          }
        }

        // Startup Matrix Case 8: Server ON + no native authority + no recoverable active job:
        _authoritativeDutyState = AuthoritativeDutyState.onDuty;
        _trackingHealth = TrackingHealth.reconciliationFailed;
        _errorCategory = HubErrorCategory.reconciliationFailed;
        _activeSession = null;
        _activeLifecycleSeq = null;
      } finally {
        if (_isTokenActive(token)) {
          _isReconciling = false;
          _winningToken = ControllerOperationToken(
            id: 0,
            intent: ControllerIntent.idle,
            uid: _boundUid ?? '',
          );
          _safeNotifyListeners();
        }
      }
    });
  }

  @override
  void dispose() {
    _isDisposed = true;
    _authSubscription?.cancel();
    locationService.dispose();
    super.dispose();
  }
}
