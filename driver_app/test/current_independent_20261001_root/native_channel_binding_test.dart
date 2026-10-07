import 'dart:async';

import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late List<MethodCall> calls;
  final owner = DurableDutyOwnerRecord(
    sessionId: 'S1', uid: 'A', generation: 4, lifecycleSeq: 11,
    startedAt: DateTime.utc(2026, 10, 1),
  );

  void install(Future<Object?> Function(MethodCall) fn) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
      calls.add(call);
      return fn(call);
    });
  }

  setUp(() { NativeOwnershipCoordinator.resetTestSimulation(); calls = []; });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
    NativeOwnershipCoordinator.resetTestSimulation();
  });

  test('native acquisition pending fences Dart START before await resumes', () async {
    final entered = Completer<void>();
    final held = Completer<Object?>();
    install((call) async {
      if (call.method == 'beginCleanupAcquisition') {
        entered.complete(); return held.future;
      }
      return {'success': true};
    });
    final pending = NativeOwnershipCoordinator.beginCleanupAcquisition('operation1', 'A');
    await entered.future;
    final start = await NativeOwnershipCoordinator.atomicStartService(record: owner);
    expect(start['reason'], 'cleanup_acquisition_pending');
    expect(calls.where((c) => c.method == 'atomicStartService'), isEmpty);
    held.complete({'token': 'native-lease', 'operationId': 'operation1', 'captured': true, 'owner': owner.encode()});
    final lease = await pending;
    expect(lease.owner!.toMap(), owner.toMap());
    expect((calls.single.arguments as Map)['expectedUid'], 'A');
  });

  test('acquisition channel failure releases pending START fence', () async {
    install((call) async {
      if (call.method == 'beginCleanupAcquisition') throw PlatformException(code: 'OWNER_READ_FAILED');
      return {'success': true};
    });
    await expectLater(NativeOwnershipCoordinator.beginCleanupAcquisition('operation1', 'A'), throwsA(isA<PlatformException>()));
    expect((await NativeOwnershipCoordinator.atomicStartService(record: owner))['success'], true);
    expect(calls.where((c) => c.method == 'atomicStartService'), hasLength(1));
  });

  test('invalid acquisition responses cannot create a capability', () async {
    for (final value in <Object?>[
      null,
      {'token': 'lease', 'operationId': 'different', 'captured': true, 'owner': owner.encode()},
      {'token': 4, 'operationId': 'operation1', 'captured': true, 'owner': owner.encode()},
      {'token': 'lease', 'operationId': 'operation1', 'captured': 'true', 'owner': owner.encode()},
      {'token': 'lease', 'operationId': 'operation1', 'captured': true, 'owner': null},
      {'token': 'lease', 'operationId': 'operation1', 'captured': true, 'owner': '{broken'},
    ]) {
      install((_) async => value);
      await expectLater(NativeOwnershipCoordinator.beginCleanupAcquisition('operation1', 'A'), throwsA(anything));
    }
  });

  test('DriverLocationService STOP forwards captured lease through lifecycle await', () async {
    final lease = NativeCleanupAcquisition('native-lease', 'operation1', owner);
    install((call) async => call.method == 'validateCleanupAcquisition'
        ? true : {'success': true, 'stopped': true});
    await NativeOwnershipCoordinator.withCleanupAcquisition(lease, () => DriverLocationService().stopForegroundService(
      expectedUid: 'A', expectedSessionId: 'S1', expectedGeneration: 4, expectedLifecycleSeq: 11,
    ));
    final stop = calls.singleWhere((c) => c.method == 'atomicStopService').arguments as Map;
    expect(stop, {
      'expectedUid': 'A', 'expectedSessionId': 'S1', 'expectedGeneration': 4,
      'expectedLifecycleSeq': 11, 'cleanupToken': 'native-lease', 'cleanupOperationId': 'operation1',
    });
  });

  test('absence acquisition cannot acquire a later replacement STOP tuple', () async {
    install((call) async => call.method == 'validateCleanupAcquisition' ? true : {'success': true});
    final lease = NativeCleanupAcquisition('absent-lease', 'operation1', null);
    late Map<String, dynamic> result;
    await NativeOwnershipCoordinator.withCleanupAcquisition(lease, () async {
      result = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'A', expectedSessionId: 'S2', expectedGeneration: 5, expectedLifecycleSeq: 12,
      );
    });
    expect(result['reason'], 'invalid_cleanup_acquisition');
    expect(calls.where((c) => c.method == 'atomicStopService'), isEmpty);
  });

  test('captured acquisition rejects each replacement dimension before STOP dispatch', () async {
    install((call) async => call.method == 'validateCleanupAcquisition' ? true : {'success': true});
    final lease = NativeCleanupAcquisition('native-lease', 'operation1', owner);
    for (final tuple in <List<Object>>[
      ['B', 'S1', 4, 11], ['A', 'S2', 4, 11], ['A', 'S1', 5, 11], ['A', 'S1', 4, 12],
    ]) {
      await NativeOwnershipCoordinator.withCleanupAcquisition(lease, () async {
        final res = await NativeOwnershipCoordinator.atomicStopService(
          expectedUid: tuple[0] as String, expectedSessionId: tuple[1] as String,
          expectedGeneration: tuple[2] as int, expectedLifecycleSeq: tuple[3] as int,
        );
        expect(res['reason'], 'invalid_cleanup_acquisition');
      });
    }
    expect(calls.where((c) => c.method == 'atomicStopService'), isEmpty);
  });

  test('invalidated lease stops before channel destructive dispatch', () async {
    install((call) async => call.method == 'validateCleanupAcquisition' ? false : {'success': true});
    await NativeOwnershipCoordinator.withCleanupAcquisition(NativeCleanupAcquisition('released', 'operation1', owner), () async {
      final res = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'A', expectedSessionId: 'S1', expectedGeneration: 4, expectedLifecycleSeq: 11,
      );
      expect(res['reason'], 'invalid_cleanup_acquisition');
    });
    expect(calls.where((c) => c.method == 'atomicStopService'), isEmpty);
  });

  test('concurrent STOP zones keep distinct operation capabilities', () async {
    final other = DurableDutyOwnerRecord(sessionId: 'S2', uid: 'B', generation: 8, lifecycleSeq: 19, startedAt: DateTime.utc(2026, 10, 1));
    install((call) async {
      await Future<void>.delayed(Duration.zero);
      return call.method == 'validateCleanupAcquisition' ? true : {'success': true, 'stopped': true};
    });
    Future<void> stop(NativeCleanupAcquisition lease) => NativeOwnershipCoordinator.withCleanupAcquisition(lease, () async {
      final o = lease.owner!;
      await NativeOwnershipCoordinator.atomicStopService(expectedUid: o.uid, expectedSessionId: o.sessionId, expectedGeneration: o.generation, expectedLifecycleSeq: o.lifecycleSeq);
    });
    await Future.wait([stop(NativeCleanupAcquisition('leaseA', 'operationA', owner)), stop(NativeCleanupAcquisition('leaseB', 'operationB', other))]);
    final stops = calls.where((c) => c.method == 'atomicStopService').map((c) => c.arguments as Map);
    expect(stops.singleWhere((s) => s['expectedUid'] == 'A')['cleanupToken'], 'leaseA');
    expect(stops.singleWhere((s) => s['expectedUid'] == 'B')['cleanupToken'], 'leaseB');
  });
}
