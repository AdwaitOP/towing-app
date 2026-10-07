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

DutySession epoch(String uid, {String sid = 'audit-S', int gen = 2, int seq = 7}) =>
    DutySession(uid: uid, sessionId: sid, generation: gen, lifecycleSeq: seq);

DriverProfile profile(DutySession s, {bool on = true}) => DriverProfile(
      uid: s.uid,
      name: 'Census',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH01AA1234',
      verificationStatus: 'approved',
      isOnDuty: on,
      activeDutySessionId: s.sessionId,
      dutyGeneration: s.generation,
      lifecycleSeq: s.lifecycleSeq,
      workerReady: on,
    );

Map<String, Object?> tuple(DutySession? s) => {
      'uid': s?.uid,
      'sid': s?.sessionId,
      'gen': s?.generation,
      'seq': s?.lifecycleSeq,
    };

Map<String, Object?> snapshot(DutyController c) => {
      'uid': c.currentProfile?.uid,
      'duty': c.authoritativeDutyState.name,
      'health': c.trackingHealth.name,
      'desired': c.desiredDutyState.name,
      'ready': c.isReady,
      'loading': c.isLoading,
      'reconciling': c.isReconciling,
      'logout': c.isLogoutInProgress,
      'pending': tuple(c.pendingCleanupSession),
      'cancelUid': c.pendingCancelUid,
      'cancelSid': c.pendingCancelSessionId,
      'cancelGen': c.pendingCancellation?.generation,
      'cancelAttempt': c.pendingCancellation?.attemptSeq,
      'error': c.lastErrorCode,
      'cleanError': c.cleanupErrorCode,
      'cancelError': c.cancellationErrorCode,
      'cleanup': c.isCleanupRequired,
      'active': tuple(c.activeSession),
      'deferred': c.deferredCompensation.length,
    };

DurableDutyOwnerRecord? owner(DutySession? s) => s == null
    ? null
    : DurableDutyOwnerRecord(
        uid: s.uid,
        sessionId: s.sessionId,
        generation: s.generation,
        lifecycleSeq: s.lifecycleSeq!,
        startedAt: DateTime.utc(2026, 10, 2),
      );

class CensusLocation extends f.TestLocationService {
  Future<void> Function(String)? hook;
  Object? stopError, cancelError;
  int ownerCount = 0, sessionCount = 0, runningCount = 0;
  final ends = <DutySession>[];

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    final captured = owner(currentSession);
    await hook?.call('owner${++ownerCount}');
    return captured;
  }

  @override
  Future<DutySession?> getDurableSession() async {
    final captured = currentSession;
    await hook?.call('session${++sessionCount}');
    return captured;
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    final captured = serviceRunning;
    await hook?.call('running${++runningCount}');
    return captured;
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    ends.add(DutySession(
      uid: uid,
      sessionId: sessionId,
      generation: generation!,
      lifecycleSeq: lifecycleSeq,
    ));
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    final s = DutySession(
      uid: expectedUid!,
      sessionId: expectedSessionId,
      generation: expectedGeneration!,
      lifecycleSeq: expectedLifecycleSeq,
    );
    exactStopRequests.add(s);
    final capturedError = stopError;
    await hook?.call('stop');
    if (capturedError != null) throw capturedError;
    if (currentSession == s) {
      currentSession = null;
      serviceRunning = false;
    }
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    cancelActivationCalls.add({
      'uid': uid,
      'sessionId': sessionId,
      'generation': generation,
      'lifecycleSeq': lifecycleSeq,
      'attemptSeq': attemptSeq,
    });
    final capturedError = cancelError;
    await hook?.call('cancel');
    if (capturedError != null) throw capturedError;
  }
}

Future<void> flush() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

