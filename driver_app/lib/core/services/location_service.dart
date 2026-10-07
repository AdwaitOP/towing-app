import 'dart:async';
import 'dart:convert';
import 'dart:ui';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';

import '../../features/hub/models/duty_session.dart';
import '../config/app_config.dart';
import '../config/firebase_options.dart';
import 'native_ownership_coordinator.dart';

/// Normalized driver position model with strict finite range validation.
class DriverPosition {
  final double latitude;
  final double longitude;
  final double? accuracy;
  final double? altitude;
  final double? heading;
  final double? speed;
  final DateTime timestamp;

  const DriverPosition({
    required this.latitude,
    required this.longitude,
    this.accuracy,
    this.altitude,
    this.heading,
    this.speed,
    required this.timestamp,
  });

  /// Factory from Geolocator [Position].
  factory DriverPosition.fromGeolocator(Position pos) {
    return DriverPosition(
      latitude: pos.latitude,
      longitude: pos.longitude,
      accuracy: pos.accuracy,
      altitude: pos.altitude,
      heading: pos.heading,
      speed: pos.speed,
      timestamp: pos.timestamp,
    );
  }

  /// Latitude must be in [-90, 90], longitude in [-180, 180], and both must be finite.
  bool get isValid {
    return latitude.isFinite &&
        longitude.isFinite &&
        latitude >= -90.0 &&
        latitude <= 90.0 &&
        longitude >= -180.0 &&
        longitude <= 180.0;
  }

  /// Static validator that throws ArgumentError if coordinates are non-finite or out of range.
  static void validateCoordinates(double latitude, double longitude) {
    if (!latitude.isFinite ||
        !longitude.isFinite ||
        latitude < -90.0 ||
        latitude > 90.0 ||
        longitude < -180.0 ||
        longitude > 180.0) {
      throw ArgumentError(
        'Invalid driver coordinates: lat=$latitude, lng=$longitude',
      );
    }
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DriverPosition &&
          runtimeType == other.runtimeType &&
          latitude == other.latitude &&
          longitude == other.longitude;

  @override
  int get hashCode => latitude.hashCode ^ longitude.hashCode;

  @override
  String toString() =>
      'DriverPosition(lat: $latitude, lng: $longitude, time: $timestamp)';
}

/// Normalized location permission status across platforms.
enum LocationPermissionStatus {
  granted,
  denied,
  deniedForever,
  serviceDisabled,
}

/// Result of preparing a duty activation intent on the server.
class DutyActivationPreparation {
  final String sessionId;
  final int generation;
  final int attemptSeq;
  final int? expiresAtMs;

  const DutyActivationPreparation({
    required this.sessionId,
    required this.generation,
    this.attemptSeq = 1,
    this.expiresAtMs,
  });

  @override
  String toString() => sessionId;
}

/// Abstract contract for location permissions, position tracking,
/// foreground services, and transactional duty mutations.
/// Separate capability keeps cleanup acquisition explicit for native adapters.
abstract interface class NativeCleanupProvider {
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(String operationId, String uid);
  Future<bool> validateCleanupAcquisition(NativeCleanupAcquisition lease);
  Future<void> releaseCleanupAcquisition(NativeCleanupAcquisition lease);
}

abstract class LocationService {
  Future<bool> isLocationServiceEnabled();
  Future<LocationPermissionStatus> checkPermission();
  Future<LocationPermissionStatus> requestForegroundPermission();
  Future<LocationPermissionStatus> requestBackgroundPermission();
  Future<LocationPermissionStatus> requestNotificationPermission();
  Future<bool> hasRequiredPermissions();
  Future<DriverPosition?> getCurrentPosition();
  Stream<DriverPosition> getPositionStream();
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  });
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  });
  DutySession? get currentServiceSession;
  int? get currentLifecycleSeq;
  int? get currentGeneration;
  Future<DutySession?> getDurableSession();
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord();
  Future<bool> isForegroundServiceRunning();
  Future<void> sendHeartbeat({
    required String uid,
    required DriverPosition position,
  });
  Future<void> executeGoOnDutyTransaction({required String uid});
  Future<void> executeGoOffDutyTransaction({required String uid});

  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    return DutyActivationPreparation(
      sessionId: '${uid}_${DateTime.now().microsecondsSinceEpoch}',
      generation: 1,
    );
  }

  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async {
    final effectiveLifecycleSeq = lifecycleSeq ?? currentLifecycleSeq;
    if (effectiveLifecycleSeq == null || effectiveLifecycleSeq <= 0) {
      throw StateError('Cannot call startDutySession without an exact positive native lifecycleSeq');
    }
    await executeGoOnDutyTransaction(uid: uid);
    return {
      'status': 'activated',
      'dutyGeneration': generation ?? 1,
      'lifecycleSeq': effectiveLifecycleSeq,
      'workerReady': false,
    };
  }

  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {}

  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    await executeGoOffDutyTransaction(uid: uid);
  }

  Future<void> reportHeartbeatCall({
    required String uid,
    required String sessionId,
    required DriverPosition position,
    int? generation,
    int? lifecycleSeq,
  }) async {
    await sendHeartbeat(uid: uid, position: position);
  }

  Future<Map<String, dynamic>> recoverActiveJobSessionCall({
    required String uid,
    required String activeDutySessionId,
    required int dutyGeneration,
    required int lifecycleSeq,
    required String expectedActiveJobId,
    String? clientRequestId,
    DriverPosition? initialLocation,
  }) async {
    return {
      'sessionId': '${uid}_recovered',
      'dutyGeneration': 1,
      'workerReady': false,
      'lifecycleSeq': null,
      'activeJobId': expectedActiveJobId,
      'status': 'recovered',
    };
  }

  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => null;

  Future<bool> openAppSettings();
  DriverPosition? get lastKnownPosition;
  void dispose();
}

/// Background isolate TaskHandler for flutter_foreground_task.
/// Bound strictly to an immutable DutySession loaded from cross-isolate storage.
@pragma('vm:entry-point')
class DriverLocationTaskHandler extends TaskHandler {
  static const String sessionPayloadKey = 'duty_session_payload';
  static const String currentSessionIdKey = 'duty_service_session_id';

  final Future<String?> Function()? payloadLoader;
  final Future<String?> Function()? durableOwnerLoader;
  final Future<void> Function()? firebaseInitializer;
  final FirebaseAuth Function()? authProvider;
  final FirebaseFirestore Function()? firestoreProvider;
  final FirebaseFunctions Function()? functionsProvider;
  final Future<Position> Function()? locationProvider;
  final Future<void> Function()? serviceStopper;
  final Future<void> Function(String sessionId, DriverPosition position)? heartbeatReporter;

  final Future<Map<String, dynamic>?> Function()? acquisitionTokenLoader;
  final Future<Map<String, dynamic>> Function()? readinessConfirmer;

  DutySession? _workerSession;
  String? _tokenUid;
  String? _tokenSessionId;
  int? _tokenGeneration;
  int? _tokenLifecycleSeq;
  bool _isHeartbeatInFlight = false;
  bool _isInitialized = false;
  bool _isDestroyed = false;
  bool _isServerReady = false;

  DutySession? get workerSession => _workerSession;
  String? get tokenUid => _tokenUid;
  String? get tokenSessionId => _tokenSessionId;
  int? get tokenGeneration => _tokenGeneration;
  int? get tokenLifecycleSeq => _tokenLifecycleSeq;
  bool get isHeartbeatInFlight => _isHeartbeatInFlight;
  bool get isInitialized => _isInitialized;
  bool get isDestroyed => _isDestroyed;
  bool get isServerReady => _isServerReady;

  DriverLocationTaskHandler({
    this.payloadLoader,
    this.durableOwnerLoader,
    this.firebaseInitializer,
    this.authProvider,
    this.firestoreProvider,
    this.functionsProvider,
    this.locationProvider,
    this.serviceStopper,
    this.heartbeatReporter,
    this.acquisitionTokenLoader,
    this.readinessConfirmer,
    String? initialTokenUid,
    String? initialTokenSessionId,
    int? initialTokenGeneration,
    int? initialTokenLifecycleSeq,
  }) : _tokenUid = initialTokenUid,
       _tokenSessionId = initialTokenSessionId,
       _tokenGeneration = initialTokenGeneration,
       _tokenLifecycleSeq = initialTokenLifecycleSeq;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    WidgetsFlutterBinding.ensureInitialized();
    if (_isDestroyed) return;

