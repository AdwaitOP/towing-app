import 'dart:async';
import 'package:driver_app/app/logout_coordinator.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'independent_m5_r14_logout_probe_test.dart' as p;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    NativeOwnershipCoordinator.useTestSimulation = true;
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
  });
  tearDown(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    AppLogoutCoordinator.resetInFlightLogoutForTesting();
  });
  for (final replacement in [
    p.newer,
    const DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 8),
    p.other,
  ]) {
    test(
      'ACQ original exact capture preserves replacement $replacement',
      () async {
        await p.install(p.old);
        final lease = await NativeOwnershipCoordinator.beginCleanupAcquisition(
          'old',
          'A',
        );
        expect(lease.owner?.uid, 'A');
        expect(lease.owner?.sessionId, 'S');
        expect(lease.owner?.generation, 2);
        expect(lease.owner?.lifecycleSeq, 7);
        await p.install(replacement);
        expect(lease.owner?.lifecycleSeq, 7);
        await NativeOwnershipCoordinator.withCleanupAcquisition(
          lease,
          () async {
            final result = await NativeOwnershipCoordinator.atomicStopService(
              expectedUid: 'A',
              expectedSessionId: 'S',
              expectedGeneration: 2,
              expectedLifecycleSeq: 7,
            );
            expect(result['stopped'], false);
          },
        );
        final owner = await NativeOwnershipCoordinator.getDurableOwner();
        expect(owner?.uid, replacement.uid);
        expect(owner?.generation, replacement.generation);
        expect(owner?.lifecycleSeq, replacement.lifecycleSeq);
        await NativeOwnershipCoordinator.releaseCleanupAcquisition(lease);
      },
    );
  }
  test('ACQ none then owner cannot grant a STOP selector', () async {
    final lease = await NativeOwnershipCoordinator.beginCleanupAcquisition(
      'old',
      'A',
    );
    expect(lease.owner, isNull);
    await p.install(p.newer);
    await NativeOwnershipCoordinator.withCleanupAcquisition(lease, () async {
      final result = await NativeOwnershipCoordinator.atomicStopService(
        expectedUid: 'A',
        expectedSessionId: 'S',
        expectedGeneration: 3,
        expectedLifecycleSeq: 8,
      );
      expect(result['success'], false);
    });
    expect(
      (await NativeOwnershipCoordinator.getDurableOwner())?.lifecycleSeq,
      8,
    );
  });
  test(
    'ACQ old release and forged token cannot affect new operation',
    () async {
      await p.install(p.old);
      final oldLease = await NativeOwnershipCoordinator.beginCleanupAcquisition(
        'old',
        'A',
      );
      await p.install(p.newer);
      final newer = await NativeOwnershipCoordinator.beginCleanupAcquisition(
        'new',
        'A',
      );
      final forged = NativeCleanupAcquisition(newer.token, 'old', newer.owner);
      expect(
        await NativeOwnershipCoordinator.validateCleanupAcquisition(forged),
        false,
      );
      await NativeOwnershipCoordinator.releaseCleanupAcquisition(forged);
      await NativeOwnershipCoordinator.releaseCleanupAcquisition(oldLease);
      expect(
        await NativeOwnershipCoordinator.validateCleanupAcquisition(newer),
        true,
      );
      expect(
        await NativeOwnershipCoordinator.validateCleanupAcquisition(oldLease),
        false,
      );
    },
  );
  test(
    'C6-ACQ cold adapter cleans original residual without cached session',
    () async {
      await p.install(p.old);
      final auth = p.ProbeAuth();
      final location = p.ProbeLocation();
      expect(location.currentServiceSession, isNull);
      expect(location.currentLifecycleSeq, isNull);
      expect(
        await AppLogoutCoordinator(
          authService: auth,
          locationService: location,
        ).coordinateLogout(),
        LogoutResult.success,
      );
      expect(location.stops, [p.old]);
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
      expect(await NativeOwnershipCoordinator.isServiceRunning(), false);
      expect(auth.signouts, ['A']);
      await auth.changes.close();
    },
  );
  test('ACQ pending native acquisition fences new Dart START', () async {
    NativeOwnershipCoordinator.useTestSimulation = false;
    final entered = Completer<void>(), release = Completer<void>();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (
      call,
    ) async {
      expect(call.method, 'beginCleanupAcquisition');
      entered.complete();
      await release.future;
      final args = Map<String, dynamic>.from(call.arguments as Map);
      return {
        'token': 'native-token',
        'operationId': args['operationId'],
        'captured': false,
      };
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(
        NativeOwnershipCoordinator.channel,
        null,
      ),
    );
    final acquisition = NativeOwnershipCoordinator.beginCleanupAcquisition(
      'op',
      'A',
    );
    await entered.future;
    final result = await NativeOwnershipCoordinator.atomicStartService(
      record: DurableDutyOwnerRecord(
        uid: 'A',
        sessionId: 'S',
        generation: 2,
        lifecycleSeq: 7,
        startedAt: DateTime.utc(2026),
      ),
    );
    expect(result['reason'], 'cleanup_acquisition_pending');
    release.complete();
    expect((await acquisition).owner, isNull);
  });
}
