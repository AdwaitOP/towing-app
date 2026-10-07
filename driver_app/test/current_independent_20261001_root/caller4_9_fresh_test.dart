import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';

// New independent fixtures, written from current production APIs in this run.
class AuditUser implements User {
  @override final String uid;
  AuditUser(this.uid);
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class AuditAuth extends AuthService {
  User? user = AuditUser('A');
  final changes = StreamController<User?>.broadcast(sync: true);
  @override User? get currentUser => user;
  @override Stream<User?> get authStateChanges => changes.stream;
  void switchTo(String uid) { user = AuditUser(uid); changes.add(user); }
}
DutySession epoch({String uid = 'A', String sid = 'same', int gen = 8, int seq = 23}) =>
    DutySession(uid: uid, sessionId: sid, generation: gen, lifecycleSeq: seq);
Map<String, dynamic> server({String uid = 'A', bool on = false, String sid = 'same', int gen = 8, int? seq = 23, String? job}) => {
  'uid': uid, 'name': 'Audit', 'phone': '+919999999999', 'truckType': 'flatbed',
  'vehicleNumber': 'MH01AA1234', 'verificationStatus': 'approved', 'isOnDuty': on,
  'activeDutySessionId': on ? sid : null, 'dutyGeneration': gen,
  'lifecycleSeq': on ? seq : null, 'workerReady': false, 'activeJobId': job,
};
class AuditLocation implements LocationService {
  DutySession? native;
  bool running = false;
  int ends = 0;
  final stops = <DutySession>[];
  Future<void> Function(DutySession)? onStop;
  Future<Map<String, dynamic>?> Function()? onFetch;
  Future<DurableDutyOwnerRecord?> Function()? onOwner;
  Future<bool> Function(DutySession, void Function(DutySession)?)? onStart;
  Map<String, dynamic> fresh = server();
  @override Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    if (onOwner != null) return onOwner!();
    final n = native;
    return n == null ? null : DurableDutyOwnerRecord(uid:n.uid, sessionId:n.sessionId,
      generation:n.generation, lifecycleSeq:n.lifecycleSeq!, startedAt:DateTime.utc(2026,10,1));
  }
  @override Future<DutySession?> getDurableSession() async => native;
  @override Future<bool> isForegroundServiceRunning() async => running;
  @override DutySession? get currentServiceSession => native;
  @override int? get currentLifecycleSeq => native?.lifecycleSeq;
  @override int? get currentGeneration => native?.generation;
  @override Future<Map<String,dynamic>?> fetchServerDriverState(String uid) async => onFetch != null ? onFetch!() : fresh;
  @override Future<bool> isLocationServiceEnabled() async => true;
  @override Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override Future<LocationPermissionStatus> requestBackgroundPermission() async => LocationPermissionStatus.granted;
  @override Future<void> endDutySessionCall({required String uid, required String sessionId, int? generation, int? lifecycleSeq}) async { ends++; }
  @override Future<void> stopForegroundService({String? expectedUid, required String expectedSessionId, int? expectedLifecycleSeq, int? expectedGeneration}) async {
    final target=DutySession(uid:expectedUid!, sessionId:expectedSessionId, generation:expectedGeneration!, lifecycleSeq:expectedLifecycleSeq);
    stops.add(target);
    if(onStop!=null) { await onStop!(target); return; }
    if(native==target) { native=null; running=false; }
  }
  @override Future<Map<String,dynamic>> recoverActiveJobSessionCall({required String uid, required String activeDutySessionId, required int dutyGeneration, required int lifecycleSeq, required String expectedActiveJobId, String? clientRequestId, DriverPosition? initialLocation}) async {
    fresh=server(on:true, sid:'recovered', gen:9, seq:null, job:expectedActiveJobId);
    return {'status':'recovered','sessionId':'recovered','dutyGeneration':9};
  }
  @override Future<bool> startForegroundService({required DutySession session, String? notificationTitle, String? notificationText, void Function(DutySession)? onAuthorityAllocated}) async => onStart!(session,onAuthorityAllocated);
  @override void dispose() {}
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
Map<String,Object?> snapshot(DutyController c) => {'uid':c.currentProfile?.uid,
  'duty':c.authoritativeDutyState,'health':c.trackingHealth,'error':c.lastErrorCode,
  'cleanup':c.isCleanupRequired,'active':c.activeSession,'pending':c.pendingCleanupSession,
  'loading':c.isLoading,'reconciling':c.isReconciling,'ready':c.isReady};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AuditAuth auth;
  late AuditLocation loc;
  late DutyController c;
  setUp(() { auth=AuditAuth(); loc=AuditLocation(); c=DutyController(locationService:loc,authService:auth); c.updateProfile(DriverProfile.fromMap(server(),'A')); });
  tearDown(() async { c.dispose(); await auth.changes.close(); });

