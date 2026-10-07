import 'dart:async';
import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';

// Independently authored against the CURRENT production interfaces on 2026-10-01.
// No historical probe, source snapshot, or prior PASS/FAIL data is consumed.
class AuditUser implements User {
  AuditUser(this.uid);
  @override
  final String uid;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class AuditAuth implements AuthService {
  User? user = AuditUser('UID-A');
  final changes = StreamController<User?>.broadcast(sync: true);
  @override
  User? get currentUser => user;
  @override
  Stream<User?> get authStateChanges => changes.stream;
  void switchUid(String? uid) {
    user = uid == null ? null : AuditUser(uid);
    changes.add(user);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

typedef ReadOwner = Future<DurableDutyOwnerRecord?> Function();

class AuditLocation implements LocationService {
  final ownerReads = <ReadOwner>[];
  final calls = <String>[];
  Future<void> Function()? end;
  Future<void> Function()? transaction;
  Future<void> Function()? stop;
  Future<bool> Function()? running;
  Future<DutySession?> Function()? durable;
  int ownerReadCount = 0;

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() {
    calls.add('READ_OWNER:${++ownerReadCount}');
    if (ownerReads.isEmpty) return Future.value(null);
    return ownerReads.removeAt(0)();
  }

  @override
  Future<DutySession?> getDurableSession() async {
    calls.add('READ_SESSION');
    return durable == null ? null : await durable!();
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    calls.add('RUNNING');
    return running == null ? false : await running!();
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    calls.add('END:$uid:$sessionId:$generation:$lifecycleSeq');
    await end?.call();
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    calls.add('TRANSACTION:$uid');
    await transaction?.call();
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    calls.add('STOP:$expectedUid:$expectedSessionId:$expectedGeneration:$expectedLifecycleSeq');
    await stop?.call();
  }

  @override
  int? get currentGeneration => null;
  @override
  int? get currentLifecycleSeq => null;
  @override
  DutySession? get currentServiceSession => null;
  @override
  void dispose() => calls.add('DISPOSE');
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);

  int get ends => calls.where((s) => s.startsWith('END:')).length;
  int get stops => calls.where((s) => s.startsWith('STOP:')).length;
  int get transactions => calls.where((s) => s.startsWith('TRANSACTION:')).length;
}

DriverProfile cleanOff(String uid) => DriverProfile(
      uid: uid,
      name: 'Audit driver',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'AUDIT-1',
      verificationStatus: 'approved',
      isOnDuty: false,
      workerReady: false,
    );

DurableDutyOwnerRecord exactOwner() => DurableDutyOwnerRecord(
      uid: 'UID-A',
      sessionId: 'SESSION-A',
      generation: 41,
      lifecycleSeq: 7,
      startedAt: DateTime.utc(2026, 10, 1),
    );

Map<String, Object?> snapshot(DutyController c) => {
      'profileUid': c.currentProfile?.uid,
      'profile': c.currentProfile,
      'boundUid': c.boundUid,
      'state': c.authoritativeDutyState,
      'desired': c.desiredDutyState,
      'health': c.trackingHealth,
      'errorCode': c.lastErrorCode,
      'errorMessage': c.lastErrorMessage,
      'errorDetails': c.lastErrorDetails,
      'errorCategory': c.errorCategory,
      'cleanupRequired': c.isCleanupRequired,
      'activeAuthority': c.activeSession,
      'activeLifecycleSeq': c.activeLifecycleSeq,
      'pendingAuthority': c.pendingCleanupSession,
      'pendingCancellation': c.pendingCancellation,
      'loading': c.isLoading,
      'reconciling': c.isReconciling,
      'logout': c.isLogoutInProgress,
      'ready': c.isReady,
      'canToggle': c.canToggleDuty,
    };

void evidence(String label, DutyController c, AuditLocation location) {
  // ignore: avoid_print
  print('FRESH_CALLER1 $label ${jsonEncode({
        for (final e in snapshot(c).entries) e.key: e.value?.toString(),
        'END': location.ends,
        'STOP': location.stops,
        'TRANSACTION': location.transactions,
        'trace': location.calls,
      })}');
}

