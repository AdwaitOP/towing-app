import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';

// Fresh independent platform-response model. This exercises production Dart
// acquisition, adapter STOP serialization, and logout; it is not native proof.
class AuditUser implements User {
  AuditUser(this.uid);
  @override final String uid;
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class AuditAuth extends AuthService {
  User? user = AuditUser('A');
  int signOuts = 0;
  @override User? get currentUser => user;
  @override Future<void> signOut() async { signOuts++; user = null; }
}

DurableDutyOwnerRecord epoch(int generation, int lifecycle, {String uid = 'A'}) =>
    DurableDutyOwnerRecord(uid: uid, sessionId: 'S', generation: generation,
      lifecycleSeq: lifecycle, startedAt: DateTime.utc(2026, 10, 1));

Map<String, dynamic> serverOff() => <String, dynamic>{
  'uid': 'A', 'name': 'Audit Driver', 'phone': '+919876543210',
  'truckType': 'flatbed', 'vehicleNumber': 'MH01AA1234',
  'isOnDuty': false, 'verificationStatus': 'approved',
};

class AuditAdapter extends DriverLocationService {
  Future<Map<String, dynamic>?> Function()? serverRead;
  @override Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async =>
      serverRead != null ? await serverRead!() : serverOff();
}

class AuditNativeResponses {
  DurableDutyOwnerRecord? owner = epoch(2, 7);
  bool running = true;
  int ownerReads = 0, runningReads = 0, serial = 0;
  final leases = <String, NativeCleanupAcquisition>{};
  final acquisitions = <NativeCleanupAcquisition>[];
  final stops = <Map<String, dynamic>>[];
  final events = <String>[];
  Future<void> Function(String, int)? onRead;
  void install(DurableDutyOwnerRecord value) { owner = value; running = true; }

