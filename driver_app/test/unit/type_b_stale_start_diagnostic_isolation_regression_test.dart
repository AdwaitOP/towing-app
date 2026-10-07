import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'duty_controller_test.dart' as f;

const a = DutySession(uid: 'A', sessionId: 'census-S', generation: 2, lifecycleSeq: 7);
const b = DutySession(uid: 'B', sessionId: 'census-BS', generation: 3, lifecycleSeq: 8);
const l8 = DutySession(uid: 'A', sessionId: 'census-S', generation: 2, lifecycleSeq: 8);

DriverProfile profile(String uid, {bool on = true, int gen = 2, int seq = 7}) =>
    DriverProfile(
      uid: uid,
      name: 'Census Driver',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH01AB1234',
      verificationStatus: 'approved',
      isOnDuty: on,
      activeDutySessionId: on ? 'census-S' : null,
      dutyGeneration: gen,
      lifecycleSeq: on ? seq : null,
      workerReady: on,
    );

DurableDutyOwnerRecord record(DutySession d) => DurableDutyOwnerRecord(
      uid: d.uid,
      sessionId: d.sessionId,
      generation: d.generation,
      lifecycleSeq: d.lifecycleSeq!,
      startedAt: DateTime.utc(2026, 10, 2),
    );

Map<String, Object?> state(DutyController c) => {
      'uid': c.currentProfile?.uid,
      'profile': c.currentProfile,
      'duty': c.authoritativeDutyState,
      'health': c.trackingHealth,
      'desired': c.desiredDutyState,
      'ready': c.isReady,
      'loading': c.isLoading,
      'reconciling': c.isReconciling,
      'error': c.lastError,
      'errorCategory': c.errorCategory,
      'cleanup': c.isCleanupRequired,
      'pending': c.pendingCleanupSession,
      'cancellation': c.pendingCancellation,
      'active': c.activeSession,
      'seq': c.activeLifecycleSeq,
      'logout': c.isLogoutInProgress,
    };

class CensusLocation extends f.TestLocationService {
  final calls = <String, int>{};
  final events = <String>[];
  DriverProfile fresh = profile('A');
  String? gate;
  bool failure = false, stopFailure = false;
  final entered = Completer<void>(), release = Completer<void>();
  String? extraGate;
  Completer<void>? extraEntered, extraRelease;
  bool extraFailure = false;

