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
  final ends = <DutySession>[];
  final cancels = <Map<String, Object?>>[];
  DutySession? serverAuthority;
  Map<String, Object?>? preparedAuthority;
  String? gate;
  bool failure = false, endFailure = false, cancelFailure = false, stopFailure = false;
  final entered = Completer<void>(), release = Completer<void>();

  Future<void> hit(String operation) async {
    final n = (calls[operation] ?? 0) + 1;
    calls[operation] = n;
    events.add('$operation#$n');
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
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    final target = DutySession(
      uid: uid,
      sessionId: sessionId,
      generation: generation!,
      lifecycleSeq: lifecycleSeq,
    );
    ends.add(target);
    await hit('end');
    if (endFailure) throw PlatformException(code: 'CENSUS_END_FAILED');
    if (serverAuthority == target) serverAuthority = null;
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
    preparedAuthority = {
      'uid': uid,
      'session': a.sessionId,
      'generation': 2,
      'attempt': 3,
    };
    return DutyActivationPreparation(
      sessionId: a.sessionId,
      generation: 2,
      attemptSeq: 3,
    );
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    cancels.add({
      'uid': uid,
      'session': sessionId,
      'generation': generation,
      'seq': lifecycleSeq,
      'attempt': attemptSeq,
    });
    await hit('cancel');
    if (cancelFailure) throw PlatformException(code: 'CENSUS_CANCEL_FAILED');
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
    serverAuthority = a;
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

  group('Batch 1 Group D (F08–F09) Stale Go-On Server Debt Retention Regressions', () {
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
      test('F08: C9 pre-native stale prepare cancellation failure retains exact debt (receiver=$receiver)', () async {
        loc.currentSession = null;
        loc.serviceRunning = false;
        c.updateProfile(profile('A', on: false));
        loc.gate = 'prepare#1';
        loc.cancelFailure = true;

        final old = c.requestGoOnDuty(onShowDisclosure: () async => true);
        await loc.entered.future;
        await replacement(receiver);
        final before = state(c);
        loc.release.complete();
        expect(await old, false);

        expect(state(c), before);
        expect(loc.preparedAuthority, {
          'uid': 'A',
          'session': a.sessionId,
          'generation': 2,
          'attempt': 3,
        });

        // The unresolved cancellation must be captured into deferred compensation
        expect(
          c.deferredCompensation.any((d) =>
              d.cancellation?.uid == 'A' &&
              d.cancellation?.sessionId == a.sessionId &&
              d.cancellation?.generation == 2 &&
              d.cancellation?.attemptSeq == 3),
          true,
          reason: 'unresolved exact prepared cancellation must survive stale O1 without being injected into receiver',
        );
      });
    }

    for (final receiver in ['B', 'sameUIDlease']) {
      test('F09: C9 stale activation END failure and successful STOP retains server debt (receiver=$receiver)', () async {
        loc.currentSession = null;
        loc.serviceRunning = false;
        c.updateProfile(profile('A', on: false));
        loc.gate = 'activation#1';
        loc.endFailure = true;

        final old = c.requestGoOnDuty(onShowDisclosure: () async => true);
        await loc.entered.future;
        if (receiver == 'B') {
          auth.emitUser(f.FakeUser('B'));
          await Future<void>.delayed(Duration.zero);
          c.updateProfile(profile('B', on: false));
        } else {
          c.beginLogoutBarrier('A');
        }
        loc.currentSession = a;
        loc.serviceRunning = true;
        final before = state(c);
        loc.release.complete();
        expect(await old, false);

        expect(state(c), before);
        expect(loc.ends, [a]);
        expect(loc.serverAuthority, a);
        expect(loc.currentSession, isNull);
        expect(loc.serviceRunning, false);

        // Server session END failure must be retained as unresolved debt
        expect(
          c.isCleanupRequired || c.deferredCompensation.isNotEmpty,
          true,
          reason: 'exact END failure remains unresolved despite verified native STOP',
        );
      });
    }
  });
}