Future<void> debt(
  DutyController c,
  CensusLocation l,
  DutySession s, {
  String code = 'NEW_STOP_FAILED',
}) async {
  l.currentSession = s;
  l.serviceRunning = true;
  l.mockLifecycleSeq = s.lifecycleSeq;
  l.stopError = PlatformException(code: code);
  c.updateProfile(profile(s));
  expect(await c.requestGoOffDuty(), false);
  expect(c.pendingCleanupSession, s);
  expect(c.cleanupErrorCode, code);
  l.stopError = null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Batch 1 Group A (F01–F04) Canonical Retry Ownership Regressions', () {
    for (final replacement in ['uidB', 'generation', 'lifecycle', 'sameTuple']) {
      for (final boundary in ['stop', 'owner1', 'session1', 'running1', 'owner2']) {
        for (final outcome in ['success', 'failure']) {
          test('C2 $replacement $boundary $outcome protects newer cleanup debt (F01-F02)', () async {
            final a = f.TestAuthService(f.FakeUser('A'));
            final l = CensusLocation();
            final c = DutyController(locationService: l, authService: a);
            addTearDown(c.dispose);
            addTearDown(a.dispose);

            final oldEpoch = epoch('A');
            await debt(c, l, oldEpoch, code: 'OLD_STOP_FAILED');
            l.ownerCount = l.sessionCount = l.runningCount = 0;
            final entered = Completer<void>(), release = Completer<void>();
            var held = false;
            l.hook = (b) async {
              if (b == boundary && !held) {
                held = true;
                entered.complete();
                await release.future;
                if (outcome == 'failure') throw PlatformException(code: 'A_VERIFY_FAILED');
              }
            };
            final old = c.retryCleanup();
            await entered.future.timeout(const Duration(seconds: 5));
            l.hook = null;

            final next = replacement == 'uidB'
                ? epoch('B', sid: 'audit-BS', gen: 3, seq: 8)
                : replacement == 'generation'
                    ? epoch('A', gen: 3, seq: 8)
                    : replacement == 'lifecycle'
                        ? epoch('A', seq: 8)
                        : oldEpoch;

            if (replacement == 'uidB') {
              a.emitUser(f.FakeUser('B'));
              await flush();
            }

            await debt(c, l, next);
            final before = snapshot(c);
            release.complete();
            await old;
            await flush();
            final after = snapshot(c);

            expect(
              after,
              before,
              reason: 'Old retry cannot overwrite, clear or republish newer canonical cleanup state',
            );
          });
        }
      }
    }

    for (final boundary in ['stop', 'owner1', 'session1', 'running1', 'owner2']) {
      for (final outcome in ['success', 'failure']) {
        test('C2 control $boundary $outcome current retry reports legitimate result', () async {
          final a = f.TestAuthService(f.FakeUser('A'));
          final l = CensusLocation();
          final c = DutyController(locationService: l, authService: a);
          addTearDown(c.dispose);
          addTearDown(a.dispose);

          await debt(c, l, epoch('A'), code: 'OLD_STOP_FAILED');
          l.ownerCount = l.sessionCount = l.runningCount = 0;
          var done = false;
          l.hook = (b) async {
            if (b == boundary && !done) {
              done = true;
              if (outcome == 'failure') throw PlatformException(code: 'CURRENT_FAILURE');
            }
          };
          final result = await c.retryCleanup();
          expect(done, true);
          expect(result, outcome == 'success');
          expect(c.isCleanupRequired, outcome == 'failure');
          expect(c.pendingCleanupSession, outcome == 'failure' ? epoch('A') : null);
        });
      }
    }

    for (final outcome in ['success', 'failure']) {
      for (final replacement in ['uidB', 'sameUid']) {
        test('C2 cancellation $replacement $outcome protects newer cancellation (F03-F04)', () async {
          final a = f.TestAuthService(f.FakeUser('A'));
          final l = CensusLocation()
            ..startServiceResult = false
            ..nextPreparedSessionId = 'cancel-A'
            ..nextPreparedGeneration = 2
            ..nextPreparedAttemptSeq = 3
            ..mockLifecycleSeq = 7
            ..currentPos = DriverPosition(
              latitude: 19,
              longitude: 73,
              timestamp: DateTime.utc(2026, 10, 2),
            )
            ..cancelError = PlatformException(code: 'OLD_CANCEL_FAILED');

          final c = DutyController(locationService: l, authService: a);
          addTearDown(c.dispose);
          addTearDown(a.dispose);

          c.updateProfile(profile(epoch('A'), on: false));
          expect(await c.requestGoOnDuty(onShowDisclosure: () async => true), false);
          expect(c.pendingCancelSessionId, 'cancel-A');

          final entered = Completer<void>(), release = Completer<void>();
          var held = false;
          l.cancelError = null;
          l.hook = (b) async {
            if (b == 'cancel' && !held) {
              held = true;
              entered.complete();
              await release.future;
              if (outcome == 'failure') throw PlatformException(code: 'A_CANCEL_RETRY_FAILED');
            }
          };

          final old = c.retryCleanup();
          await entered.future.timeout(const Duration(seconds: 5));
          l.hook = null;

          final uid = replacement == 'uidB' ? 'B' : 'A';
          if (uid == 'B') {
            a.emitUser(f.FakeUser('B'));
            await flush();
          }

          c.clearOwnedAuthority();
          c.clearError();
          l.nextPreparedSessionId = 'cancel-new';
          l.nextPreparedGeneration = 3;
          l.nextPreparedAttemptSeq = 4;
          l.cancelError = PlatformException(code: 'NEW_CANCEL_FAILED');
          c.updateProfile(profile(epoch(uid), on: false));
          expect(await c.requestGoOnDuty(onShowDisclosure: () async => true), false);
          expect(c.pendingCancelSessionId, 'cancel-new');

          final before = snapshot(c);
          release.complete();
          await old;
          final after = snapshot(c);

          expect(
            after,
            before,
            reason: 'Old retry cannot clear/restore newer cancellation or replace its error',
          );
        });
      }
    }
  });
}