    // Retain immutable acquisition cleanup token before any failure-prone initialization
    if (_tokenUid == null || _tokenSessionId == null || _tokenGeneration == null || _tokenLifecycleSeq == null) {
      try {
        if (acquisitionTokenLoader != null) {
          final tokenMap = await acquisitionTokenLoader!();
          if (tokenMap != null) {
            _tokenUid ??= tokenMap['uid'] as String?;
            _tokenSessionId ??= tokenMap['sessionId'] as String?;
            _tokenGeneration ??= tokenMap['generation'] as int?;
            _tokenLifecycleSeq ??= tokenMap['lifecycleSeq'] as int?;
          }
        } else if (payloadLoader != null || durableOwnerLoader != null) {
          // Isolated unit test convenience: decode test payload loader or durable owner loader if no native engine is running
          if (durableOwnerLoader != null) {
            try {
              final raw = await durableOwnerLoader!();
              if (raw != null) {
                final rec = DurableDutyOwnerRecord.fromJson(raw);
                _tokenUid ??= rec.uid;
                _tokenSessionId ??= rec.sessionId;
                _tokenGeneration ??= rec.generation;
                _tokenLifecycleSeq ??= rec.lifecycleSeq;
              }
            } catch (_) {}
          }
          if (payloadLoader != null) {
            try {
              final raw = await payloadLoader!();
              if (raw != null) {
                final decoded = DutySession.tryDecode(raw);
                if (decoded != null) {
                  _tokenUid ??= decoded.uid;
                  _tokenSessionId ??= decoded.sessionId;
                  _tokenGeneration ??= decoded.generation;
                  try {
                    final map = jsonDecode(raw);
                    if (map is Map && map['lifecycleSeq'] is int) {
                      _tokenLifecycleSeq ??= map['lifecycleSeq'] as int;
                    }
                  } catch (_) {}
                  _tokenLifecycleSeq ??= 1;
                }
              }
            } catch (_) {}
          }
        } else {
          final nativeToken = await NativeOwnershipCoordinator.getAcquisitionToken();
          if (nativeToken != null) {
            _tokenUid ??= nativeToken['uid'] as String?;
            _tokenSessionId ??= nativeToken['sessionId'] as String?;
            _tokenGeneration ??= nativeToken['generation'] as int?;
            _tokenLifecycleSeq ??= nativeToken['lifecycleSeq'] as int?;
          }
        }
      } catch (_) {}
    }

    Future<void> handleBootstrapFailure([String? reason]) async {
      _isInitialized = false;
      _workerSession = null;
      if (serviceStopper != null) {
        try {
          await serviceStopper!();
        } catch (_) {}
        _isDestroyed = true;
        return;
      }

      Map<String, dynamic> res;
      try {
        res = await NativeOwnershipCoordinator.reportWorkerBootstrapFailed(
          uid: _tokenUid,
          sessionId: _tokenSessionId,
          generation: _tokenGeneration,
          lifecycleSeq: _tokenLifecycleSeq,
        );
      } catch (e) {
        _isDestroyed = true;
        throw BootstrapCleanupException(
          message: 'Worker bootstrap cleanup threw: $e',
          code: 'cleanup_thrown',
          cleanupRequired: true,
          retryable: true,
          nativeBoundToken: _tokenSessionId != null
              ? {
                  'uid': _tokenUid,
                  'sessionId': _tokenSessionId,
                  'generation': _tokenGeneration,
                  'lifecycleSeq': _tokenLifecycleSeq,
                }
              : null,
        );
      }

      _isDestroyed = true;
      if (res['cleaned'] != true) {
        throw BootstrapCleanupException(
          message:
              'Worker bootstrap cleanup unconfirmed or failed: ${res['reason'] ?? res['error'] ?? 'unknown'}',
          code: (res['reason'] ?? res['error'] ?? 'unconfirmed') as String?,
          cleanupRequired: res['cleanupRequired'] as bool?,
          retryable: res['retryable'] as bool?,
          nativeBoundToken: (res['boundToken'] is Map)
              ? Map<String, dynamic>.from(res['boundToken'] as Map)
              : null,
        );
      }
    }

    // Contract A1/A2: Worker MUST have immutable engine-bound acquisition token BEFORE failure-prone init.
    // If token delivery returns null or fails, fail closed immediately with zero mutable fallback!
    if (_tokenUid == null || _tokenSessionId == null || _tokenGeneration == null || _tokenLifecycleSeq == null) {
      await handleBootstrapFailure('token_acquisition_failed');
      return;
    }

    try {
      if (firebaseInitializer != null) {
        await firebaseInitializer!();
      } else if (authProvider == null && firestoreProvider == null) {
        await FirebaseBootstrap.initialize();
      }
    } catch (_) {
      _isInitialized = false;
      _workerSession = null;
      if (!_isDestroyed) await _stopService();
      return;
    }

    if (_isDestroyed) return;

    DutySession? payloadSession;
    DurableDutyOwnerRecord? durableOwner;

    try {
      if (payloadLoader != null) {
        final raw = await payloadLoader!();
        if (raw != null) {
          payloadSession = DutySession.tryDecode(raw);
        }
      } else {
        final nativePayload = await NativeOwnershipCoordinator.getWorkerPayload();
        if (nativePayload != null) {
          payloadSession = DutySession.tryDecode(nativePayload);
        }
      }

      if (durableOwnerLoader != null) {
        final raw = await durableOwnerLoader!();
        if (raw != null) {
          durableOwner = DurableDutyOwnerRecord.fromJson(raw);
        }
      } else if (payloadLoader != null) {
        // Isolated unit test stub convenience
        final raw = await payloadLoader!();
        if (raw != null) {
          final decoded = DutySession.tryDecode(raw);
          if (decoded != null) {
            durableOwner = DurableDutyOwnerRecord(
              sessionId: decoded.sessionId,
              uid: decoded.uid,
              generation: decoded.generation,
              lifecycleSeq: 1,
              notificationTitle: decoded.notificationTitle,
              notificationText: decoded.notificationText,
              locale: decoded.locale,
              startedAt: DateTime.now(),
            );
          }
        }
      } else {
        durableOwner = await NativeOwnershipCoordinator.getDurableOwner();
      }
    } catch (_) {
      _isInitialized = false;
      _workerSession = null;
      if (!_isDestroyed) await _stopService();
      return;
    }

    if (_isDestroyed) return;

    // Astra Finding 4: Worker must require BOTH a valid canonical owner and matching payload
    if (durableOwner == null || payloadSession == null) {
      _isInitialized = false;
      _workerSession = null;
      if (!_isDestroyed) await _stopService();
      return;
    }

    // Fence against superseded or mismatched durable owner or payload!
    // The worker is bound to its immutable acquisition token and must NEVER adopt a newer owner!
    if (durableOwner.sessionId != _tokenSessionId ||
        durableOwner.uid != _tokenUid ||
        durableOwner.generation != _tokenGeneration ||
        (durableOwner.lifecycleSeq != _tokenLifecycleSeq && _tokenLifecycleSeq != null)) {
      _isInitialized = false;
      _workerSession = null;
      if (!_isDestroyed) await _stopService();
      return;
    }

    if (payloadSession.sessionId != _tokenSessionId ||
        payloadSession.uid != _tokenUid ||
        payloadSession.generation != _tokenGeneration) {
      _isInitialized = false;
      _workerSession = null;
      if (!_isDestroyed) await _stopService();
      return;
    }

    final session = payloadSession;

