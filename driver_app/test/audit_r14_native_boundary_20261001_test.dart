import 'dart:async';

import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

// Disposable fresh audit: run the real Dart service/channel client against an
// independent exact native ledger. Android execution is audited separately.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const original = DutySession(
    uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 7,
  );
  const replacements = <String, DutySession>{
    'different UID': DutySession(
      uid: 'B', sessionId: 'B-S', generation: 3, lifecycleSeq: 8,
    ),
    'same UID newer lifecycle': DutySession(
      uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 8,
    ),
    'same UID newer generation': DutySession(
      uid: 'A', sessionId: 'S', generation: 3, lifecycleSeq: 8,
    ),
  };
  late DutySession owner;
  late DutySession worker;
  late List<DutySession> selectors;
  late List<String> reads;

  setUp(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    DriverLocationService.resetPendingCleanupTokensForTesting();
    owner = worker = original;
    selectors = [];
    reads = [];
    messenger.setMockMethodCallHandler(
      NativeOwnershipCoordinator.channel,
      (call) async {
        if (call.method != 'atomicStopService' &&
            call.method != 'atomicRemoveOwner') {
          reads.add(call.method);
          throw StateError('Cleanup must not rediscover replacement authority');
        }
        final args = call.arguments as Map;
        final selected = DutySession(
          uid: args['expectedUid'] as String,
          sessionId: args['expectedSessionId'] as String,
          generation: args['expectedGeneration'] as int,
          lifecycleSeq: args['expectedLifecycleSeq'] as int,
        );
        selectors.add(selected);
        if (selected != owner) {
          return <String, dynamic>{
            'success': false,
            'stopped': false,
            'removed': false,
            'reason': 'ownership_transferred',
          };
        }
        throw StateError('Audit expected stale operation to select only old epoch');
      },
    );
  });
  tearDown(() {
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
    NativeOwnershipCoordinator.resetTestSimulation();
    DriverLocationService.resetPendingCleanupTokensForTesting();
  });

  for (final replacement in replacements.entries) {
    test('fresh R14 native boundary held STOP: ${replacement.key}', () async {
      final entered = Completer<void>(), release = Completer<void>();
      NativeOwnershipCoordinator.testHook = (action) async {
        if (action == 'before_atomic_stop') {
          entered.complete();
          await release.future;
        }
      };
      final result = DriverLocationService().stopForegroundService(
        expectedUid: original.uid,
        expectedSessionId: original.sessionId,
        expectedGeneration: original.generation,
        expectedLifecycleSeq: original.lifecycleSeq,
      );
      // Attach failure observation before the held channel operation resumes.
      final checked = expectLater(result, throwsA(isA<PlatformException>()));
      await entered.future;
      owner = worker = replacement.value;
      release.complete();
      await checked;
      expect(selectors, [original]);
      expect(reads, isEmpty);
      expect(owner, replacement.value);
      expect(worker, replacement.value);
    });
    test('fresh R14 native boundary held REMOVE: ${replacement.key}', () async {
      final entered = Completer<void>(), release = Completer<void>();
      NativeOwnershipCoordinator.testHook = (action) async {
        if (action == 'before_atomic_remove') {
          entered.complete();
          await release.future;
        }
      };
      final result = NativeOwnershipCoordinator.atomicRemoveOwner(
        expectedUid: original.uid,
        expectedSessionId: original.sessionId,
        expectedGeneration: original.generation,
        expectedLifecycleSeq: original.lifecycleSeq!,
      );
      await entered.future;
      owner = worker = replacement.value;
      release.complete();
      expect((await result)['removed'], isFalse);
      expect(selectors, [original]);
      expect(reads, isEmpty);
      expect(owner, replacement.value);
      expect(worker, replacement.value);
    });
  }

  test('fresh R14 reconstructed caller missing epoch cannot borrow current owner',
      () async {
    owner = worker = replacements.values.first;
    await DriverLocationService().stopForegroundService(expectedSessionId: 'S');
    expect(selectors, isEmpty);
    expect(reads, isEmpty);
    expect(owner, replacements.values.first);
    expect(worker, replacements.values.first);
  });
}