  test('caller4 exact residue clears only after global native absence',() async {
    loc.native=epoch(); loc.running=true;
    await c.reconcileDutyState();
    expect(loc.stops,[epoch()]); expect(loc.ends,0);
    expect(c.trackingHealth,TrackingHealth.off); expect(c.isCleanupRequired,false);
    expect(c.pendingCleanupSession,null);
  });
  for(final replacement in [epoch(seq:24),epoch(gen:9),epoch(uid:'B'),epoch(sid:'replacement')]) {
    test('caller4 replacement ${replacement.toString()} survives repeated cleanup',() async {
      final old=epoch(); loc.native=old; loc.running=true;
      loc.onStop=(target) async { expect(target,old); loc.native=replacement; loc.running=false; };
      await c.reconcileDutyState();
      expect(loc.native,replacement); expect(c.trackingHealth,TrackingHealth.reconciliationFailed);
      expect(c.isCleanupRequired,true); expect(c.pendingCleanupSession,old);
      await c.reconcileDutyState();
      expect(loc.stops,[old,old]); expect(loc.native,replacement);
      expect(c.pendingCleanupSession,old); expect(c.isCleanupRequired,true); expect(loc.ends,0);
    });
  }
  test('caller4 initially absent read cannot authorize OFF after a worker appears during server await',() async {
    final entered=Completer<void>(), gate=Completer<Map<String,dynamic>?>();
    loc.onFetch=() { entered.complete(); return gate.future; };
    final f=c.reconcileDutyState(); await entered.future;
    loc.native=epoch(uid:'B'); loc.running=true; gate.complete(server()); await f;
    expect(loc.stops,isEmpty); expect(loc.ends,0); expect(loc.native,epoch(uid:'B'));
    expect(c.trackingHealth,TrackingHealth.reconciliationFailed); expect(c.canToggleDuty,false);
  });
  test('caller4 post-stop owner read error retains original pending selector',() async {
    loc.native=epoch(); loc.running=true;
    loc.onStop=(target) async { loc.native=null; loc.running=false;
      loc.onOwner=() async => throw PlatformException(code:'POST_STOP_READ_FAILED'); };
    await c.reconcileDutyState();
    expect(c.trackingHealth,TrackingHealth.reconciliationFailed);
    expect(c.isCleanupRequired,true); expect(c.pendingCleanupSession,epoch());
    expect(loc.stops,[epoch()]);
  });
  test('caller4 unknown running service with no exact authority cannot report clean OFF',() async {
    loc.running=true;
    await c.reconcileDutyState();
    expect(c.trackingHealth,TrackingHealth.reconciliationFailed);
    expect(c.isCleanupRequired,true); expect(c.canToggleDuty,false); expect(loc.ends,0);
    // A malformed selector may reach an adapter; native must reject it (separate boundary probe).
    expect(loc.stops.every((e)=>e.sessionId.isEmpty),true);
  });

  for(final outcome in ['success','failure']) {
    for(final replacement in [false,true]) {
      test('caller9 captured stale recovery epoch $outcome replacement=$replacement',() async {
        loc.fresh=server(on:true,job:'J'); c.updateProfile(DriverProfile.fromMap(loc.fresh,'A'));
        final entered=Completer<void>(), gate=Completer<bool>();
        final captured=epoch(sid:'recovered',gen:9,seq:40);
        final newer=captured.copyWith(lifecycleSeq:41);
        loc.onStart=(s,allocated) { allocated!(captured); loc.native=captured; loc.running=true; entered.complete(); return gate.future; };
        final f=c.reconcileDutyState(); await entered.future;
        auth.switchTo('B'); c.updateProfile(DriverProfile.fromMap(server(uid:'B'),'B'));
        if(replacement) loc.native=newer;
        final before=snapshot(c);
        if(outcome=='success') { gate.complete(true); } else { gate.completeError(PlatformException(code:'OLD_START_FAILED')); }
        await f;
        expect(snapshot(c),before); expect(loc.ends,0);
        if(replacement) { expect(loc.stops,isEmpty); expect(loc.native,newer); }
        else { expect(loc.stops,[captured]); expect(loc.native,null); }
      });
    }
  }
}