  Future<void> hit(String operation) async {
    final n = (calls[operation] ?? 0) + 1;
    calls[operation] = n;
    events.add('$operation#$n');
    if (extraGate == '$operation#$n') {
      extraGate = null;
      extraEntered!.complete();
      await extraRelease!.future;
      if (extraFailure) {
        throw PlatformException(code: 'CENSUS_SECOND_${operation}_FAILED');
      }
    }
    if (gate == '$operation#$n') {
      gate = null;
      entered.complete();
      await release.future;
      if (failure) throw PlatformException(code: 'CENSUS_${operation}_FAILED');
    }
  }

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    await hit('owner');
    return currentSession == null ? null : record(currentSession!);
  }

  @override
  Future<DutySession?> getDurableSession() async {
    await hit('session');
    return currentSession;
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    await hit('running');
    return serviceRunning;
  }

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async {
    await hit('fresh');
    return {
      'uid': fresh.uid,
      'name': fresh.name,
      'phone': fresh.phone,
      'truckType': 'flatbed',
      'vehicleNumber': fresh.vehicleNumber,
      'verificationStatus': fresh.verificationStatus,
      'isOnDuty': fresh.isOnDuty,
      'activeDutySessionId': fresh.activeDutySessionId,
      'dutyGeneration': fresh.dutyGeneration,
      'lifecycleSeq': fresh.lifecycleSeq,
      'workerReady': fresh.workerReady,
    };
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    final target = DutySession(
      uid: expectedUid!,
      sessionId: expectedSessionId,
      generation: expectedGeneration!,
      lifecycleSeq: expectedLifecycleSeq,
    );
    exactStopRequests.add(target);
    await hit('stop');
    if (stopFailure) throw PlatformException(code: 'CENSUS_STOP_FAILED');
    if (currentSession == target) {
      currentSession = null;
      serviceRunning = false;
    }
  }

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    await hit('prepare');
    return DutyActivationPreparation(
      sessionId: a.sessionId,
      generation: 2,
      attemptSeq: 3,
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
    await hit('activation');
    return {
      'status': 'activated',
      'sessionId': sessionId,
      'dutyGeneration': generation ?? 2,
      'lifecycleSeq': lifecycleSeq ?? 7,
      'workerReady': false,
    };
  }

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession)? onAuthorityAllocated,
  }) async {
    final exact = session.copyWith(lifecycleSeq: 7);
    currentSession = exact;
    serviceRunning = true;
    onAuthorityAllocated?.call(exact);
    await hit('start');
    return true;
  }

  @override
  Future<bool> isLocationServiceEnabled() async => true;
  @override
  Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async =>
      LocationPermissionStatus.granted;
  @override
  Future<DriverPosition> getCurrentPosition() async => DriverPosition(
        latitude: 19.0760,
        longitude: 72.8777,
        timestamp: DateTime.utc(2026, 10, 2),
      );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Batch 1 Group E (F10) Type B Diagnostic Isolation Regressions', () {
    late f.TestAuthService auth;
    late CensusLocation loc;
    late DutyController c;

    setUp(() {
      auth = f.TestAuthService(f.FakeUser('A'));
      loc = CensusLocation()
        ..currentSession = a
        ..serviceRunning = true
        ..mockLifecycleSeq = 7;
      loc.currentPos = DriverPosition(
        latitude: 19,
        longitude: 73,
        timestamp: DateTime.utc(2026, 10, 2),
      );
      c = DutyController(locationService: loc, authService: auth);
      c.updateProfile(profile('A'));
    });

    tearDown(() {
      c.dispose();
      auth.dispose();
    });

    Future<void> replacement(String receiver) async {
      if (receiver == 'B') {
        auth.emitUser(f.FakeUser('B'));
        await Future<void>.delayed(Duration.zero);
        c.updateProfile(profile('B', on: false));
        loc.currentSession = b;
        loc.serviceRunning = true;
      } else {
        c.beginLogoutBarrier('A');
        loc.currentSession = l8;
        loc.serviceRunning = true;
      }
    }

    for (final receiver in ['B', 'sameUIDlease']) {
      test('F10: C7 resume START then stop fail=true receiver=$receiver isolates diagnostic', () async {
        loc.currentSession = null;
        loc.serviceRunning = false;
        c.updateProfile(profile('A', on: false));
        expect(await c.requestGoOnDuty(onShowDisclosure: () async => true), true);

        loc.currentSession = null;
        loc.serviceRunning = false;
        c.updateProfile(profile('A'));
        loc.fresh = profile('A');

        loc.gate = 'start#2';
        final old = c.reconcileDutyState();
        await loc.entered.future;
        await replacement(receiver);
        final before = state(c);

        loc.currentSession = a;
        loc.serviceRunning = true;
        final held = Completer<void>(), released = Completer<void>();
        final ordinal = (loc.calls['stop'] ?? 0) + 1;
        loc.extraGate = 'stop#$ordinal';
        loc.extraEntered = held;
        loc.extraRelease = released;
        loc.extraFailure = true;

        loc.release.complete();
        await held.future.timeout(const Duration(seconds: 3));
        loc.currentSession = receiver == 'B' ? b : l8;
        loc.serviceRunning = true;
        released.complete();
        await old;

        expect(state(c), before);
        expect(loc.currentSession, receiver == 'B' ? b : l8);
        expect(loc.serviceRunning, true);
        expect(loc.exactStopRequests.every((s) => s == a), true);

        // F10 expectation: old A failure cannot change public error state of replacement receiver
        expect(
          c.staleStartCleanupError,
          isNull,
          reason: 'old A failure cannot change public error state of replacement receiver',
        );
      });
    }
  });
}
