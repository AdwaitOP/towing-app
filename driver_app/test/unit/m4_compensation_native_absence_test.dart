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

// Exact simulated fencing, with production channel decoding for running truth.
class CompensationLocationService extends f.TestLocationService {
  bool stopped = false, failStop = false, failRead = false, superseded = false;
  Object? runningResponse = false;
  DutySession? replacement;
  final entered = Completer<void>(), released = Completer<void>();
  bool holdServerStart = false;
  final events = <String>[];
  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async {
    final result = await super.startDutySessionCall(
      uid: uid,
      sessionId: sessionId,
      initialLocation: initialLocation,
      lifecycleSeq: lifecycleSeq,
      generation: generation,
      attemptSeq: attemptSeq,
    );
    if (holdServerStart) {
      entered.complete();
      await released.future;
    }
    return result;
  }

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    if (superseded && replacement != null) {
      currentSession = replacement;
      serviceRunning = true;
    }
    return super.getDurableOwnerRecord();
  }

  @override
  Future<bool> isForegroundServiceRunning() async {
    if (!stopped) return super.isForegroundServiceRunning();
    events.add('verify-running');
    return DriverLocationService().isForegroundServiceRunning();
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedGeneration,
    int? expectedLifecycleSeq,
  }) async {
    expect(expectedUid, isNotNull);
    expect(expectedGeneration, isNotNull);
    expect(expectedLifecycleSeq, 7);
    events.add('stop');
    if (superseded && replacement != null) currentSession = replacement;
    if (failStop) throw StateError('exact stop failed');
    await super.stopForegroundService(
      expectedUid: expectedUid,
      expectedSessionId: expectedSessionId,
      expectedGeneration: expectedGeneration,
      expectedLifecycleSeq: expectedLifecycleSeq,
    );
    stopped = true;
    if (runningResponse != false || failRead) serviceRunning = true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const off = DriverProfile(
    uid: 'uid-a',
    name: 'Driver A',
    phone: '+919876543210',
    truckType: TruckType.flatbed,
    vehicleNumber: 'MH 12 AB 1234',
    verificationStatus: 'approved',
    isOnDuty: false,
  );
  Map<String, dynamic> fresh(DriverProfile p) => {
    'uid': p.uid,
    'name': p.name,
    'phone': p.phone,
    'truckType': p.truckType.backendValue,
    'vehicleNumber': p.vehicleNumber,
    'verificationStatus': p.verificationStatus,
    'isOnDuty': p.isOnDuty,
    'activeJobId': p.activeJobId,
    'activeDutySessionId': p.activeDutySessionId,
    'dutyGeneration': p.dutyGeneration,
    'lifecycleSeq': p.lifecycleSeq,
    'workerReady': p.workerReady,
  };
  late f.TestAuthService auth;
  late CompensationLocationService location;
  late DutyController controller;
  setUp(() {
    NativeOwnershipCoordinator.resetTestSimulation();
    auth = f.TestAuthService(f.FakeUser(off.uid));
    location = CompensationLocationService()
      ..allocatedLifecycleSeq = 7
      ..mockLifecycleSeq = 7
      ..nextPreparedGeneration = 2
      ..nextPreparedSessionId = 'recovered'
      ..currentPos = DriverPosition(
        latitude: 18.5,
        longitude: 73.8,
        timestamp: DateTime.utc(2026, 10, 1),
      );
    controller = f.FixtureDutyController(
      locationService: location,
      authService: auth,
    );
    controller.updateProfile(off);
    messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (
      call,
    ) async {
      expect(call.method, 'isServiceRunning');
      if (location.failRead) throw PlatformException(code: 'READ_FAILED');
      return location.runningResponse;
    });
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
  for (final path in [
    'stale-START',
    'stale-go-on',
    'stale-go-on-native-START',
  ]) {
    for (final scenario in [
      'absent',
      'running',
      'unknown',
      'stop-failure',
      'read-failure',
      'same-uid-L8',
      'different-uid',
    ]) {
      test('$path compensation: $scenario', () async {
        location.runningResponse = scenario == 'unknown'
            ? null
            : scenario == 'running';
        location.failStop = scenario == 'stop-failure';
        location.failRead = scenario == 'read-failure';
        if (scenario == 'same-uid-L8' || scenario == 'different-uid') {
          location.replacement = DutySession(
            uid: scenario == 'same-uid-L8' ? off.uid : 'uid-b',
            sessionId: 'recovered',
            generation: 2,
            lifecycleSeq: 8,
          );
        }
        Future<dynamic> operation;
        if (path == 'stale-START') {
          final source = off.copyWith(
            isOnDuty: true,
            activeJobId: 'job-1',
            activeDutySessionId: 'source',
            dutyGeneration: 1,
            lifecycleSeq: 1,
          );
          controller.updateProfile(source);
          location.recoveryResponse = {
            'sessionId': 'recovered',
            'dutyGeneration': 2,
            'status': 'recovered',
          };
          var reads = 0;
          location.fetchServerDriverStateOverride = (_) async => ++reads == 1
              ? fresh(source)
              : {
                  'isOnDuty': true,
                  'activeDutySessionId': 'recovered',
                  'dutyGeneration': 2,
                  'activeJobId': 'job-1',
                  'workerReady': false,
                  'lifecycleSeq': null,
                };
          location.startServiceOverride = () async {
            location.entered.complete();
            await location.released.future;
          };
          operation = controller.reconcileDutyState();
          await location.entered.future;
          auth.emitUser(f.FakeUser('uid-b'));
          await Future<void>.delayed(Duration.zero);
          controller.updateProfile(off.copyWith(uid: 'uid-b'));
        } else {
          location.holdServerStart = path == 'stale-go-on';
          if (path == 'stale-go-on-native-START') {
            location.startServiceOverride = () async {
              location.entered.complete();
              await location.released.future;
            };
          }
          operation = controller.requestGoOnDuty(
            onShowDisclosure: () async => true,
          );
          await location.entered.future;
          controller.beginLogoutBarrier(off.uid);
        }
        final healthBefore = controller.trackingHealth,
            pendingBefore = controller.pendingCleanupSession;
        location.superseded = true;
        location.released.complete();
        await operation;
        const exact = DutySession(
          uid: 'uid-a',
          sessionId: 'recovered',
          generation: 2,
          lifecycleSeq: 7,
        );
        if (location.replacement != null) {
          expect(location.currentSession, location.replacement);
          expect(location.serviceRunning, isTrue);
          if (path == 'stale-START') {
            expect(location.exactStopRequests, isEmpty);
            expect(controller.staleStartCleanupError, isNull);
          } else {
            expect(location.exactStopRequests, [exact]);
            expect(controller.isCleanupRequired, isTrue);
            expect(controller.pendingCleanupSession, exact);
          }
        } else if (scenario == 'absent') {
          expect(location.exactStopRequests, [exact]);
          expect(location.serviceRunning, isFalse);
          expect(location.events, ['stop', 'verify-running']);
          expect(controller.pendingCleanupSession, isNull);
          expect(controller.staleStartCleanupError, isNull);
          if (path == 'stale-go-on') {
            expect(controller.trackingHealth, TrackingHealth.off);
          }
        } else {
          expect(location.events, contains('stop'));
          if (scenario != 'stop-failure') {
            expect(location.events, contains('verify-running'));
          }
          if (path == 'stale-START') {
            // Root E / F10: Stale TYPE-B failure cannot contaminate successor B public diagnostic
            expect(controller.staleStartCleanupError, isNull);
          } else {
            if (path == 'stale-go-on') {
              expect(
                controller.trackingHealth,
                TrackingHealth.reconciliationFailed,
              );
            } else {
              expect(controller.trackingHealth, isNot(TrackingHealth.off));
            }
            expect(controller.isCleanupRequired, isTrue);
            expect(controller.pendingCleanupSession, exact);
          }
        }
        if (path == 'stale-START') {
          // Best-effort removal cannot finalize B's health or pending authority.
          expect(controller.boundUid, 'uid-b');
          expect(controller.trackingHealth, healthBefore);
          expect(controller.pendingCleanupSession, pendingBefore);
          expect(controller.activeSession, isNull);
        }
      });
    }
  }
}