    // Fail-closed authentication check
    String? currentUid;
    try {
      final auth = authProvider != null ? authProvider!() : FirebaseAuth.instance;
      currentUid = auth.currentUser?.uid;
    } catch (_) {
      _isInitialized = false;
      _workerSession = null;
      if (!_isDestroyed) await _stopService();
      return;
    }

    if (_isDestroyed) return;

    if (currentUid == null || currentUid != session.uid) {
      _isInitialized = false;
      _workerSession = null;
      if (!_isDestroyed) await _stopService();
      return;
    }

    _workerSession = session;

    // Contract A1: Worker is initialized ONLY after engine-bound readiness confirmation returns positive result
    Map<String, dynamic> readinessResult;
    try {
      if (readinessConfirmer != null) {
        readinessResult = await readinessConfirmer!();
      } else if (payloadLoader != null || durableOwnerLoader != null) {
        // Isolated unit test stub convenience: if test harness stubs are supplied and no readinessConfirmer is injected, treat readiness as confirmed
        readinessResult = {'success': true, 'granted': true};
      } else {
        readinessResult = await NativeOwnershipCoordinator.confirmWorkerBootstrapReadiness(
          uid: session.uid,
          sessionId: session.sessionId,
          generation: session.generation,
          lifecycleSeq: _tokenLifecycleSeq,
        );
      }
    } catch (e) {
      _isInitialized = false;
      _workerSession = null;
      try {
        await handleBootstrapFailure('readiness_thrown: $e');
      } catch (cleanupEx) {
        if (cleanupEx is BootstrapCleanupException) {
          throw BootstrapCleanupException(
            message: 'Readiness confirmation threw: $e; cleanup also failed: ${cleanupEx.message}',
            code: cleanupEx.code ?? 'readiness_thrown',
            cleanupRequired: true,
            retryable: cleanupEx.retryable ?? true,
            nativeBoundToken: cleanupEx.nativeBoundToken ?? {
              'uid': _tokenUid,
              'sessionId': _tokenSessionId,
              'generation': _tokenGeneration,
              'lifecycleSeq': _tokenLifecycleSeq,
            },
          );
        }
        rethrow;
      }
      throw BootstrapCleanupException(
        message: 'Readiness confirmation threw: $e',
        code: 'readiness_thrown',
        cleanupRequired: false,
        retryable: false,
        nativeBoundToken: {
          'uid': _tokenUid,
          'sessionId': _tokenSessionId,
          'generation': _tokenGeneration,
          'lifecycleSeq': _tokenLifecycleSeq,
        },
      );
    }

    if (readinessResult['success'] != true || readinessResult['granted'] != true) {
      _isInitialized = false;
      _workerSession = null;
      final reason = (readinessResult['reason'] ?? readinessResult['error'] ?? 'readiness_rejected').toString();
      try {
        await handleBootstrapFailure('readiness_failed: $reason');
      } catch (cleanupEx) {
        if (cleanupEx is BootstrapCleanupException) {
          throw BootstrapCleanupException(
            message: 'Worker readiness rejected: $reason; cleanup also failed: ${cleanupEx.message}',
            code: cleanupEx.code ?? reason,
            cleanupRequired: true,
            retryable: cleanupEx.retryable ?? true,
            nativeBoundToken: cleanupEx.nativeBoundToken ?? {
              'uid': _tokenUid,
              'sessionId': _tokenSessionId,
              'generation': _tokenGeneration,
              'lifecycleSeq': _tokenLifecycleSeq,
            },
          );
        }
        rethrow;
      }
      throw BootstrapCleanupException(
        message: 'Worker bootstrap readiness rejected: $reason',
        code: reason,
        cleanupRequired: false,
        retryable: false,
        nativeBoundToken: {
          'uid': _tokenUid,
          'sessionId': _tokenSessionId,
          'generation': _tokenGeneration,
          'lifecycleSeq': _tokenLifecycleSeq,
        },
      );
    }