Future<void> settle() async {
  for (var i = 0; i < 12; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class Fixture {
  final auth = AuditAuth();
  final location = AuditLocation();
  late final DutyController controller;
  bool disposed = false;
  Fixture() {
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(cleanOff('UID-A'));
  }

  void deliverB() {
    auth.switchUid('UID-B');
    controller.updateProfile(cleanOff('UID-B'));
    expect(controller.currentProfile?.uid, 'UID-B');
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(controller.trackingHealth, TrackingHealth.off);
    expect(controller.lastError, isNull);
    expect(controller.isCleanupRequired, false);
  }

  Future<void> close() async {
    if (!disposed) controller.dispose();
    await auth.changes.close();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('historical A owner-read failure cannot mutate clean B OFF', () async {
    final f = Fixture();
    addTearDown(f.close);
    final held = Completer<DurableDutyOwnerRecord?>();
    f.location.ownerReads.add(() => held.future);
    final a = f.controller.requestGoOffDuty();
    await settle();
    expect(f.location.ownerReadCount, 1, reason: 'A must actually await owner read');
    f.deliverB();
    final before = snapshot(f.controller);
    evidence('historical_before_failure', f.controller, f.location);
    held.completeError(PlatformException(code: 'A_OWNER_READ_FAILED', message: 'fresh suspended A failure'));
    expect(await a, false);
    expect(snapshot(f.controller), before);
    expect(f.location.ends, 0);
    expect(f.location.stops, 0);
    expect(f.location.transactions, 0);
    evidence('historical_after_failure', f.controller, f.location);
  });

  test('A successful stale owner-read cannot mutate B or begin teardown', () async {
    final f = Fixture();
    addTearDown(f.close);
    final held = Completer<DurableDutyOwnerRecord?>();
    f.location.ownerReads.add(() => held.future);
    final a = f.controller.requestGoOffDuty();
    await settle();
    expect(f.location.ownerReadCount, 1);
    f.deliverB();
    final before = snapshot(f.controller);
    held.complete(exactOwner());
    expect(await a, false);
    expect(snapshot(f.controller), before);
    expect(f.location.ends, 0);
    expect(f.location.stops, 0);
    expect(f.location.transactions, 0);
    evidence('stale_success', f.controller, f.location);
  });

  test('current owner-read failure remains truthful and actionable', () async {
    final f = Fixture();
    addTearDown(f.close);
    final held = Completer<DurableDutyOwnerRecord?>();
    f.location.ownerReads.add(() => held.future);
    final a = f.controller.requestGoOffDuty();
    await settle();
    expect(f.controller.isLoading, true);
    held.completeError(PlatformException(code: 'A_OWNER_READ_FAILED', message: 'current A read failure'));
    expect(await a, false);
    expect(f.controller.currentProfile?.uid, 'UID-A');
    expect(f.controller.lastErrorCode, 'A_OWNER_READ_FAILED');
    expect(f.controller.lastErrorMessage, 'current A read failure');
    expect(f.controller.trackingHealth, TrackingHealth.reconciliationFailed);
    expect(f.controller.isCleanupRequired, true);
    expect(f.controller.lastError?.cleanupRequired, true);
    expect(f.controller.isLoading, false);
    expect(f.controller.canToggleDuty, false);
    expect(f.location.ends, 0);
    expect(f.location.stops, 0);
    evidence('legitimate_failure', f.controller, f.location);
  });

  for (final withPending in [false, true]) {
    test('same UID O1 failure preserves held O2 winner; pending=$withPending', () async {
      final f = Fixture();
      addTearDown(f.close);
      if (withPending) {
        f.location.ownerReads.add(() async => exactOwner());
        f.location.stop = () async => throw PlatformException(code: 'SETUP_STOP_FAILED');
        expect(await f.controller.requestGoOffDuty(), false);
        expect(f.controller.pendingCleanupSession, const DutySession(uid: 'UID-A', sessionId: 'SESSION-A', generation: 41, lifecycleSeq: 7));
        expect(f.controller.activeSession, isNull);
        f.location.stop = null;
      }
      final o1Held = Completer<DurableDutyOwnerRecord?>();
      final o2Held = Completer<DurableDutyOwnerRecord?>();
      final o2Entered = Completer<void>();
      f.location.ownerReads.addAll([
        () => o1Held.future,
        () {
          o2Entered.complete();
          return o2Held.future;
        },
      ]);
      final oldEnds = f.location.ends;
      final oldStops = f.location.stops;
      final o1 = f.controller.requestGoOffDuty();
      await settle();
      expect(f.controller.isLoading, true);
      final o2 = f.controller.requestGoOffDuty();
      final winnerBefore = snapshot(f.controller);
      evidence('O2_owns_before_old_failure_pending_$withPending', f.controller, f.location);
      o1Held.completeError(PlatformException(code: 'O1_OWNER_READ_FAILED'));
      expect(await o1, false);
      await o2Entered.future.timeout(const Duration(seconds: 2));
      expect(snapshot(f.controller), winnerBefore, reason: 'O1 failure and finalizer must preserve every O2 public field');
      expect(f.controller.isLoading, true, reason: 'O1 cannot clear O2 loading');
      expect(f.location.ends, oldEnds);
      expect(f.location.stops, oldStops);
      evidence('O2_still_owns_after_old_failure_pending_$withPending', f.controller, f.location);
      // There is no public winning-token getter. O2 reaching its read proves
      // O1 did not erase the queued winner; O2 applying its own unique failure
      // proves its complete operation token/generation fence still owns writes.
      o2Held.completeError(PlatformException(code: 'O2_OWNER_READ_FAILED'));
      expect(await o2, false);
      expect(f.controller.lastErrorCode, 'O2_OWNER_READ_FAILED');
      expect(f.controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(f.controller.isCleanupRequired, true);
      expect(f.controller.isLoading, false);
      expect(f.controller.pendingCleanupSession, winnerBefore['pendingAuthority']);
      expect(f.location.ends, oldEnds);
      expect(f.location.stops, oldStops);
      evidence('O2_winner_proof_pending_$withPending', f.controller, f.location);
    });
  }

  test('generation invalidation fences owner-read failure', () async {
    final f = Fixture();
    addTearDown(f.close);
    final held = Completer<DurableDutyOwnerRecord?>();
    f.location.ownerReads.add(() => held.future);
    final a = f.controller.requestGoOffDuty();
    await settle();
    f.controller.updateProfile(cleanOff('UID-A').copyWith(activeJobId: 'JOB-NEW'));
    expect(f.controller.isLoading, false);
    final before = snapshot(f.controller);
    held.completeError(PlatformException(code: 'A_OWNER_READ_FAILED'));
    expect(await a, false);
    expect(snapshot(f.controller), before);
    expect(f.location.ends, 0);
    expect(f.location.stops, 0);
    evidence('generation_invalidated', f.controller, f.location);
  });

  test('logout barrier fences owner-read failure and old finalizer', () async {
    final f = Fixture();
    addTearDown(f.close);
    final held = Completer<DurableDutyOwnerRecord?>();
    f.location.ownerReads.add(() => held.future);
    final a = f.controller.requestGoOffDuty();
    await settle();
    final logout = f.controller.beginLogoutBarrier('UID-A');
    final before = snapshot(f.controller);
    held.completeError(PlatformException(code: 'A_OWNER_READ_FAILED'));
    expect(await a, false);
    expect(snapshot(f.controller), before);
    expect(f.location.ends, 0);
    expect(f.location.stops, 0);
    f.controller.endLogoutBarrier(logout);
    expect(f.controller.isLogoutInProgress, false);
    evidence('logout_fenced', f.controller, f.location);
  });

  test('disposal fences owner-read failure and suppresses writes', () async {
    final f = Fixture();
    addTearDown(f.close);
    final held = Completer<DurableDutyOwnerRecord?>();
    f.location.ownerReads.add(() => held.future);
    final a = f.controller.requestGoOffDuty();
    await settle();
    f.controller.dispose();
    f.disposed = true;
    final before = snapshot(f.controller);
    held.completeError(PlatformException(code: 'A_OWNER_READ_FAILED'));
    expect(await a, false);
    expect(snapshot(f.controller), before);
    expect(f.location.ends, 0);
    expect(f.location.stops, 0);
    evidence('disposed_fenced', f.controller, f.location);
  });

  // Each held failure resumes a distinct production failure continuation.
  for (final boundary in ['END', 'TRANSACTION', 'RUNNING', 'STOP', 'ABSENCE_OWNER', 'ABSENCE_SESSION']) {
    test('cross UID stale $boundary failure continuation preserves B', () async {
      final f = Fixture();
      addTearDown(f.close);
      final entered = Completer<void>();
      final held = Completer<void>();
      Future<void> hold() {
        entered.complete();
        return held.future;
      }

      if (boundary == 'END' || boundary == 'STOP') {
        f.location.ownerReads.add(() async => exactOwner());
      }
      if (boundary == 'END') f.location.end = hold;
      if (boundary == 'TRANSACTION') f.location.transaction = hold;
      if (boundary == 'RUNNING') {
        f.location.running = () async {
          await hold();
          return false;
        };
      }
      if (boundary == 'STOP') f.location.stop = hold;
      if (boundary == 'ABSENCE_OWNER') {
        f.location.ownerReads.addAll([
          () async => null,
          () async {
            await hold();
            return null;
          },
        ]);
      }
      if (boundary == 'ABSENCE_SESSION') {
        f.location.durable = () async {
          await hold();
          return null;
        };
      }
      final a = f.controller.requestGoOffDuty();
      await entered.future.timeout(const Duration(seconds: 2));
      // Some paths have already recorded A cleanup before the held boundary.
      // B's delivered OFF state itself is preserved, whatever its existing
      // cleanup metadata; no subsequent A failure may mutate any of it.
      f.auth.switchUid('UID-B');
      f.controller.updateProfile(cleanOff('UID-B'));
      final before = snapshot(f.controller);
      final endsBefore = f.location.ends;
      final stopsBefore = f.location.stops;
      held.completeError(PlatformException(code: 'A_${boundary}_FAILED'));
      expect(await a, false);
      expect(snapshot(f.controller), before);
      expect(f.location.ends, endsBefore);
      expect(f.location.stops, stopsBefore);
      evidence('stale_${boundary}_failure', f.controller, f.location);
    });
  }
}
