import 'dart:async';

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

// Written independently on 2026-10-01 from the current production interfaces.
// No historical probe, production simulator, or historical expectation is used.
class AuditUser extends Fake implements User {
  AuditUser(this.uid);
  @override
  final String uid;
}

class AuditAuth extends AuthService {
  User user = AuditUser('A');
  final events = StreamController<User?>.broadcast(sync: true);
  @override
  User get currentUser => user;
  @override
  Stream<User?> get authStateChanges => events.stream;
  void select(String uid) {
    user = AuditUser(uid);
    events.add(user);
  }
}

const oldEpoch = DutySession(uid: 'A', sessionId: 'S', generation: 2, lifecycleSeq: 7);
const nextEpoch = DutySession(uid: 'A', sessionId: 'S', generation: 3, lifecycleSeq: 8);

DurableDutyOwnerRecord ownerOf(DutySession epoch) => DurableDutyOwnerRecord(
  uid: epoch.uid, sessionId: epoch.sessionId, generation: epoch.generation,
  lifecycleSeq: epoch.lifecycleSeq!, startedAt: DateTime.utc(2026, 10, 1),
);

DriverProfile profileOf({String uid = 'A', bool on = true, bool approved = true,
  int generation = 2, int sequence = 7}) => DriverProfile(
  uid: uid, name: 'Audit Driver', phone: '+919876543210', truckType: TruckType.flatbed,
  vehicleNumber: 'MH01AB1234', verificationStatus: approved ? 'approved' : 'pending',
  isOnDuty: on, activeDutySessionId: on ? 'S' : null,
  dutyGeneration: generation, lifecycleSeq: on ? sequence : null, workerReady: on,
);

Map<String, dynamic> serverMap(DriverProfile profile) => {
  'uid': profile.uid, 'name': profile.name, 'phone': profile.phone,
  'truckType': 'flatbed', 'vehicleNumber': profile.vehicleNumber,
  'verificationStatus': profile.verificationStatus, 'isOnDuty': profile.isOnDuty,
  'activeDutySessionId': profile.activeDutySessionId,
  'dutyGeneration': profile.dutyGeneration, 'lifecycleSeq': profile.lifecycleSeq,
  'workerReady': profile.workerReady,
};