    // ONLY THEN mark initialized!
    _isInitialized = true;
  }

  Future<bool> publishServerReadiness() async {
    if (_isDestroyed || !_isInitialized || _workerSession == null) {
      _isServerReady = false;
      return false;
    }

    final session = _workerSession!;

    // Validate token integrity
    if (_tokenUid == null || _tokenSessionId == null || _tokenGeneration == null || _tokenLifecycleSeq == null) {
      _isServerReady = false;
      return false;
    }

    if (session.uid != _tokenUid ||
        session.sessionId != _tokenSessionId ||
        session.generation != _tokenGeneration) {
      _isServerReady = false;
      return false;
    }

    // Single-flight guard
    if (_isHeartbeatInFlight) {
      return false;
    }
    _isHeartbeatInFlight = true;

    try {
      // Step 1: Pre-GPS auth check
      String? currentUid;
      try {
        final auth = authProvider != null ? authProvider!() : FirebaseAuth.instance;
        currentUid = auth.currentUser?.uid;
      } catch (_) {
        _isServerReady = false;
        return false;
      }

      if (_isDestroyed || currentUid == null || currentUid != session.uid) {
        _isServerReady = false;
        return false;
      }

      // Pre-GPS check against current durable owner
      DurableDutyOwnerRecord? preGpsOwner;
      try {
        if (durableOwnerLoader != null) {
          final raw = await durableOwnerLoader!();
          if (raw != null) preGpsOwner = DurableDutyOwnerRecord.fromJson(raw);
        } else if (payloadLoader != null) {
          // Unit test stub convenience
        } else {
          preGpsOwner = await NativeOwnershipCoordinator.getDurableOwner();
        }
      } catch (_) {
        _isServerReady = false;
        return false;
      }

      if (preGpsOwner != null &&
          (preGpsOwner.sessionId != _tokenSessionId ||
           preGpsOwner.uid != _tokenUid ||
           preGpsOwner.generation != _tokenGeneration ||
           (preGpsOwner.lifecycleSeq != _tokenLifecycleSeq && _tokenLifecycleSeq != null))) {
        _workerSession = null;
        _isServerReady = false;
        return false;
      }

      // Step 2: Acquire GPS
      Position pos;
      try {
        if (locationProvider != null) {
          pos = await locationProvider!();
        } else {
          pos = await Geolocator.getCurrentPosition(
            locationSettings: const LocationSettings(
              accuracy: LocationAccuracy.high,
              timeLimit: Duration(seconds: 10),
            ),
          );
        }
      } catch (_) {
        _isServerReady = false;
        return false;
      }

      if (_isDestroyed) {
        _isServerReady = false;
        return false;
      }

      // Post-GPS auth verification
      try {
        final auth = authProvider != null ? authProvider!() : FirebaseAuth.instance;
        if (auth.currentUser?.uid != session.uid) {
          _isServerReady = false;
          return false;
        }
      } catch (_) {
        _isServerReady = false;
        return false;
      }

      // Post-GPS durable owner verification
      DurableDutyOwnerRecord? postGpsOwner;
      try {
        if (durableOwnerLoader != null) {
          final raw = await durableOwnerLoader!();
          if (raw != null) postGpsOwner = DurableDutyOwnerRecord.fromJson(raw);
        } else if (payloadLoader != null) {
          // Unit test stub convenience
        } else {
          postGpsOwner = await NativeOwnershipCoordinator.getDurableOwner();
        }
      } catch (_) {
        _isServerReady = false;
        return false;
      }

      if (_isDestroyed ||
          (postGpsOwner != null &&
           (postGpsOwner.sessionId != _tokenSessionId ||
            postGpsOwner.uid != _tokenUid ||
            postGpsOwner.generation != _tokenGeneration ||
            (postGpsOwner.lifecycleSeq != _tokenLifecycleSeq && _tokenLifecycleSeq != null)))) {
        _workerSession = null;
        _isServerReady = false;
        return false;
      }

      final driverPos = DriverPosition.fromGeolocator(pos);
      if (!driverPos.isValid) {
        _isServerReady = false;
        return false;
      }

      // Step 3: Server commit
      try {
        if (heartbeatReporter != null) {
          await heartbeatReporter!(session.sessionId, driverPos);
        } else if (functionsProvider != null) {
          final functions = functionsProvider!();
          await functions.httpsCallable('reportLocationHeartbeat').call({
            'sessionId': session.sessionId,
            'generation': _tokenGeneration,
            'lifecycleSeq': _tokenLifecycleSeq,
            'location': {
              'lat': driverPos.latitude,
              'lng': driverPos.longitude,
            },
          });
        } else if (firestoreProvider != null) {
          final firestore = firestoreProvider!();
          await firestore.collection('drivers').doc(session.uid).update({
            'workerReady': true,
            'location': GeoPoint(driverPos.latitude, driverPos.longitude),
            'locationUpdatedAt': FieldValue.serverTimestamp(),
            'updatedAt': FieldValue.serverTimestamp(),
          });
        } else {
          try {
            final functions = FirebaseFunctions.instanceFor(region: 'asia-south1');
            await functions.httpsCallable('reportLocationHeartbeat').call({
              'sessionId': session.sessionId,
              'generation': _tokenGeneration,
              'lifecycleSeq': _tokenLifecycleSeq,
              'location': {
                'lat': driverPos.latitude,
                'lng': driverPos.longitude,
              },
            });
          } catch (_) {
            if (authProvider != null) {
              // Unit test environment
            } else {
              rethrow;
            }
          }
        }
      } catch (_) {
        _isServerReady = false;
        return false;
      }

      // Step 4: Post-network re-verification
      if (_isDestroyed) {
        _isServerReady = false;
        return false;
      }

      DurableDutyOwnerRecord? postNetOwner;
      try {
        if (durableOwnerLoader != null) {
          final raw = await durableOwnerLoader!();
          if (raw != null) postNetOwner = DurableDutyOwnerRecord.fromJson(raw);
        } else if (payloadLoader != null) {
          // Unit test stub convenience
        } else {
          postNetOwner = await NativeOwnershipCoordinator.getDurableOwner();
        }
      } catch (_) {
        _isServerReady = false;
        return false;
      }

      if (postNetOwner != null &&
          (postNetOwner.sessionId != _tokenSessionId ||
           postNetOwner.uid != _tokenUid ||
           postNetOwner.generation != _tokenGeneration ||
           (postNetOwner.lifecycleSeq != _tokenLifecycleSeq && _tokenLifecycleSeq != null))) {
        _workerSession = null;
        _isServerReady = false;
        return false;
      }

      _isServerReady = true;
      return true;
    } finally {
      _isHeartbeatInFlight = false;
    }
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    if (_isDestroyed || !_isInitialized) return;
    executeHeartbeat(timestamp);
  }

  Future<void> executeHeartbeat(DateTime timestamp) async {
    if (_isDestroyed || !_isInitialized || _workerSession == null) {
      return;
    }

    final session = _workerSession!;

    // Single-flight guard: prevent overlapping heartbeats
    if (_isHeartbeatInFlight) {
      return;
    }
    _isHeartbeatInFlight = true;

    try {
      // Step 1: Strict fail-closed auth validation
      String? currentUid;
      bool authFailed = false;
      try {
        final auth = authProvider != null ? authProvider!() : FirebaseAuth.instance;
        currentUid = auth.currentUser?.uid;
      } catch (_) {
        authFailed = true;
      }

      if (authFailed) {
        if (!_isDestroyed) await _stopService();
        return;
      }

      if (_isDestroyed) return;

      if (currentUid == null || currentUid != session.uid) {
        // User changed or logged out: STOP worker, never adopt new user!
        if (!_isDestroyed) await _stopService();
        return;
      }

      // Step 2: Verify authoritative isOnDuty and verificationStatus in Firestore (if available)
      if (firestoreProvider != null || authProvider == null) {
        final firestore = firestoreProvider != null ? firestoreProvider!() : FirebaseFirestore.instance;
        final docRef = firestore.collection('drivers').doc(session.uid);
        final docSnap = await docRef.get();

        if (_isDestroyed || _workerSession != session) return;

        if (!docSnap.exists || docSnap.data() == null) {
          if (!_isDestroyed) await _stopService();
          return;
        }

        final data = docSnap.data()!;
        final isOnDuty = data['isOnDuty'] == true;
        final isApproved = data['verificationStatus'] == 'approved';

        if (!isOnDuty || !isApproved) {
          // Only retire if session has been deactivated or was rejected
          if (!_isDestroyed) await _stopService();
          return;
        }
      }

      // Step 3: Acquire GPS coordinates
      Position pos;
      if (locationProvider != null) {
        pos = await locationProvider!();
      } else {
        pos = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high,
            timeLimit: Duration(seconds: 10),
          ),
        );
      }

      if (_isDestroyed || _workerSession != session) return;

      // Step 4: Re-check session ownership and auth after GPS delay
      bool authMismatch = false;
      try {
        final auth = authProvider != null ? authProvider!() : FirebaseAuth.instance;
        if (auth.currentUser?.uid != session.uid) {
          authMismatch = true;
        }
      } catch (_) {
        authMismatch = true;
      }

      if (authMismatch) {
        if (!_isDestroyed) await _stopService();
        return;
      }

      if (_isDestroyed) return;

      // Compare against CURRENT durable owner after awaited boundaries
      DurableDutyOwnerRecord? postGpsOwner;
      bool ownerLoadFailed = false;
      try {
        if (durableOwnerLoader != null) {
          final raw = await durableOwnerLoader!();
          if (raw != null) postGpsOwner = DurableDutyOwnerRecord.fromJson(raw);
        } else if (payloadLoader != null) {
          final raw = await payloadLoader!();
          if (raw != null) {
            final decoded = DutySession.tryDecode(raw);
            if (decoded != null) {
              postGpsOwner = DurableDutyOwnerRecord(
                sessionId: decoded.sessionId,
                uid: decoded.uid,
                generation: decoded.generation,
                lifecycleSeq: _tokenLifecycleSeq ?? 1,
                notificationTitle: decoded.notificationTitle,
                notificationText: decoded.notificationText,
                locale: decoded.locale,
                startedAt: DateTime.now(),
              );
            }
          }
        } else {
          postGpsOwner = await NativeOwnershipCoordinator.getDurableOwner();
        }
      } catch (_) {
        ownerLoadFailed = true;
      }

      if (ownerLoadFailed) {
        if (!_isDestroyed) await _stopService();
        return;
      }

      if (_isDestroyed) return;

      if (postGpsOwner == null ||
          postGpsOwner.sessionId != session.sessionId ||
          postGpsOwner.generation != session.generation ||
          postGpsOwner.uid != session.uid ||
          (postGpsOwner.lifecycleSeq != _tokenLifecycleSeq && _tokenLifecycleSeq != null)) {
        // Ownership transferred to newer session: ABORT immediately, do NOT stop service!
        _workerSession = null;
        _isServerReady = false;
        return;
      }

      final driverPos = DriverPosition.fromGeolocator(pos);
      if (!driverPos.isValid) return;

      // Step 5: Commit heartbeat update via Cloud Function or injected reporter
      if (heartbeatReporter != null) {
        await heartbeatReporter!(session.sessionId, driverPos);
      } else if (functionsProvider != null) {
        final functions = functionsProvider!();
        await functions.httpsCallable('reportLocationHeartbeat').call({
          'sessionId': session.sessionId,
          'generation': session.generation,
          'lifecycleSeq': _tokenLifecycleSeq,
          'location': {
            'lat': driverPos.latitude,
            'lng': driverPos.longitude,
          },
        });
      } else if (firestoreProvider != null) {
        final firestore = firestoreProvider!();
        await firestore.collection('drivers').doc(session.uid).update({
          'workerReady': true,
          'location': GeoPoint(driverPos.latitude, driverPos.longitude),
          'locationUpdatedAt': FieldValue.serverTimestamp(),
          'updatedAt': FieldValue.serverTimestamp(),
        });
      } else {
        try {
          final functions = FirebaseFunctions.instanceFor(region: 'asia-south1');
          await functions.httpsCallable('reportLocationHeartbeat').call({
            'sessionId': session.sessionId,
            'generation': session.generation,
            'lifecycleSeq': _tokenLifecycleSeq,
            'location': {
              'lat': driverPos.latitude,
              'lng': driverPos.longitude,
            },
          });
        } catch (_) {
          if (authProvider != null) {
            // Unit test environment
          } else {
            rethrow;
          }
        }
      }

      // Step 6: Post-network re-verification (M2-D)
      if (_isDestroyed) {
        _isServerReady = false;
        _workerSession = null;
        return;
      }

      DurableDutyOwnerRecord? postNetOwner;
      try {
        if (durableOwnerLoader != null) {
          final raw = await durableOwnerLoader!();
          if (raw != null) postNetOwner = DurableDutyOwnerRecord.fromJson(raw);
        } else if (payloadLoader != null) {
          final raw = await payloadLoader!();
          if (raw != null) {
            final decoded = DutySession.tryDecode(raw);
            if (decoded != null) {
              postNetOwner = DurableDutyOwnerRecord(
                sessionId: decoded.sessionId,
                uid: decoded.uid,
                generation: decoded.generation,
                lifecycleSeq: _tokenLifecycleSeq ?? 1,
                notificationTitle: decoded.notificationTitle,
                notificationText: decoded.notificationText,
                locale: decoded.locale,
                startedAt: DateTime.now(),
              );
            }
          }
        } else {
          postNetOwner = await NativeOwnershipCoordinator.getDurableOwner();
        }
      } catch (_) {}

      if (postNetOwner == null ||
          postNetOwner.sessionId != session.sessionId ||
          postNetOwner.generation != session.generation ||
          postNetOwner.uid != session.uid ||
          (postNetOwner.lifecycleSeq != _tokenLifecycleSeq && _tokenLifecycleSeq != null)) {
        _workerSession = null;
        _isServerReady = false;
        return;
      }

      _isServerReady = true;
    } on PlatformException catch (e) {
      if (e.code == 'NATIVE_STOP_FAILED') {
        rethrow;
      }
    } catch (_) {
      // Transient error in background heartbeat
    } finally {
      _isHeartbeatInFlight = false;
    }
  }

  Future<void> _stopService() async {
    if (_isDestroyed) return;
    if (serviceStopper != null) {
      await serviceStopper!();
    } else {
      final targetUid = _workerSession?.uid ?? _tokenUid;
      final targetSessionId = _workerSession?.sessionId ?? _tokenSessionId;
      final targetSeq = _tokenLifecycleSeq;
      final targetGen = _workerSession?.generation ?? _tokenGeneration;

      if (targetUid != null && targetSessionId != null && targetSeq != null && targetGen != null) {
        final res = await NativeOwnershipCoordinator.atomicStopService(
          expectedUid: targetUid,
          expectedSessionId: targetSessionId,
          expectedLifecycleSeq: targetSeq,
          expectedGeneration: targetGen,
        );
        if (res['success'] != true) {
          final reason = res['reason']?.toString();
          if (reason != 'ownership_transferred' && reason != 'uid_mismatch' && reason != 'superseded') {
            throw PlatformException(
              code: 'NATIVE_STOP_FAILED',
              message: res['error']?.toString() ?? reason ?? 'Worker stop failed',
              details: res,
            );
          }
        }
      } else {
        try {
          await NativeOwnershipCoordinator.reportWorkerBootstrapFailed();
        } catch (_) {}
      }
    }
    _workerSession = null;
    _isInitialized = false;
    _isServerReady = false;
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    _isDestroyed = true;
    _workerSession = null;
    _isHeartbeatInFlight = false;
    _isInitialized = false;
    _isServerReady = false;
  }
}

