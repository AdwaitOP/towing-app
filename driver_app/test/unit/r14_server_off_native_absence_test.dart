import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'duty_controller_test.dart' as f;

class ServerOffLocationService extends DriverLocationService {
  Future<void> Function()? beforeServerRead;
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async {
    await beforeServerRead?.call();
    return {
      'uid': uid,
      'name': 'Driver A',
      'phone': '+919876543210',
      'truckType': 'flatbed',
      'vehicleNumber': 'MH 12 AB 1234',
      'verificationStatus': 'approved',
      'isOnDuty': false,
    };
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    fail('Fresh server OFF requires no additional END');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const exact = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 2,
    lifecycleSeq: 7,
  );
  const newer = DutySession(
    uid: 'uid-a',
    sessionId: 'session-a',
    generation: 2,
    lifecycleSeq: 8,
  );
  const other = DutySession(
    uid: 'uid-b',
    sessionId: 'session-b',
    generation: 3,
    lifecycleSeq: 8,
  );
  const profile = DriverProfile(
    uid: 'uid-a',
    name: 'Driver A',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 AB 1234',
    verificationStatus: 'approved',
    isOnDuty: false,
  );
  late f.TestAuthService auth;
  late ServerOffLocationService location;
  late DutyController controller;
  DutySession? owner, session, replacement, postOwner, postSession;
  Object? postRunning;
  bool stopped = false, running = true, failStop = false;
  bool installPendingOnSessionRead = false, pendingOwnerState = false;
  String? failRead;
  int postOwnerReads = 0;
  Completer<void>? gate;
  String gatedRead = 'owner';
  bool readHeld = false;
  final stops = <DutySession>[];
  final events = <String>[];
  final acknowledgements = <Map<String, dynamic>>[];

  String? encode(DutySession? value) => value == null
      ? null
      : DurableDutyOwnerRecord(
          uid: value.uid,
          sessionId: value.sessionId,
          generation: value.generation,
          lifecycleSeq: value.lifecycleSeq!,
          state: pendingOwnerState ? 'PENDING_START' : 'ACTIVE',
          startedAt: DateTime.utc(2026, 10, 1),
        ).encode();
  void actionable() {
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
    expect(controller.isCleanupRequired, isTrue);
    expect(controller.pendingCleanupSession, exact);
    expect(controller.lastError?.cleanupRequired, isTrue);
    expect(controller.activeSession, isNull);
    expect(controller.activeLifecycleSeq, isNull);
    expect(stops, [exact]);
  }

  void clean({bool afterRetry = false}) {
    expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
    expect(controller.trackingHealth, TrackingHealth.off);
    expect(controller.isCleanupRequired, isFalse);
    expect(controller.pendingCleanupSession, isNull);
    if (afterRetry) {
      // Existing retry semantics retain the historical error, with cleanup
      // cleared; they do not erase the original diagnostic.
      expect(controller.lastError?.cleanupRequired, isFalse);
      expect(controller.lastError?.cleanupErrorCode, isNull);
      expect(controller.errorCategory, isNull);
    } else {
      expect(controller.lastError, isNull);
    }
    expect(controller.activeSession, isNull);
    expect(owner, isNull);
    expect(session, isNull);
    expect(running, isFalse);
  }