class AuditLocation extends LocationService {
  DutySession? native = oldEpoch;
  DriverProfile server = profileOf();
  bool running = true;
  bool permissions = true;
  bool ineffectiveStop = false;
  final stops = <DutySession>[];
  final ends = <DutySession>[];
  Future<DurableDutyOwnerRecord?> Function()? ownerHook;
  Future<void> Function()? endHook;
  Future<void> Function()? stopHook;
  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    if (ownerHook != null) return ownerHook!();
    return native == null ? null : ownerOf(native!);
  }
  @override
  Future<DutySession?> getDurableSession() async => native;
  @override
  Future<bool> isForegroundServiceRunning() async => running;
  @override
  DutySession? get currentServiceSession => native;
  @override
  int? get currentGeneration => native?.generation;
  @override
  int? get currentLifecycleSeq => native?.lifecycleSeq;
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => serverMap(server);
  @override
  Future<void> endDutySessionCall({required String uid, required String sessionId,
      int? generation, int? lifecycleSeq}) async {
    ends.add(DutySession(uid: uid, sessionId: sessionId, generation: generation!, lifecycleSeq: lifecycleSeq));
    if (endHook != null) await endHook!();
    server = server.copyWith(isOnDuty: false);
  }
  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {}
  @override
  Future<void> stopForegroundService({String? expectedUid, required String expectedSessionId,
      int? expectedGeneration, int? expectedLifecycleSeq}) async {
    final target = DutySession(uid: expectedUid!, sessionId: expectedSessionId,
        generation: expectedGeneration!, lifecycleSeq: expectedLifecycleSeq);
    stops.add(target);
    if (stopHook != null) await stopHook!();
    if (!ineffectiveStop && native == target) { native = null; running = false; }
  }
  @override
  Future<bool> isLocationServiceEnabled() async => permissions;
  @override
  Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async => LocationPermissionStatus.granted;
  @override
  void dispose() {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> microtasks() async { await Future<void>.delayed(Duration.zero); }

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AuditAuth auth;
  late AuditLocation location;
  late DutyController controller;
  setUp(() {
    auth = AuditAuth(); location = AuditLocation();
    controller = DutyController(locationService: location, authService: auth);
    controller.updateProfile(profileOf());
  });
  tearDown(() async { controller.dispose(); await auth.events.close(); });

  test('current go-off discovery after UID change performs no teardown or B mutation', () async {
    final entered = Completer<void>(); final release = Completer<void>();
    location.ownerHook = () async { entered.complete(); await release.future; return ownerOf(oldEpoch); };
    final off = controller.requestGoOffDuty(); await entered.future;
    auth.select('B'); controller.updateProfile(profileOf(uid: 'B', on: false));
    final beforeHealth = controller.trackingHealth;
    release.complete(); expect(await off, isFalse);
    expect(location.ends, isEmpty); expect(location.stops, isEmpty);
    expect(controller.currentProfile?.uid, 'B'); expect(controller.trackingHealth, beforeHealth);
  });

  test('current go-off discovery after same-UID logout intent performs no teardown', () async {
    final entered = Completer<void>(); final release = Completer<void>();
    location.ownerHook = () async { entered.complete(); await release.future; return ownerOf(oldEpoch); };
    final off = controller.requestGoOffDuty(); await entered.future;
    final lease = controller.beginLogoutBarrier('A'); release.complete();
    expect(await off, isFalse); expect(location.ends, isEmpty); expect(location.stops, isEmpty);
    expect(controller.isLogoutInProgress, isTrue); controller.endLogoutBarrier(lease);
  });

  test('current go-off captures L7 before server await and preserves L8', () async {
    final entered = Completer<void>(); final release = Completer<void>();
    location.endHook = () async { entered.complete(); await release.future; };
    final off = controller.requestGoOffDuty(); await entered.future;
    location.native = nextEpoch; release.complete();
    expect(await off, isFalse); expect(location.stops, [oldEpoch]);
    expect(location.native, nextEpoch); expect(controller.isCleanupRequired, isTrue);
    expect(controller.pendingCleanupSession, oldEpoch);
  });

  test('current reconciliation permission-loss retains captured L7 while END awaits', () async {
    location.permissions = false;
    final entered = Completer<void>(); final release = Completer<void>();
    location.endHook = () async { entered.complete(); await release.future; };
    final reconcile = controller.reconcileDutyState(); await entered.future;
    location.native = nextEpoch; release.complete(); await reconcile;
    expect(location.stops, [oldEpoch]); expect(location.native, nextEpoch);
    expect(controller.isCleanupRequired, isTrue); expect(controller.pendingCleanupSession, oldEpoch);
  });

  test('current go-off failed discovery after UID change cannot impose A cleanup error on B', () async {
    final entered = Completer<void>(); final release = Completer<void>();
    final trace = <String>[];
    location.ownerHook = () async {
      trace.add('A owner read entered');
      entered.complete(); await release.future;
      trace.add('A owner read failed after B selection');
      throw PlatformException(code: 'A_OWNER_READ_FAILED');
    };
    final off = controller.requestGoOffDuty(); await entered.future;
    auth.select('B'); controller.updateProfile(profileOf(uid: 'B', on: false));
    trace.add('B selected and OFF profile delivered');
    Map<String, Object?> snapshot() => {
      'profileUid': controller.currentProfile?.uid,
      'dutyState': controller.authoritativeDutyState.toString(),
      'health': controller.trackingHealth.toString(),
      'error': controller.lastErrorCode,
      'cleanup': controller.isCleanupRequired,
    };
    final before = snapshot();
    release.complete(); expect(await off, isFalse);
    expect(location.ends, isEmpty); expect(location.stops, isEmpty);
    expect(controller.currentProfile?.uid, 'B');
    expect(snapshot(), before,
      reason: 'Frozen M4-E: UID-A completions cannot mutate UID-B health/error/cleanup. '
          'Trace: $trace; END=${location.ends}; STOP=${location.stops}');
  });

  test('current retry exact L7 remains immutable when L8 replaces during STOP', () async {
    location.server = profileOf(on: false); location.ineffectiveStop = true;
    await controller.reconcileDutyState(); expect(controller.pendingCleanupSession, oldEpoch);
    location.ineffectiveStop = false;
    location.stopHook = () async { location.native = nextEpoch; };
    expect(await controller.retryCleanup(), isFalse);
    expect(location.stops, [oldEpoch, oldEpoch]); expect(location.native, nextEpoch);
    expect(controller.pendingCleanupSession, oldEpoch); expect(controller.isCleanupRequired, isTrue);
  });
}