  Future<Object?> handle(MethodCall call) async {
    events.add(call.method);
    final args = call.arguments == null ? <String, dynamic>{}
        : Map<String, dynamic>.from(call.arguments as Map);
    switch (call.method) {
      case 'beginCleanupAcquisition':
        final lease = NativeCleanupAcquisition('fresh-${++serial}',
            args['operationId'] as String, owner);
        leases[lease.token] = lease; acquisitions.add(lease);
        return <String, dynamic>{'token': lease.token,
          'operationId': lease.operationId, 'captured': owner != null,
          if (owner != null) 'owner': owner!.encode()};
      case 'validateCleanupAcquisition':
        return leases[args['token']]?.operationId == args['operationId'];
      case 'releaseCleanupAcquisition':
        final valid = leases[args['token']]?.operationId == args['operationId'];
        if (valid) leases.remove(args['token']);
        return valid;
      case 'getDurableOwner':
        ownerReads++;
        if (onRead != null) await onRead!('owner', ownerReads);
        return owner?.encode();
      case 'isServiceRunning':
        runningReads++;
        if (onRead != null) await onRead!('running', runningReads);
        return running;
      case 'atomicStopService':
        stops.add(args);
        final lease = leases[args['cleanupToken']];
        final captured = lease?.owner;
        final exact = captured != null &&
            lease!.operationId == args['cleanupOperationId'] &&
            captured.uid == args['expectedUid'] &&
            captured.sessionId == args['expectedSessionId'] &&
            captured.generation == args['expectedGeneration'] &&
            captured.lifecycleSeq == args['expectedLifecycleSeq'];
        if (!exact) return <String, dynamic>{'success': false, 'reason': 'bad_lease'};
        if (owner != null && (owner!.uid != captured.uid ||
            owner!.sessionId != captured.sessionId ||
            owner!.generation != captured.generation ||
            owner!.lifecycleSeq != captured.lifecycleSeq)) {
          return <String, dynamic>{'success': false, 'reason': 'ownership_transferred'};
        }
        owner = null; running = false;
        return <String, dynamic>{'success': true, 'stopped': true};
      default: throw PlatformException(code: 'unexpected', message: call.method);
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AuditNativeResponses native;
  late AuditAuth auth;
  late AuditAdapter adapter;
  Future<LogoutResult> logout() => AppLogoutCoordinator(
      authService: auth, locationService: adapter).coordinateLogout();
  setUp(() {
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
    DriverLocationService.resetPendingCleanupTokensForTesting();
    NativeOwnershipCoordinator.resetTestSimulation();
    native = AuditNativeResponses(); auth = AuditAuth(); adapter = AuditAdapter();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, native.handle);
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
    NativeOwnershipCoordinator.resetTestSimulation();
  });

  test('H cold adapter captures G2 L7 and exact STOP verifies absence', () async {
    expect(adapter.currentServiceSession, isNull);
    expect(adapter.currentLifecycleSeq, isNull);
    expect(await logout(), LogoutResult.success);
    expect(native.acquisitions.single.owner!.lifecycleSeq, 7);
    expect(native.stops.single['expectedGeneration'], 2);
    expect(native.stops.single['expectedLifecycleSeq'], 7);
    expect(native.stops.single['cleanupToken'], native.acquisitions.single.token);
    expect(native.events.first, 'beginCleanupAcquisition');
    expect(native.owner, isNull); expect(native.running, isFalse);
    expect(auth.signOuts, 1); expect(native.leases, isEmpty);
  });

  for (final replacement in [epoch(3, 8), epoch(2, 8), epoch(3, 1), epoch(3, 8, uid: 'B')]) {
    test('first observation replacement ${replacement.uid} G${replacement.generation} L${replacement.lifecycleSeq}', () async {
      native.onRead = (kind, n) async {
        if (kind == 'owner' && n == 1) native.install(replacement);
      };
      expect(await logout(), LogoutResult.failedDutyTransition);
      expect(native.acquisitions.single.owner!.lifecycleSeq, 7);
      expect(native.acquisitions.single.owner!.generation, 2);
      expect(native.owner!.encode(), replacement.encode());
      expect(native.stops, isEmpty); expect(auth.signOuts, 0);
    });
  }

  test('E NONE cannot adopt owner appearing after acquisition', () async {
    native.owner = null; native.running = false;
    native.onRead = (kind, n) async {
      if (kind == 'owner' && n == 1) native.install(epoch(3, 8));
    };
    expect(await logout(), LogoutResult.failedDutyTransition);
    expect(native.acquisitions.single.owner, isNull);
    expect(native.stops, isEmpty); expect(auth.signOuts, 0);
    expect(native.owner!.lifecycleSeq, 8);
  });

  for (final boundary in [('running', 2), ('owner', 3), ('owner', 4), ('owner', 5), ('running', 3)]) {
    test('I replacement at verification ${boundary.$1} ${boundary.$2}', () async {
      native.onRead = (kind, n) async {
        if (kind == boundary.$1 && n == boundary.$2) native.install(epoch(3, 8));
      };
      expect(await logout(), LogoutResult.failedDutyTransition);
      expect(native.stops.single['expectedLifecycleSeq'], 7);
      expect(native.owner!.lifecycleSeq, 8); expect(native.running, isTrue);
      expect(auth.signOuts, 0);
    });
  }

  for (final boundary in [('owner', 1), ('running', 1), ('owner', 2), ('running', 2), ('owner', 3), ('owner', 4), ('owner', 5), ('running', 3)]) {
    test('unknown read at ${boundary.$1} ${boundary.$2} blocks signout', () async {
      native.onRead = (kind, n) async {
        if (kind == boundary.$1 && n == boundary.$2) {
          throw PlatformException(code: 'independent_read_failure');
        }
      };
      expect(await logout(), LogoutResult.failedDutyTransition);
      expect(auth.signOuts, 0); expect(native.leases, isEmpty);
    });
  }

  test('auth UID replacement during owner discovery survives logout', () async {
    native.onRead = (kind, n) async {
      if (kind == 'owner' && n == 1) auth.user = AuditUser('B');
    };
    expect(await logout(), LogoutResult.failedDutyTransition);
    expect(auth.user!.uid, 'B'); expect(auth.signOuts, 0);
    expect(native.stops, isEmpty); expect(native.leases, isEmpty);
  });

  test('same UID calls join one acquisition and signout', () async {
    final gate = Completer<void>();
    adapter.serverRead = () async { await gate.future; return serverOff(); };
    final first = logout(); final second = logout();
    gate.complete();
    expect(await first, LogoutResult.success);
    expect(await second, LogoutResult.success);
    expect(native.acquisitions, hasLength(1)); expect(auth.signOuts, 1);
  });
}
