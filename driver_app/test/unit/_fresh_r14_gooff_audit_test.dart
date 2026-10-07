import 'package:flutter/foundation.dart';
import 'dart:async';

import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:flutter_test/flutter_test.dart';

import 'duty_controller_test.dart' as f;

// Fresh independent R14 audit. Native reads and STOP use the production
// DriverLocationService and NativeOwnershipCoordinator channel adapters.
// END models current server already-OFF success before active epoch fencing.
class AuditGoOffLocation extends DriverLocationService {
  final ends = <DutySession>[];

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
}

class AuditReconcileLocation extends AuditGoOffLocation {
  bool serverOn = true;
  int? mutableSeq = 7;
  final serverHeld = Completer<void>();
  final releaseServer = Completer<void>();
  @override
  int? get currentLifecycleSeq => mutableSeq;
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async {
    if (!serverOn) {
      serverHeld.complete();
      await releaseServer.future;
    }
    return {
      'uid': uid, 'name': 'Driver A', 'phone': '+919876543210',
      'truckType': 'flatbed', 'vehicleNumber': 'MH 12 AB 1234',
      'verificationStatus': 'approved', 'isOnDuty': serverOn,
      'activeDutySessionId': 'S', 'dutyGeneration': 2,
      'lifecycleSeq': 7, 'workerReady': true,
    };
  }
  @override
  Future<bool> isLocationServiceEnabled() async => true;
  @override
  Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async => LocationPermissionStatus.granted;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const old = DutySession(uid: 'uid-a', sessionId: 'S', generation: 2, lifecycleSeq: 7);
  const newSameUid = DutySession(uid: 'uid-a', sessionId: 'S', generation: 2, lifecycleSeq: 8);
  const newUid = DutySession(uid: 'uid-b', sessionId: 'B-S', generation: 3, lifecycleSeq: 8);
  const profile = DriverProfile(
    uid: 'uid-a', name: 'Driver A', phone: '+919876543210',
    truckType: TruckType.flatbed, vehicleNumber: 'MH 12 AB 1234',
    verificationStatus: 'approved', isOnDuty: false,
    activeDutySessionId: 'S', dutyGeneration: 2, lifecycleSeq: 7,
  );

  for (final replacement in [newUid, newSameUid]) {
    test('fresh R14 go-off held discovery preserves ${replacement.uid}/${replacement.lifecycleSeq}', () async {
      NativeOwnershipCoordinator.resetTestSimulation();
      final auth = f.TestAuthService(f.FakeUser(old.uid));
      final location = AuditGoOffLocation();
      final gate = Completer<void>();
      final held = Completer<void>();
      DutySession? owner = old;
      bool running = true;
      bool firstOwner = true;
      final stops = <DutySession>[];
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        switch (call.method) {
          case 'getDurableOwner':
            if (firstOwner) {
              firstOwner = false;
              held.complete();
              await gate.future;
            }
            final current = owner;
            return current == null ? null : DurableDutyOwnerRecord(
              uid: current.uid, sessionId: current.sessionId,
              generation: current.generation, lifecycleSeq: current.lifecycleSeq!,
              startedAt: DateTime.utc(2026, 10, 1),
            ).encode();
          case 'isServiceRunning':
            return running;
          case 'atomicStopService':
            final args = Map<String, dynamic>.from(call.arguments as Map);
            final selector = DutySession(
              uid: args['expectedUid'] as String,
              sessionId: args['expectedSessionId'] as String,
              generation: args['expectedGeneration'] as int,
              lifecycleSeq: args['expectedLifecycleSeq'] as int,
            );
            stops.add(selector);
            if (owner != selector) {
              return {'success': true, 'stopped': false, 'reason': 'mismatch'};
            }
            owner = null;
            running = false;
            return {'success': true, 'stopped': true};
          default:
            throw StateError('Unexpected native call ${call.method}');
        }
      });
      final controller = DutyController(locationService: location, authService: auth);
      controller.updateProfile(profile);
      final stale = controller.requestGoOffDuty();
      await held.future;
      Future<bool>? newer;
      if (replacement.uid != old.uid) {
        // Current Firebase identity can change before authStateChanges delivers
        // its event. Destructive work must independently check current UID.
        auth.mockUser = f.FakeUser(replacement.uid);
      } else {
        // Newer queued intent has already replaced the controller winning token.
        // A1 must not borrow the current post-await A2 native tuple.
        newer = controller.requestGoOffDuty();
      }
      owner = replacement;
      gate.complete();
      final result = await stale;
      debugPrint('AUDIT old=${old.uid}/${old.lifecycleSeq} replacement=${replacement.uid}/${replacement.lifecycleSeq} result=$result stops=$stops owner=$owner running=$running ends=${location.ends}');
      expect(stops.where((s) => s == replacement), isEmpty,
        reason: 'Stale go-off must not discover and destroy replacement authority');
      expect(owner, replacement);
      expect(running, isTrue);
      if (newer != null) await newer;
      controller.dispose();
      auth.dispose();
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
    });
  }

  test('fresh R14 caller4 retained active L7 cannot borrow current L8 after server await', () async {
    NativeOwnershipCoordinator.resetTestSimulation();
    final auth = f.TestAuthService(f.FakeUser(old.uid));
    final location = AuditReconcileLocation();
    DutySession? owner = old;
    bool running = true;
    final stops = <DutySession>[];
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
      switch (call.method) {
        case 'getDurableOwner':
          final current = owner;
          return current == null ? null : DurableDutyOwnerRecord(
            uid: current.uid, sessionId: current.sessionId,
            generation: current.generation, lifecycleSeq: current.lifecycleSeq!,
            startedAt: DateTime.utc(2026, 10, 1),
          ).encode();
        case 'isServiceRunning': return running;
        case 'atomicStopService':
          final args = Map<String, dynamic>.from(call.arguments as Map);
          final selector = DutySession(
            uid: args['expectedUid'] as String,
            sessionId: args['expectedSessionId'] as String,
            generation: args['expectedGeneration'] as int,
            lifecycleSeq: args['expectedLifecycleSeq'] as int,
          );
          stops.add(selector);
          if (owner != selector) return {'success': true, 'stopped': false, 'reason': 'mismatch'};
          owner = null;
          running = false;
          return {'success': true, 'stopped': true};
        default: throw StateError('Unexpected native call ${call.method}');
      }
    });
    final controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(profile.copyWith(isOnDuty: true, workerReady: true));
    await controller.reconcileDutyState();
    expect(controller.activeSession, old);
    expect(controller.isReady, isTrue);
    // Initial native reads now establish absence, while retained controller
    // authority remains L7. Fresh server-OFF await allows current L8 to appear.
    owner = null;
    running = false;
    location.serverOn = false;
    final stale = controller.reconcileDutyState();
    await location.serverHeld.future;
    owner = newSameUid;
    running = true;
    location.mutableSeq = 8;
    location.releaseServer.complete();
    await stale;
    debugPrint('AUDIT caller4 active-old=$old current-new=$newSameUid stops=$stops owner=$owner running=$running cleanup=${controller.pendingCleanupSession}');
    expect(stops.where((s) => s == newSameUid), isEmpty,
      reason: 'Server-OFF reconciliation must preserve captured active lifecycle L7');
    expect(owner, newSameUid);
    expect(running, isTrue);
    controller.dispose();
    auth.dispose();
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
  });
}