  setUp(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    auth = f.TestAuthService(f.FakeUser(exact.uid));
    owner = session = exact;
    replacement = postOwner = postSession = null;
    postRunning = false;
    stopped = failStop = false;
    running = true;
    installPendingOnSessionRead = pendingOwnerState = false;
    failRead = null;
    postOwnerReads = 0;
    gate = null;
    gatedRead = 'owner';
    readHeld = false;
    stops.clear();
    events.clear();
    acknowledgements.clear();
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (
      call,
    ) async {
      switch (call.method) {
        case 'getDurableOwner':
          if (!stopped) {
            events.add('initial-owner');
            return encode(owner);
          }
          postOwnerReads++;
          final kind = postOwnerReads.isOdd ? 'owner' : 'session';
          events.add(kind);
          if (installPendingOnSessionRead && postOwnerReads == 2) {
            owner = session = other;
            pendingOwnerState = true;
          }
          if (gate != null &&
              ((gatedRead == kind && postOwnerReads <= 2) ||
                  (gatedRead == 'final-owner' && postOwnerReads == 3))) {
            readHeld = true;
            await gate!.future;
          }
          if (failRead == kind ||
              (failRead == 'final-owner' && postOwnerReads == 3)) {
            throw PlatformException(code: 'READ_FAILED');
          }
          // getDurableSession uses a separate production getDurableOwner read.
          return encode(kind == 'owner' ? owner : session);
        case 'isServiceRunning':
          events.add(stopped ? 'running' : 'initial-running');
          if (stopped && gate != null && gatedRead == 'running') {
            readHeld = true;
            await gate!.future;
          }
          if (stopped && failRead == 'running') {
            throw PlatformException(code: 'READ_FAILED');
          }
          return stopped ? postRunning : running;
        case 'atomicStopService':
          events.add('stop');
          final args = Map<String, dynamic>.from(call.arguments as Map);
          expect(args.keys.toSet(), {
            'expectedUid',
            'expectedSessionId',
            'expectedGeneration',
            'expectedLifecycleSeq',
          });
          final selector = DutySession(
            uid: args['expectedUid'] as String,
            sessionId: args['expectedSessionId'] as String,
            generation: args['expectedGeneration'] as int,
            lifecycleSeq: args['expectedLifecycleSeq'] as int,
          );
          stops.add(selector);
          expect(selector, exact);
          stopped = true;
          if (failStop) throw PlatformException(code: 'STOP_FAILED');
          if (replacement != null) {
            owner = session = replacement;
            running = false;
          }
          final mismatch = owner != selector;
          if (!mismatch) {
            owner = postOwner;
            session = postSession;
            running = postRunning != false;
          }
          final ack = {
            'success': true,
            'stopped': !mismatch,
            if (mismatch) 'reason': 'mismatch',
          };
          acknowledgements.add(ack);
          return ack;
        default:
          throw StateError('Unexpected native call ${call.method}');
      }
    });
    location = ServerOffLocationService();
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(profile);
  });
  tearDown(() {
    controller.dispose();
    auth.dispose();
    messenger.setMockMethodCallHandler(
      NativeOwnershipCoordinator.channel,
      null,
    );
    NativeOwnershipCoordinator.resetTestSimulation();
  });

  test('SOFF-ABS-1 exact cleanup and verified global absence', () async {
    await controller.reconcileDutyState();
    clean();
    expect(stops, [exact]);
    expect(events.sublist(events.indexOf('stop') + 1), [
      'owner',
      'session',
      'running',
      'owner',
    ]);
  });
  for (final value in [other, newer]) {
    test(
      'SOFF-ABS-${value.uid == exact.uid ? 3 : 2} replacement survives mismatch with running=false',
      () async {
        replacement = value;
        await controller.reconcileDutyState();
        actionable();
        expect(acknowledgements.single, {
          'success': true,
          'stopped': false,
          'reason': 'mismatch',
        });
        expect(owner, value);
        expect(session, value);
        expect(running, isFalse);
        expect(events.sublist(events.indexOf('stop') + 1), [
          'owner',
          'session',
          'running',
        ]);
        expect(await controller.retryCleanup(), isFalse);
        expect(stops, [exact, exact]);
        expect(owner, value);
        expect(session, value);
        expect(controller.pendingCleanupSession, exact);
      },
    );
  }
  test('SOFF-ABS-4 absent owner but surviving durable session', () async {
    postSession = other;
    await controller.reconcileDutyState();
    actionable();
    expect(owner, isNull);
    expect(session, other);
    expect(running, isFalse);
    expect(events, contains('session'));
  });
  test('SOFF-ABS-5 surviving owner but absent session', () async {
    postOwner = other;
    await controller.reconcileDutyState();
    actionable();
    expect(owner, other);
    expect(session, isNull);
    expect(running, isFalse);
  });
  test('SOFF-ABS-6 worker true without owner or session', () async {
    postRunning = true;
    await controller.reconcileDutyState();
    actionable();
    expect(owner, isNull);
    expect(session, isNull);
    expect(running, isTrue);
  });
  for (final value in [null, 'false']) {
    test('SOFF-ABS-7 unknown or malformed running $value', () async {
      postRunning = value;
      await controller.reconcileDutyState();
      actionable();
      expect(owner, isNull);
      expect(session, isNull);
    });
  }
  for (final read in ['owner', 'session', 'running', 'final-owner']) {
    test('SOFF-ABS-8 required $read read throws', () async {
      failRead = read;
      await controller.reconcileDutyState();
      actionable();
    });
  }
  for (final scenario in ['replacement', 'unknown']) {
    test(
      'SOFF-ABS-9 exact retry after $scenario waits for global absence',
      () async {
        if (scenario == 'replacement') {
          replacement = other;
        } else {
          postRunning = null;
        }
        await controller.reconcileDutyState();
        actionable();
        expect(await controller.retryCleanup(), isFalse);
        owner = session = replacement = null;
        running = false;
        postRunning = false;
        expect(await controller.retryCleanup(), isTrue);
        clean(afterRetry: true);
        expect(stops, [exact, exact, exact]);
      },
    );
  }
  test('R14 server-OFF STOP failure retains original exact cleanup', () async {
    failStop = true;
    await controller.reconcileDutyState();
    actionable();
    expect(owner, exact);
    expect(session, exact);
  });
  test(
    'R14 non-ACTIVE replacement cannot disappear behind durable session conversion',
    () async {
      installPendingOnSessionRead = true;
      await controller.reconcileDutyState();
      actionable();
      expect(owner, other);
      expect(session, other);
      expect(pendingOwnerState, isTrue);
      expect(controller.canToggleDuty, isFalse);
    },
  );
  test(
    'R14 native absence must be refreshed after the fresh server await',
    () async {
      owner = session = null;
      running = false;
      location.beforeServerRead = () async {
        owner = session = other;
      };
      await controller.reconcileDutyState();
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.canToggleDuty, isFalse);
      expect(controller.isReady, isFalse);
      expect(controller.activeSession, isNull);
      expect(stops, isEmpty);
      expect(owner, other);
      expect(session, other);
    },
  );
  for (final read in ['owner', 'session', 'running', 'final-owner']) {
    test(
      'R14 late initial absence $read failure remains non-actionable',
      () async {
        owner = session = null;
        running = false;
        location.beforeServerRead = () async {
          stopped = true;
          failRead = read;
        };
        await controller.reconcileDutyState();
        expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
        expect(controller.canToggleDuty, isFalse);
        expect(controller.isReady, isFalse);
        expect(controller.lastError?.code, 'READ_FAILED');
        expect(stops, isEmpty);
        controller.updateProfile(profile);
        expect(controller.canToggleDuty, isFalse);
        expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      },
    );
  }
  for (final value in [other, newer]) {
    test(
      'R14 repeated reconciliation retains the original cleanup selector ${value.uid}',
      () async {
        replacement = value;
        await controller.reconcileDutyState();
        actionable();

        await controller.reconcileDutyState();
        expect(stops, [exact, exact]);
        expect(owner, value);
        expect(session, value);
        expect(controller.pendingCleanupSession, exact);
        expect(controller.isCleanupRequired, isTrue);
        expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
        expect(controller.canToggleDuty, isFalse);
      },
    );
  }
  test(
    'R14 dismissal and profile callbacks cannot clear replacement residue',
    () async {
      replacement = other;
      await controller.reconcileDutyState();
      actionable();
      controller.clearError();
      controller.updateProfile(profile);
      controller.updateProfile(
        profile.copyWith(
          isOnDuty: true,
          activeDutySessionId: newer.sessionId,
          dutyGeneration: newer.generation,
          lifecycleSeq: newer.lifecycleSeq,
          workerReady: true,
        ),
      );
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.pendingCleanupSession, exact);
      expect(controller.isReady, isFalse);
      expect(controller.canToggleDuty, isFalse);
      expect(stops, [exact]);
      expect(await controller.retryCleanup(), isFalse);
      expect(stops, [exact, exact]);
      expect(owner, other);
      expect(controller.pendingCleanupSession, exact);
    },
  );
  for (final read in ['owner', 'session', 'running', 'final-owner']) {
    test(
      'R14 stale verification cannot clear cleanup after held $read',
      () async {
        gate = Completer<void>();
        gatedRead = read;
        final result = controller.reconcileDutyState();
        while (!readHeld) {
          await Future<void>.delayed(Duration.zero);
        }
        final logoutLease = controller.beginLogoutBarrier(exact.uid);
        gate!.complete();
        await result;
        expect(controller.isLogoutInProgress, isTrue);
        expect(controller.pendingCleanupSession, exact);
        expect(controller.isCleanupRequired, isTrue);
        expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
        expect(controller.canToggleDuty, isFalse);
        expect(stops, [exact]);
        controller.endLogoutBarrier(logoutLease);
        expect(await controller.retryCleanup(), isTrue);
        clean();
      },
    );
  }
  test(
    'R14 server-OFF verification retains actionable selector while held',
    () async {
      gate = Completer<void>();
      final result = controller.reconcileDutyState();
      while (postOwnerReads == 0) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(controller.pendingCleanupSession, exact);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      gate!.complete();
      await result;
      clean();
    },
  );
}