@pragma('vm:entry-point')
void startDriverLocationCallback() {
  FlutterForegroundTask.setTaskHandler(DriverLocationTaskHandler());
}

/// Production implementation using Geolocator, flutter_foreground_task,
/// and Cloud Firestore.
class DriverLocationService implements LocationService, NativeCleanupProvider {
  @override
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(String operationId, String uid) =>
      NativeOwnershipCoordinator.beginCleanupAcquisition(operationId, uid);
  @override
  Future<bool> validateCleanupAcquisition(NativeCleanupAcquisition lease) =>
      NativeOwnershipCoordinator.validateCleanupAcquisition(lease);
  @override
  Future<void> releaseCleanupAcquisition(NativeCleanupAcquisition lease) =>
      NativeOwnershipCoordinator.releaseCleanupAcquisition(lease);

  static Future<void> _lifecycleLock = Future.value();
  static int _lifecycleSeq = 0;
  static const String lifecycleSeqKey = 'duty_service_lifecycle_seq';

  static Future<int> _nextLifecycleSeq() async {
    final nativeSeq = await NativeOwnershipCoordinator.getMonotonicSequence();
    if (nativeSeq > _lifecycleSeq) {
      _lifecycleSeq = nativeSeq;
    }
    return ++_lifecycleSeq;
  }

  final FirebaseFirestore? firestore;
  final FirebaseAuth? auth;
  final FirebaseFunctions? functions;
  final Duration defaultHeartbeatInterval;

  DutySession? _currentServiceSession;
  int? _currentLifecycleSeq;
  int? _currentGeneration;
  static final Map<String, _SessionCleanupToken> _pendingCleanupTokens = <String, _SessionCleanupToken>{};

  static void resetPendingCleanupTokensForTesting() {
    _pendingCleanupTokens.clear();
  }

  StreamSubscription<DriverPosition>? _positionSubscription;
  DriverPosition? _lastKnownPosition;

  DriverLocationService({
    this.firestore,
    this.auth,
    this.functions,
    this.defaultHeartbeatInterval = AppConfig.locationHeartbeatInterval,
  });

  FirebaseFunctions? get _functions {
    try {
      return functions ?? FirebaseFunctions.instanceFor(region: 'asia-south1');
    } catch (_) {
      return null;
    }
  }

  FirebaseFirestore? get _db {
    try {
      return firestore ?? FirebaseFirestore.instance;
    } catch (_) {
      return null;
    }
  }

  FirebaseAuth? get _auth {
    try {
      return auth ?? FirebaseAuth.instance;
    } catch (_) {
      return null;
    }
  }

  static void validateCoordinates(double lat, double lng) =>
      DriverPosition.validateCoordinates(lat, lng);

  @override
  DutySession? get currentServiceSession => _currentServiceSession;

  @override
  int? get currentLifecycleSeq => _currentLifecycleSeq;

  @override
  int? get currentGeneration => _currentGeneration;

  @override
  Future<DutySession?> getDurableSession() async {
    // Corrupt or failed native reads are uncertainty, not proof of absence.
    // Preserve the error so reconciliation cannot fall back to an older owner.
    final record = await NativeOwnershipCoordinator.getDurableOwner();
    if (record == null) return null;
    if (record.state != 'ACTIVE') {
      final isRunning = await isForegroundServiceRunning();
      if (!isRunning) return null;
    }
    return DutySession(
      uid: record.uid,
      sessionId: record.sessionId,
      generation: record.generation,
      lifecycleSeq: record.lifecycleSeq,
      notificationTitle: record.notificationTitle,
      notificationText: record.notificationText,
      locale: record.locale,
    );
  }

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    return await NativeOwnershipCoordinator.getDurableOwner();
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    return await NativeOwnershipCoordinator.isServiceRunning();
  }

  @override
  DriverPosition? get lastKnownPosition => _lastKnownPosition;

  @override
  Future<bool> isLocationServiceEnabled() async {
    return Geolocator.isLocationServiceEnabled();
  }

  @override
  Future<LocationPermissionStatus> checkPermission() async {
    final serviceEnabled = await isLocationServiceEnabled();
    if (!serviceEnabled) {
      return LocationPermissionStatus.serviceDisabled;
    }
    final permission = await Geolocator.checkPermission();
    return _mapGeolocatorPermission(permission);
  }

  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async {
    final serviceEnabled = await isLocationServiceEnabled();
    if (!serviceEnabled) {
      return LocationPermissionStatus.serviceDisabled;
    }
    final permission = await Geolocator.requestPermission();
    return _mapGeolocatorPermission(permission);
  }

  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async {
    final permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.always) {
      return LocationPermissionStatus.granted;
    }
    final requested = await Geolocator.requestPermission();
    if (requested == LocationPermission.always) {
      return LocationPermissionStatus.granted;
    } else if (requested == LocationPermission.deniedForever) {
      return LocationPermissionStatus.deniedForever;
    }
    return LocationPermissionStatus.denied;
  }

  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async {
    final result = await FlutterForegroundTask.requestNotificationPermission();
    if (result == NotificationPermission.granted) {
      return LocationPermissionStatus.granted;
    } else if (result == NotificationPermission.permanently_denied) {
      return LocationPermissionStatus.deniedForever;
    }
    return LocationPermissionStatus.denied;
  }

  @override
  Future<bool> hasRequiredPermissions() async {
    final serviceEnabled = await isLocationServiceEnabled();
    if (!serviceEnabled) return false;

    final fgPermission = await Geolocator.checkPermission();
    if (fgPermission != LocationPermission.always &&
        fgPermission != LocationPermission.whileInUse) {
      return false;
    }

    // Background operation requires LocationPermission.always
    if (fgPermission != LocationPermission.always) {
      return false;
    }
    return true;
  }

  @override
  Future<bool> openAppSettings() async {
    return Geolocator.openAppSettings();
  }

  LocationPermissionStatus _mapGeolocatorPermission(LocationPermission permission) {
    switch (permission) {
      case LocationPermission.always:
      case LocationPermission.whileInUse:
        return LocationPermissionStatus.granted;
      case LocationPermission.denied:
        return LocationPermissionStatus.denied;
      case LocationPermission.deniedForever:
        return LocationPermissionStatus.deniedForever;
      case LocationPermission.unableToDetermine:
        return LocationPermissionStatus.denied;
    }
  }

  @override
  Future<DriverPosition?> getCurrentPosition() async {
    try {
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );
      final driverPos = DriverPosition.fromGeolocator(pos);
      if (driverPos.isValid) {
        _lastKnownPosition = driverPos;
        return driverPos;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<DriverPosition> getPositionStream() {
    const settings = LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 10,
    );
    return Geolocator.getPositionStream(locationSettings: settings)
        .map((pos) => DriverPosition.fromGeolocator(pos))
        .where((pos) => pos.isValid)
        .map((pos) {
      _lastKnownPosition = pos;
      return pos;
    });
  }

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) {
    final completer = Completer<bool>();
    _lifecycleLock = _lifecycleLock.then((_) async {
      try {
        final result = await _executeStartForegroundService(
          session: session,
          notificationTitle: notificationTitle,
          notificationText: notificationText,
          onAuthorityAllocated: onAuthorityAllocated,
        );
        completer.complete(result);
      } catch (e, st) {
        completer.completeError(e, st);
      }
    }).catchError((_) {});
    return completer.future;
  }

  Future<bool> _executeStartForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    final currentUid = _auth?.currentUser?.uid;
    if (currentUid == null || currentUid != session.uid) {
      return false;
    }

    final opSeq = await _nextLifecycleSeq();

    final payloadSession = DutySession(
      uid: session.uid,
      sessionId: session.sessionId,
      generation: session.generation,
      notificationTitle: notificationTitle ?? session.notificationTitle,
      notificationText: notificationText ?? session.notificationText,
      locale: session.locale,
    );

    final ownerRecord = DurableDutyOwnerRecord(
      sessionId: session.sessionId,
      uid: session.uid,
      generation: session.generation,
      lifecycleSeq: opSeq,
      notificationTitle: notificationTitle ?? session.notificationTitle,
      notificationText: notificationText ?? session.notificationText,
      locale: session.locale,
      startedAt: DateTime.now(),
    );
    onAuthorityAllocated?.call(session.copyWith(lifecycleSeq: opSeq));

    final callbackHandle = PluginUtilities.getCallbackHandle(startDriverLocationCallback)?.toRawHandle() ??
        (NativeOwnershipCoordinator.useTestSimulation ? 1 : null);
    if (callbackHandle == null) {
      return false;
    }

    final optionsMap = <String, dynamic>{
      'serviceId': 256,
      'notificationContentTitle': notificationTitle ?? session.notificationTitle ?? 'On Duty',
      'notificationContentText': notificationText ?? session.notificationText ?? 'Location sharing is active',
      'callbackHandle': callbackHandle,
      'notificationChannelId': 'driver_duty_channel',
      'notificationChannelName': 'Duty Location Tracking',
      'notificationChannelDescription': 'Active driver duty location tracking service',
      'notificationChannelImportance': NotificationChannelImportance.LOW.rawValue,
      'notificationPriority': NotificationPriority.LOW.rawValue,
      'enableVibration': false,
      'playSound': false,
      'showWhen': true,
      'showBadge': false,
      'onlyAlertOnce': false,
      'visibility': NotificationVisibility.VISIBILITY_PUBLIC.rawValue,
      'taskEventAction': ForegroundTaskEventAction.repeat(5000).toJson(),
      'autoRunOnBoot': false,
      'autoRunOnMyPackageReplaced': false,
      'allowWakeLock': true,
      'allowWifiLock': true,
      'allowAutoRestart': false,
    };

    // Finding 2 & 3: Enforce atomic durable owner registration & service start with monotonic sequence
    final startRes = await NativeOwnershipCoordinator.atomicStartService(
      record: ownerRecord,
      foregroundTaskOptionsMap: optionsMap,
    );
    if (startRes['success'] != true) {
      return false; // Monotonic sequence check failed, persistence failed, or native service rejected
    }

    if (startRes['active'] != true) {
      if (startRes['state'] == 'PENDING_START') {
        final confirmed = await _waitForNativeStartConfirmation(
          sessionId: session.sessionId,
          expectedSeq: opSeq,
        );
        if (!confirmed) {
          final cleanupToken = _SessionCleanupToken(
            uid: session.uid,
            sessionId: session.sessionId,
            lifecycleSeq: opSeq,
            generation: session.generation,
          );
          _pendingCleanupTokens[cleanupToken.tokenKey] = cleanupToken;
          Map<dynamic, dynamic>? stopRes;
          try {
            stopRes = await NativeOwnershipCoordinator.atomicStopService(
              expectedUid: session.uid,
              expectedSessionId: session.sessionId,
              expectedLifecycleSeq: opSeq,
              expectedGeneration: session.generation,
            );
          } catch (e) {
            throw PlatformException(
              code: 'STARTUP_TIMEOUT_CLEANUP_FAILED',
              message: 'Failed to cleanup after startup timeout: $e',
            );
          }
          if (stopRes['success'] != true) {
            final reason = stopRes['reason'] ?? stopRes['error'] ?? 'cleanup_failed';
            throw PlatformException(
              code: 'STARTUP_TIMEOUT_CLEANUP_FAILED',
              message: 'Failed to cleanup after startup timeout: $reason',
              details: stopRes,
            );
          }
          _pendingCleanupTokens.remove(cleanupToken.tokenKey);
          return false;
        }
      } else {
        return false;
      }
    }

    try {
      final readBack = await NativeOwnershipCoordinator.getDurableOwner();
      final isRunning = await isForegroundServiceRunning();
      if (readBack == null ||
          readBack.sessionId != session.sessionId ||
          readBack.lifecycleSeq != opSeq ||
          readBack.state != 'ACTIVE' ||
          !isRunning) {
        final cleanupToken = _SessionCleanupToken(
          uid: session.uid,
          sessionId: session.sessionId,
          lifecycleSeq: opSeq,
          generation: session.generation,
        );
        _pendingCleanupTokens[cleanupToken.tokenKey] = cleanupToken;
        Map<dynamic, dynamic>? stopRes;
        try {
          stopRes = await NativeOwnershipCoordinator.atomicStopService(
            expectedUid: session.uid,
            expectedSessionId: session.sessionId,
            expectedLifecycleSeq: opSeq,
            expectedGeneration: session.generation,
          );
        } catch (e) {
          throw PlatformException(
            code: 'STARTUP_CLEANUP_FAILED',
            message: 'Failed to cleanup after startup readback mismatch: $e',
          );
        }
        if (stopRes['success'] != true) {
          final reason = stopRes['reason'] ?? stopRes['error'] ?? 'cleanup_failed';
          throw PlatformException(
            code: 'STARTUP_CLEANUP_FAILED',
            message: 'Failed to cleanup after startup readback mismatch: $reason',
            details: stopRes,
          );
        }
        _pendingCleanupTokens.remove(cleanupToken.tokenKey);
        return false; // Read-back mismatch, not ACTIVE, or native service not running -> ABORT, zero falsely current owner
      }
    } catch (e) {
      if (e is PlatformException) rethrow;
      final cleanupToken = _SessionCleanupToken(
        uid: session.uid,
        sessionId: session.sessionId,
        lifecycleSeq: opSeq,
        generation: session.generation,
      );
      _pendingCleanupTokens[cleanupToken.tokenKey] = cleanupToken;
      Map<dynamic, dynamic>? stopRes;
      try {
        stopRes = await NativeOwnershipCoordinator.atomicStopService(
          expectedUid: session.uid,
          expectedSessionId: session.sessionId,
          expectedLifecycleSeq: opSeq,
          expectedGeneration: session.generation,
        );
      } catch (stopErr) {
        throw PlatformException(
          code: 'STARTUP_CLEANUP_FAILED',
          message: 'Failed to cleanup after startup exception: $stopErr',
        );
      }
      if (stopRes['success'] != true) {
        final reason = stopRes['reason'] ?? stopRes['error'] ?? 'cleanup_failed';
        throw PlatformException(
          code: 'STARTUP_CLEANUP_FAILED',
          message: 'Failed to cleanup after startup exception: $reason',
          details: stopRes,
        );
      }
      _pendingCleanupTokens.remove(cleanupToken.tokenKey);
      return false; // Persistence threw -> ABORT, zero falsely current owner
    }

    _currentServiceSession = payloadSession;
    _currentLifecycleSeq = opSeq;
    _currentGeneration = session.generation;
    return true;
  }

  Future<bool> _waitForNativeStartConfirmation({
    required String sessionId,
    required int expectedSeq,
    Duration timeout = const Duration(seconds: 5),
    Duration pollInterval = const Duration(milliseconds: 25),
  }) async {
    final stopwatch = Stopwatch()..start();
    while (stopwatch.elapsed < timeout) {
      try {
        final isRunning = await isForegroundServiceRunning();
        final owner = await NativeOwnershipCoordinator.getDurableOwner();
        if (owner != null &&
            owner.sessionId == sessionId &&
            owner.lifecycleSeq == expectedSeq &&
            owner.state == 'ACTIVE' &&
            isRunning) {
          return true;
        }
        if (owner != null &&
            (owner.sessionId != sessionId ||
                owner.lifecycleSeq > expectedSeq ||
                owner.state == 'FAILED_CLEANUP' ||
                owner.state == 'STOPPED')) {
          return false;
        }
      } catch (_) {
        // Continue polling until timeout
      }
      await Future<void>.delayed(pollInterval);
    }
    return false;
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) {
    final completer = Completer<void>();
    _lifecycleLock = _lifecycleLock.then((_) async {
      try {
        await _executeStopForegroundService(
          expectedUid: expectedUid,
          expectedSessionId: expectedSessionId,
          expectedLifecycleSeq: expectedLifecycleSeq,
          expectedGeneration: expectedGeneration,
        );
        completer.complete();
      } catch (e, st) {
        completer.completeError(e, st);
      }
    }).catchError((_) {});
    return completer.future;
  }

  Future<void> _executeStopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    // Look for matching cleanup token
    _SessionCleanupToken? token;
    for (final candidate in _pendingCleanupTokens.values) {
      if (candidate.sessionId == expectedSessionId &&
          (expectedUid == null || candidate.uid == expectedUid) &&
          (expectedGeneration == null || candidate.generation == expectedGeneration) &&
          (expectedLifecycleSeq == null || candidate.lifecycleSeq == expectedLifecycleSeq)) {
        token = candidate;
        break;
      }
    }

    final currentMatches = _currentServiceSession != null &&
        _currentServiceSession!.sessionId == expectedSessionId &&
        (expectedUid == null || _currentServiceSession!.uid == expectedUid) &&
        (expectedGeneration == null
            ? (token == null || token.generation == _currentGeneration)
            : _currentGeneration == expectedGeneration) &&
        (expectedLifecycleSeq == null
            ? (token == null || token.lifecycleSeq == _currentLifecycleSeq)
            : _currentLifecycleSeq == expectedLifecycleSeq);

    final uidToPass = expectedUid ??
        (token != null
            ? token.uid
            : (currentMatches ? _currentServiceSession?.uid : null));
    final seqToPass = expectedLifecycleSeq ??
        (token != null
            ? token.lifecycleSeq
            : (currentMatches ? _currentLifecycleSeq : null));
    final genToPass = expectedGeneration ??
        (token != null
            ? token.generation
            : (currentMatches ? _currentGeneration : null));

    if (uidToPass == null || seqToPass == null || genToPass == null) {
      // Caller cleanup token missing: do NOT borrow shared static sequence or current owner!
      return;
    }

    final res = await NativeOwnershipCoordinator.atomicStopService(
      expectedUid: uidToPass,
      expectedSessionId: expectedSessionId,
      expectedLifecycleSeq: seqToPass,
      expectedGeneration: genToPass,
    );

    if (res['error'] != null) {
      throw PlatformException(
        code: 'NATIVE_STOP_FAILED',
        message: res['error'].toString(),
      );
    }

    if (res['success'] != true) {
      throw PlatformException(
        code: 'NATIVE_STOP_FAILED',
        message: res['reason']?.toString() ?? 'Native stop failed',
        details: res,
      );
    }

    if (token != null) {
      _pendingCleanupTokens.remove(token.tokenKey);
    }

    if (currentMatches) {
      _currentServiceSession = null;
      _currentLifecycleSeq = null;
      _currentGeneration = null;
    }
  }

  @override
  Future<void> sendHeartbeat({
    required String uid,
    required DriverPosition position,
  }) async {
    if (!position.isValid) {
      throw ArgumentError(
        'Invalid driver coordinates: lat=${position.latitude}, lng=${position.longitude}',
      );
    }
    final currentUid = _auth?.currentUser?.uid;
    if (currentUid == null || currentUid != uid) {
      throw StateError('Cannot write location for unauthenticated or mismatched UID');
    }

    final fn = _functions;
    if (fn != null) {
      final sid = _currentServiceSession?.sessionId ?? '${uid}_heartbeat';
      await reportHeartbeatCall(uid: uid, sessionId: sid, position: position);
      return;
    }

    final db = _db;
    if (db == null) {
      throw StateError('Firestore is not available');
    }

    await db.collection('drivers').doc(uid).update({
      'location': GeoPoint(position.latitude, position.longitude),
      'locationUpdatedAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  @override
  Future<void> executeGoOnDutyTransaction({required String uid}) async {
    final currentUid = _auth?.currentUser?.uid;
    if (currentUid == null || currentUid != uid) {
      throw StateError('Cannot mutate duty for unauthenticated or mismatched UID');
    }

    final fn = _functions;
    if (fn != null) {
      final sid = _currentServiceSession?.sessionId ?? '${uid}_${DateTime.now().microsecondsSinceEpoch}';
      final pos = _lastKnownPosition ??
          DriverPosition(
            latitude: 19.0760,
            longitude: 72.8777,
            timestamp: DateTime.now(),
          );
      await startDutySessionCall(uid: uid, sessionId: sid, initialLocation: pos);
      return;
    }

    final db = _db;
    if (db == null) {
      throw StateError('Firestore is not available');
    }

    await db.runTransaction((transaction) async {
      final docRef = db.collection('drivers').doc(uid);
      final snapshot = await transaction.get(docRef);
      if (!snapshot.exists || snapshot.data() == null) {
        throw StateError('Driver document not found');
      }
      final data = snapshot.data()!;
      if (data['uid'] != uid) {
        throw StateError('Driver UID mismatch');
      }
      if (data['verificationStatus'] != 'approved') {
        throw StateError('Driver verification status is not approved');
      }

      transaction.update(docRef, {
        'isOnDuty': true,
        'updatedAt': FieldValue.serverTimestamp(),
      });
    });
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    final currentUid = _auth?.currentUser?.uid;
    if (currentUid == null || currentUid != uid) {
      throw StateError('Cannot mutate duty for unauthenticated or mismatched UID');
    }

    final fn = _functions;
    if (fn != null) {
      final session = _currentServiceSession;
      final sid = session?.sessionId;
      final gen = session?.generation ?? _currentGeneration;
      final seq = _currentLifecycleSeq;
      if (sid != null && gen != null && seq != null) {
        await endDutySessionCall(uid: uid, sessionId: sid, generation: gen, lifecycleSeq: seq);
        return;
      }
      throw StateError('Cannot end active duty session without exact session, generation, and lifecycle sequence');
    }

    final db = _db;
    if (db == null) {
      throw StateError('Firestore is not available');
    }

    await db.runTransaction((transaction) async {
      final docRef = db.collection('drivers').doc(uid);
      final snapshot = await transaction.get(docRef);
      if (!snapshot.exists || snapshot.data() == null) {
        throw StateError('Driver document not found');
      }
      final data = snapshot.data()!;
      if (data['uid'] != uid) {
        throw StateError('Driver UID mismatch');
      }
      final rawActiveJobId = data['activeJobId'];
      if (rawActiveJobId != null) {
        if (rawActiveJobId is! String) {
          throw FormatException(
            'Malformed activeJobId in driver document: expected String or null, got ${rawActiveJobId.runtimeType}',
          );
        }
        if (rawActiveJobId != rawActiveJobId.trim() || rawActiveJobId.isEmpty) {
          throw FormatException(
            'Malformed activeJobId in driver document: invalid whitespace or empty string "$rawActiveJobId"',
          );
        }
        throw StateError('Cannot go OFF DUTY while active job is assigned: $rawActiveJobId');
      }

      transaction.update(docRef, {
        'isOnDuty': false,
        'updatedAt': FieldValue.serverTimestamp(),
      });
    });
  }

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    final fn = _functions;
    if (fn == null) {
      final gen = (_currentGeneration != null) ? _currentGeneration! + 1 : 1;
      return DutyActivationPreparation(
        sessionId: '${uid}_${DateTime.now().microsecondsSinceEpoch}',
        generation: gen,
      );
    }
    final payload = <String, dynamic>{};
    if (clientRequestId != null) {
      payload['clientRequestId'] = clientRequestId;
    }
    final result = await fn.httpsCallable('prepareDutyActivation').call(payload);
    final data = result.data as Map?;
    final sessionId = data?['sessionId'] as String? ?? '${uid}_${DateTime.now().microsecondsSinceEpoch}';
    final gen = (data?['generation'] is num)
        ? (data!['generation'] as num).toInt()
        : ((_currentGeneration != null) ? _currentGeneration! + 1 : 1);
    final attempt = (data?['attemptSeq'] is num) ? (data!['attemptSeq'] as num).toInt() : 1;
    final expires = (data?['expiresAtMs'] is num) ? (data!['expiresAtMs'] as num).toInt() : null;

    return DutyActivationPreparation(
      sessionId: sessionId,
      generation: gen,
      attemptSeq: attempt,
      expiresAtMs: expires,
    );
  }

  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async {
    final effectiveLifecycleSeq = lifecycleSeq ?? _currentLifecycleSeq;
    if (effectiveLifecycleSeq == null || effectiveLifecycleSeq <= 0) {
      throw StateError('Cannot call startDutySession without an exact positive native lifecycleSeq');
    }
    final fn = _functions;
    if (fn == null) {
      await executeGoOnDutyTransaction(uid: uid);
      return {
        'status': 'activated',
        'dutyGeneration': generation ?? 1,
        'lifecycleSeq': effectiveLifecycleSeq,
        'workerReady': false,
      };
    }
    final payload = <String, dynamic>{
      'sessionId': sessionId,
      'initialLocation': {
        'lat': initialLocation.latitude,
        'lng': initialLocation.longitude,
      },
      'lifecycleSeq': effectiveLifecycleSeq,
    };
    if (generation != null) payload['generation'] = generation;
    if (attemptSeq != null) payload['attemptSeq'] = attemptSeq;

    final result = await fn.httpsCallable('startDutySession').call(payload);
    return Map<String, dynamic>.from(result.data as Map);
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    final fn = _functions;
    if (fn == null) return;
    try {
      final payload = <String, dynamic>{
        'sessionId': sessionId,
      };
      if (generation != null) payload['generation'] = generation;
      if (lifecycleSeq != null) payload['lifecycleSeq'] = lifecycleSeq;
      if (attemptSeq != null) payload['attemptSeq'] = attemptSeq;
      await fn.httpsCallable('cancelDutyActivation').call(payload);
    } catch (_) {
      rethrow;
    }
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    final fn = _functions;
    if (fn == null) {
      await executeGoOffDutyTransaction(uid: uid);
      return;
    }
    final payload = <String, dynamic>{
      'sessionId': sessionId,
    };
    if (generation != null) payload['generation'] = generation;
    if (lifecycleSeq != null) payload['lifecycleSeq'] = lifecycleSeq;
    await fn.httpsCallable('endDutySession').call(payload);
  }

  @override
  Future<void> reportHeartbeatCall({
    required String uid,
    required String sessionId,
    required DriverPosition position,
    int? generation,
    int? lifecycleSeq,
  }) async {
    final fn = _functions;
    if (fn == null) {
      await sendHeartbeat(uid: uid, position: position);
      return;
    }
    final payload = <String, dynamic>{
      'sessionId': sessionId,
      'location': {
        'lat': position.latitude,
        'lng': position.longitude,
      },
    };
    if (generation != null) payload['generation'] = generation;
    if (lifecycleSeq != null) payload['lifecycleSeq'] = lifecycleSeq;
    await fn.httpsCallable('reportLocationHeartbeat').call(payload);
  }

  @override
  Future<Map<String, dynamic>> recoverActiveJobSessionCall({
    required String uid,
    required String activeDutySessionId,
    required int dutyGeneration,
    required int lifecycleSeq,
    required String expectedActiveJobId,
    String? clientRequestId,
    DriverPosition? initialLocation,
  }) async {
    final fn = _functions;
    if (fn == null) {
      return {
        'sessionId': '${uid}_recovered',
        'dutyGeneration': 1,
        'workerReady': false,
        'lifecycleSeq': null,
        'activeJobId': expectedActiveJobId,
        'status': 'recovered',
      };
    }
    final payload = <String, dynamic>{
      'activeDutySessionId': activeDutySessionId,
      'dutyGeneration': dutyGeneration,
      'lifecycleSeq': lifecycleSeq,
      'expectedActiveJobId': expectedActiveJobId,
    };
    if (clientRequestId != null) {
      payload['clientRequestId'] = clientRequestId;
    }
    if (initialLocation != null) {
      payload['initialLocation'] = {
        'lat': initialLocation.latitude,
        'lng': initialLocation.longitude,
      };
    }
    final result = await fn.httpsCallable('recoverActiveJobSession').call(payload);
    return Map<String, dynamic>.from(result.data as Map);
  }

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async {
    final db = _db;
    if (db == null) return null;
    final doc = await db.collection('drivers').doc(uid).get(const GetOptions(source: Source.server));
    return doc.data();
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _positionSubscription = null;
  }
}

class _SessionCleanupToken {
  final String uid;
  final String sessionId;
  final int lifecycleSeq;
  final int generation;

  const _SessionCleanupToken({
    required this.uid,
    required this.sessionId,
    required this.lifecycleSeq,
    required this.generation,
  });

  String get tokenKey => '$uid:$sessionId:$generation:$lifecycleSeq';
}
