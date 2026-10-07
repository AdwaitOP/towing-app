import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:driver_app/features/hub/models/hub_error_category.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class TestAuthService extends AuthService {
  User? mockUser;
  final StreamController<User?> _authController = StreamController<User?>.broadcast();

  TestAuthService([this.mockUser]);

  @override
  User? get currentUser => mockUser;

  @override
  Stream<User?> get authStateChanges => _authController.stream;

  void emitUser(User? user) {
    mockUser = user;
    _authController.add(user);
  }

  void dispose() {
    _authController.close();
  }
}

class FakeUser implements User {
  @override
  final String uid;
  FakeUser(this.uid);

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class TestLocationService implements LocationService, NativeCleanupProvider {
  final Map<String, NativeCleanupAcquisition> cleanupLeases = {};
  int cleanupSerial = 0;
  @override
  Future<NativeCleanupAcquisition> beginCleanupAcquisition(String operationId, String uid) async {
    final session = durableSession ?? currentSession;
    final owner = durableOwnerRecord ?? (session == null ? null : DurableDutyOwnerRecord(
      uid: session.uid, sessionId: session.sessionId, generation: session.generation,
      lifecycleSeq: session.lifecycleSeq ?? mockLifecycleSeq!, startedAt: DateTime.utc(2026)));
    if (owner != null && owner.uid != uid) throw StateError('UID conflict');
    final lease = NativeCleanupAcquisition('fixture-${++cleanupSerial}', operationId, owner);
    cleanupLeases[lease.token] = lease;
    return lease;
  }
  @override
  Future<bool> validateCleanupAcquisition(NativeCleanupAcquisition lease) async =>
      identical(cleanupLeases[lease.token], lease);
  @override
  Future<void> releaseCleanupAcquisition(NativeCleanupAcquisition lease) async {
    if (identical(cleanupLeases[lease.token], lease)) cleanupLeases.remove(lease.token);
  }

  bool serviceEnabled = true;
  LocationPermissionStatus checkPermResult = LocationPermissionStatus.granted;
  LocationPermissionStatus reqForegroundResult = LocationPermissionStatus.granted;
  LocationPermissionStatus reqBackgroundResult = LocationPermissionStatus.granted;
  LocationPermissionStatus reqNotificationResult = LocationPermissionStatus.granted;
  DriverPosition? currentPos;
  bool startServiceResult = true;
  Future<void> Function()? startServiceOverride;
  int? allocatedLifecycleSeq;
  final List<DutySession> exactStopRequests = [];
  bool serviceRunning = false;
  DutySession? currentSession;
  DutySession? durableSession;
  Future<DutySession?> Function()? durableSessionOverride;
  DurableDutyOwnerRecord? durableOwnerRecord;
  Future<DurableDutyOwnerRecord?> Function()? durableOwnerOverride;

  bool throwOnHeartbeat = false;
  bool throwOnOnDutyTx = false;
  bool throwOnOffDutyTx = false;
  Exception? throwOnStartService;
  bool throwAfterStartSideEffect = false;
  Exception? throwOnStopService;
  Future<void> Function()? stopServiceOverride;
  Exception? throwOnCancelActivation;
  Exception? throwOnStartSessionCall;
  String? nextPreparedSessionId;
  final List<Map<String, dynamic>> cancelActivationCalls = [];
  Completer<void>? pendingOnDutyTxCompleter;
  Completer<void>? pendingOffDutyTxCompleter;

  final List<String> operationLog = [];
  final List<bool> dutyWrites = [];
  final List<DriverPosition> heartbeatWrites = [];

  int? mockLifecycleSeq = 1;

  @override
  DutySession? get currentServiceSession => currentSession;

  @override
  int? get currentLifecycleSeq => mockLifecycleSeq;

  @override
  int? get currentGeneration => 1;

  @override
  Future<DutySession?> getDurableSession() async =>
      durableSessionOverride != null ? await durableSessionOverride!() : durableSession ?? currentSession;

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    if (durableOwnerOverride != null) return durableOwnerOverride!();
    if (durableOwnerRecord != null) return durableOwnerRecord;
    final ds = durableSession ?? currentSession;
    if (ds == null) return null;
    return DurableDutyOwnerRecord(
      sessionId: ds.sessionId,
      uid: ds.uid,
      generation: ds.generation,
      lifecycleSeq: ds.lifecycleSeq ?? mockLifecycleSeq ?? 1,
      notificationTitle: ds.notificationTitle,
      notificationText: ds.notificationText,
      locale: ds.locale,
      startedAt: DateTime.now(),
    );
  }

  @override
  Future<bool> isForegroundServiceRunning() async => serviceRunning;

  @override
  Future<bool> isLocationServiceEnabled() async {
    operationLog.add('isLocationServiceEnabled');
    return serviceEnabled;
  }

  @override
  Future<LocationPermissionStatus> checkPermission() async {
    operationLog.add('checkPermission');
    return checkPermResult;
  }

  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async {
    operationLog.add('requestForegroundPermission');
    return reqForegroundResult;
  }

  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async {
    operationLog.add('requestBackgroundPermission');
    return reqBackgroundResult;
  }

  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async {
    operationLog.add('requestNotificationPermission');
    return reqNotificationResult;
  }

  @override
  Future<bool> hasRequiredPermissions() async {
    operationLog.add('hasRequiredPermissions');
    return serviceEnabled &&
        checkPermResult == LocationPermissionStatus.granted &&
        reqBackgroundResult == LocationPermissionStatus.granted;
  }

  @override
  Future<DriverPosition?> getCurrentPosition() async {
    operationLog.add('getCurrentPosition');
    return currentPos;
  }

  @override
  Stream<DriverPosition> getPositionStream() => const Stream.empty();

  int foregroundStartCount = 0;

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    foregroundStartCount++;
    operationLog.add('startForegroundService:${session.sessionId}');
    final nativeSeq = allocatedLifecycleSeq ?? mockLifecycleSeq;
    final nativeAuthority = nativeSeq == null
        ? session
        : session.copyWith(lifecycleSeq: nativeSeq);
    onAuthorityAllocated?.call(nativeAuthority);
    if (startServiceOverride != null) await startServiceOverride!();
    if (throwOnStartService != null) throw throwOnStartService!;
    if (!startServiceResult) return false;
    currentSession = nativeAuthority;
    serviceRunning = true;
    if (throwAfterStartSideEffect) throw StateError('start failed after native side effect');
    return true;
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    operationLog.add('stopForegroundService:$expectedSessionId');
    if (expectedUid != null && expectedGeneration != null &&
        expectedLifecycleSeq != null) {
      exactStopRequests.add(DutySession(
        uid: expectedUid, sessionId: expectedSessionId,
        generation: expectedGeneration, lifecycleSeq: expectedLifecycleSeq,
      ));
    }
    if (stopServiceOverride != null) await stopServiceOverride!();
    if (throwOnStopService != null) throw throwOnStopService!;
    if (currentSession != null &&
        ((expectedUid != null && currentSession!.uid != expectedUid) ||
            currentSession!.sessionId != expectedSessionId ||
            (expectedGeneration != null && currentSession!.generation != expectedGeneration) ||
            (expectedLifecycleSeq != null &&
                (currentSession!.lifecycleSeq ?? mockLifecycleSeq) != expectedLifecycleSeq))) {
      return; // No-op on mismatched session ID
    }
    currentSession = null;
    serviceRunning = false;
  }

  @override
  DriverPosition? get lastKnownPosition => currentPos;

  @override
  Future<void> sendHeartbeat({
    required String uid,
    required DriverPosition position,
  }) async {
    operationLog.add('sendHeartbeat:${position.latitude},${position.longitude}');
    if (throwOnHeartbeat) throw StateError('Heartbeat write failed');
    heartbeatWrites.add(position);
  }

  @override
  Future<void> executeGoOnDutyTransaction({required String uid}) async {
    operationLog.add('executeGoOnDutyTransaction:$uid');
    if (pendingOnDutyTxCompleter != null) {
      await pendingOnDutyTxCompleter!.future;
    }
    if (throwOnOnDutyTx) throw StateError('GoOnDuty transaction failed');
    dutyWrites.add(true);
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    operationLog.add('executeGoOffDutyTransaction:$uid');
    if (pendingOffDutyTxCompleter != null) {
      await pendingOffDutyTxCompleter!.future;
    }
    if (throwOnOffDutyTx) throw StateError('GoOffDuty transaction failed');
    dutyWrites.add(false);
  }

  int nextPreparedGeneration = 1;
  int nextPreparedAttemptSeq = 1;

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    return DutyActivationPreparation(
      sessionId: nextPreparedSessionId ?? '${uid}_${DateTime.now().microsecondsSinceEpoch}',
      generation: nextPreparedGeneration,
      attemptSeq: nextPreparedAttemptSeq,
    );
  }

  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async {
    operationLog.add('startDutySessionCall:$sessionId:seq=$lifecycleSeq');
    if (throwOnStartSessionCall != null) throw throwOnStartSessionCall!;
    await executeGoOnDutyTransaction(uid: uid);
    return {'status': 'activated', 'dutyGeneration': generation ?? 1, 'lifecycleSeq': lifecycleSeq ?? 1, 'workerReady': false};
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {
    cancelActivationCalls.add({
      'uid': uid,
      'sessionId': sessionId,
      'generation': generation,
      'lifecycleSeq': lifecycleSeq,
      'attemptSeq': attemptSeq,
    });
    operationLog.add('cancelDutyActivationCall:$sessionId');
    if (throwOnCancelActivation != null) throw throwOnCancelActivation!;
  }

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
    operationLog.add('endDutySessionCall:$sessionId');
    await executeGoOffDutyTransaction(uid: uid);
  }

  @override
  Future<void> reportHeartbeatCall({
    required String uid,
    required String sessionId,
    required DriverPosition position,
    int? generation,
    int? lifecycleSeq,
  }) async {
    await sendHeartbeat(uid: uid, position: position);
  }

  Map<String, dynamic>? recoveryResponse;
  final List<Map<String, dynamic>> recoverCalls = [];

  @override
  Future<Map<String, dynamic>> recoverActiveJobSessionCall({
    required String uid,
    required String activeDutySessionId,
    required int dutyGeneration,
    required int lifecycleSeq,
    required String expectedActiveJobId,
    String? clientRequestId,
    DriverPosition? initialLocation,
  }) async {
    recoverCalls.add({
      'uid': uid,
      'activeDutySessionId': activeDutySessionId,
      'dutyGeneration': dutyGeneration,
      'lifecycleSeq': lifecycleSeq,
      'expectedActiveJobId': expectedActiveJobId,
    });
    if (recoveryResponse != null) {
      return recoveryResponse!;
    }
    return {
      'sessionId': '${uid}_recovered',
      'dutyGeneration': 1,
      'workerReady': false,
      'lifecycleSeq': null,
      'activeJobId': expectedActiveJobId,
      'status': 'recovered',
    };
  }

  Map<String, dynamic>? serverDriverState;
  Future<Map<String, dynamic>?> Function(String uid)? fetchServerDriverStateOverride;
  bool throwOnFetchServerState = false;
  DriverProfile? fixtureFreshProfile;
  bool useFixtureFreshProfile = true;
  final List<Map<String, dynamic>?> queuedServerDriverStates = [];

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async {
    if (fetchServerDriverStateOverride != null) {
      return fetchServerDriverStateOverride!(uid);
    }
    if (throwOnFetchServerState) throw StateError('Server state fetch failed');
    if (queuedServerDriverStates.isNotEmpty) return queuedServerDriverStates.removeAt(0);
    if (serverDriverState != null) return serverDriverState;
    final profile = useFixtureFreshProfile ? fixtureFreshProfile : null;
    if (profile == null) return null;
    return {
      'uid': profile.uid,
      'name': profile.name,
      'phone': profile.phone,
      'truckType': profile.truckType.backendValue,
      'vehicleNumber': profile.vehicleNumber,
      'verificationStatus': profile.verificationStatus,
      'isOnDuty': profile.isOnDuty,
      'activeJobId': profile.activeJobId,
      'activeOfferId': profile.activeOfferId,
      'activeDutySessionId': profile.activeDutySessionId,
      'dutyGeneration': profile.dutyGeneration,
      'lifecycleSeq': profile.lifecycleSeq,
      'workerReady': profile.workerReady,
    };
  }

  @override
  Future<bool> openAppSettings() async => true;

  @override
  void dispose() {}
}

/// Legacy controller tests model the profile callback as a matching fresh
/// server snapshot unless they provide an explicit server response.
class FixtureDutyController extends DutyController {
  FixtureDutyController({required TestLocationService locationService, required super.authService})
      : super(locationService: locationService);

  @override
  void updateProfile(DriverProfile profile) {
    (locationService as TestLocationService).fixtureFreshProfile = profile;
    super.updateProfile(profile);
  }
}

void main() {
  m4EStaleReconciliationTests();
  group('DutyController Unit Tests', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    final defaultPosition = DriverPosition(
      latitude: 18.5204,
      longitude: 73.8567,
      timestamp: DateTime.utc(2026, 9, 13, 12, 0, 0),
    );

    setUp(() {
      authService = TestAuthService(FakeUser('driver_test_123'));
      locationService = TestLocationService()..currentPos = defaultPosition;
      approvedProfile = const DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: false,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    test('full transactional go ON DUTY succeeds with exact sequence', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
      );

      expect(result, isTrue);
      expect(controller.errorCategory, isNull);
      expect(controller.isLoading, isFalse);
      expect(controller.isOnDuty, isTrue);
      expect(controller.isHealthyOnDuty, isTrue);

      expect(locationService.operationLog, contains('checkPermission'));
      expect(locationService.operationLog, contains('getCurrentPosition'));
      expect(locationService.operationLog.any((entry) => entry.startsWith('startDutySessionCall:')), isTrue);
      // M2-FIX-1: Controller main isolate NEVER calls sendHeartbeat or sets workerReady
      expect(locationService.operationLog, isNot(contains('sendHeartbeat:18.5204,73.8567')));
      expect(locationService.dutyWrites.last, isTrue);
      expect(locationService.serviceRunning, isTrue);
    });

    test('non-approved profile fails closed with notApproved error', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );

      const unapprovedProfile = DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'pending',
        isOnDuty: false,
      );
      controller.updateProfile(unapprovedProfile);

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
      );

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.notApproved));
      expect(locationService.serviceRunning, isFalse);
      expect(locationService.dutyWrites, isEmpty);
    });

    test('disclosure canceled leaves driver OFF DUTY without requesting permissions', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => false,
      );

      expect(result, isFalse);
      expect(controller.hasDisclosed, isFalse);
      expect(locationService.operationLog, isNot(contains('checkPermission')));
      expect(locationService.serviceRunning, isFalse);
    });

    test('location services disabled sets servicesDisabled error', () async {
      locationService.serviceEnabled = false;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
      );

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.servicesDisabled));
      expect(locationService.serviceRunning, isFalse);
    });

    test('foreground permission denied forever sets foregroundPermissionDeniedForever', () async {
      locationService.checkPermResult = LocationPermissionStatus.deniedForever;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
      );

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.foregroundPermissionDeniedForever));
      expect(locationService.serviceRunning, isFalse);
    });

    test('background permission denied sets backgroundPermissionDenied', () async {
      locationService.reqBackgroundResult = LocationPermissionStatus.denied;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
      );

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.backgroundPermissionDenied));
      expect(locationService.serviceRunning, isFalse);
    });

    test('failed go ON duty transaction stops foreground service', () async {
      locationService.throwOnOnDutyTx = true;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
      );

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.dutyUpdateFailed));
      expect(locationService.serviceRunning, isFalse);
    });

    test('go OFF duty with active job is blocked', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final activeJobProfile = approvedProfile.copyWith(activeJobId: 'job_456');
      controller.updateProfile(activeJobProfile);

      final result = await controller.requestGoOffDuty();

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.activeJobPreventOffDuty));
      expect(locationService.dutyWrites, isEmpty);
    });

    test('failed go OFF duty transaction keeps service running', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(locationService.serviceRunning, isTrue);

      locationService.throwOnOffDutyTx = true;
      final result = await controller.requestGoOffDuty();

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.dutyUpdateFailed));
      expect(locationService.serviceRunning, isTrue);
    });

    test('successful go OFF duty stops service and marks offDuty', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(locationService.serviceRunning, isTrue);

      final result = await controller.requestGoOffDuty();

      expect(result, isTrue);
      expect(controller.isOnDuty, isFalse);
      expect(locationService.serviceRunning, isFalse);
      expect(locationService.dutyWrites.last, isFalse);
    });
  });

  group('Section 19: New Maintained Controller Tests', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    final defaultPosition = DriverPosition(
      latitude: 18.5204,
      longitude: 73.8567,
      timestamp: DateTime.utc(2026, 9, 13, 12, 0, 0),
    );

    setUp(() {
      authService = TestAuthService(FakeUser('driver_test_123'));
      locationService = TestLocationService()..currentPos = defaultPosition;
      approvedProfile = const DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: false,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    // 1. sign-out during pending ON write
    test('sign-out during pending ON write coordinates cleanup', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      locationService.pendingOnDutyTxCompleter = Completer<void>();
      final onDutyFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);

      // Trigger sign-out preparation while ON write is in flight
      final signOutFuture = controller.prepareForSignOut();

      // Release the transaction
      locationService.pendingOnDutyTxCompleter!.complete();

      await onDutyFuture;
      await signOutFuture;

      expect(controller.isOnDuty, isFalse);
      expect(locationService.serviceRunning, isFalse);
      if (locationService.dutyWrites.isNotEmpty) {
        expect(locationService.dutyWrites.last, isFalse);
      }
    });

    // 2. UID switch during pending ON write
    test('UID switch during pending ON write aborts and stops service', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      locationService.pendingOnDutyTxCompleter = Completer<void>();
      final onDutyFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);

      // Switch user
      authService.emitUser(FakeUser('different_user_456'));
      await Future<void>.delayed(Duration.zero);

      locationService.pendingOnDutyTxCompleter!.complete();
      final result = await onDutyFuture;

      expect(result, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(locationService.serviceRunning, isFalse);
    });

    // 3. stale ON completion compensation
    test('stale ON completion performs compensating OFF transaction', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      locationService.pendingOnDutyTxCompleter = Completer<void>();
      final onDutyFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);

      // User requested go OFF while ON write was still in flight
      final offDutyFuture = controller.requestGoOffDuty();

      locationService.pendingOnDutyTxCompleter!.complete();
      await onDutyFuture;
      await offDutyFuture;

      expect(controller.isOnDuty, isFalse);
      expect(locationService.serviceRunning, isFalse);
      expect(locationService.dutyWrites.last, isFalse);
    });

    // 4. active job arrives during OFF transaction
    test('active job arrives during OFF transaction blocks OFF', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      locationService.pendingOffDutyTxCompleter = Completer<void>();
      final offDutyFuture = controller.requestGoOffDuty();

      // Active job arrives live
      controller.updateProfile(approvedProfile.copyWith(activeJobId: 'job_assigned_live'));

      locationService.pendingOffDutyTxCompleter!.complete();
      final result = await offDutyFuture;

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.activeJobPreventOffDuty));
      expect(locationService.serviceRunning, isTrue); // preserves tracking
    });

    // 5. verification downgrade during ON transaction
    test('verification downgrade during ON transaction aborts and cleans up', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      locationService.pendingOnDutyTxCompleter = Completer<void>();
      final onDutyFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);

      // Admin rejects or unapproves verification live
      controller.updateProfile(approvedProfile.copyWith(verificationStatus: 'rejected'));

      locationService.pendingOnDutyTxCompleter!.complete();
      final result = await onDutyFuture;

      expect(result, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(locationService.serviceRunning, isFalse);
    });

    // 6. A cleanup cannot stop B
    test('stale Session A cleanup cannot stop Session B service', () async {
      const sessionA = DutySession(uid: 'driver_1', sessionId: 'sess_A', generation: 1);
      const sessionB = DutySession(uid: 'driver_1', sessionId: 'sess_B', generation: 2);

      await locationService.startForegroundService(session: sessionB);
      expect(locationService.serviceRunning, isTrue);

      // Stale Session A attempts cleanup
      await locationService.stopForegroundService(expectedSessionId: sessionA.sessionId);

      // Session B must remain running
      expect(locationService.serviceRunning, isTrue);
      expect(locationService.currentServiceSession?.sessionId, equals('sess_B'));
    });

    // 7. same UID old session cannot stop new session
    test('same UID old session cannot stop new session', () async {
      const oldSession = DutySession(uid: 'driver_test_123', sessionId: 'old_123', generation: 1);
      const newSession = DutySession(uid: 'driver_test_123', sessionId: 'new_456', generation: 2);

      await locationService.startForegroundService(session: newSession);
      await locationService.stopForegroundService(expectedSessionId: oldSession.sessionId);

      expect(locationService.serviceRunning, isTrue);
      expect(locationService.currentServiceSession?.sessionId, equals('new_456'));
    });

    // 8. OFF during ON reconciliation
    test('OFF request during ON reconciliation converges to OFF', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final onProfile = approvedProfile.copyWith(isOnDuty: true);
      controller.updateProfile(onProfile);

      // Reconcile ON begins
      final reconcileFuture = controller.reconcileDutyState();

      // Driver presses GO OFF
      final offFuture = controller.requestGoOffDuty();

      await reconcileFuture;
      final offResult = await offFuture;

      expect(offResult, isTrue);
      expect(controller.isOnDuty, isFalse);
      expect(locationService.serviceRunning, isFalse);
    });

    // 9. resume during startup preserves loading settlement
    test('resume during startup settles loading flag and does not get stuck', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      locationService.pendingOnDutyTxCompleter = Completer<void>();
      final onFuture = controller.requestGoOnDuty(onShowDisclosure: () async => true);

      // Simulate resume triggering reconciliation
      final resumeFuture = controller.reconcileDutyState();

      locationService.pendingOnDutyTxCompleter!.complete();
      await onFuture;
      await resumeFuture;

      expect(controller.isLoading, isFalse);
    });

    // 10. transition failure clears loading
    test('transition failure clears loading flag cleanly', () async {
      locationService.throwOnOnDutyTx = true;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      expect(result, isFalse);
      expect(controller.isLoading, isFalse);
    });
  });

  group('Group 3: Coordinated Sign-Out & Logout Compensation', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    setUp(() {
      authService = TestAuthService(FakeUser('driver_test_123'));
      locationService = TestLocationService()
        ..currentPos = DriverPosition(
          latitude: 18.5204,
          longitude: 73.8567,
          timestamp: DateTime.utc(2026, 9, 13),
        );
      approvedProfile = const DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: false,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    test('prepareForSignOut when driver is OFF succeeds and returns true', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final canSignOut = await controller.prepareForSignOut();

      expect(canSignOut, isTrue);
      expect(controller.isOnDuty, isFalse);
      expect(locationService.dutyWrites, isEmpty);
    });

    test('prepareForSignOut when driver is ON writes OFF transaction and stops service', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: true));
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.isOnDuty, isTrue);
      expect(locationService.serviceRunning, isTrue);

      final canSignOut = await controller.prepareForSignOut();

      expect(canSignOut, isTrue);
      expect(controller.isOnDuty, isFalse);
      expect(locationService.serviceRunning, isFalse);
      expect(locationService.dutyWrites.last, isFalse);
    });

    test('prepareForSignOut blocks sign-out when compensating OFF transaction fails', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: true));
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.isOnDuty, isTrue);

      // Now configure OFF transaction to fail
      locationService.throwOnOffDutyTx = true;

      final canSignOut = await controller.prepareForSignOut();

      // Sign-out must be BLOCKED!
      expect(canSignOut, isFalse);
      expect(controller.isOnDuty, isTrue);
      expect(controller.errorCategory, equals(HubErrorCategory.dutyUpdateFailed));
      expect(locationService.serviceRunning, isTrue);
      expect(controller.activeSession, isNotNull);
    });

    test('prepareForSignOut succeeds if auth currentUser throws or is null', () async {
      authService.mockUser = null;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final canSignOut = await controller.prepareForSignOut();
      expect(canSignOut, isTrue);
    });
  });

  group('Group 4: Idempotent Reconciliation & Degraded Invariants', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    setUp(() {
      authService = TestAuthService(FakeUser('driver_test_123'));
      locationService = TestLocationService()
        ..currentPos = DriverPosition(
          latitude: 18.5204,
          longitude: 73.8567,
          timestamp: DateTime.utc(2026, 9, 13),
        );
      approvedProfile = const DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: false,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    test('idempotent reconciliation: healthy active service is not restarted', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: true));
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.isHealthyOnDuty, isTrue);

      final initialSessionId = controller.activeSession!.sessionId;
      final session = controller.activeSession!;
      locationService.fixtureFreshProfile = approvedProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: session.sessionId,
        dutyGeneration: session.generation,
        lifecycleSeq: session.lifecycleSeq,
        workerReady: true,
      );
      locationService.operationLog.clear();

      // Run reconciliation
      await controller.reconcileDutyState();

      // Must be complete NO-OP
      expect(controller.activeSession!.sessionId, equals(initialSessionId));
      expect(locationService.serviceRunning, isTrue);
      expect(locationService.operationLog, isNot(contains('startForegroundService')));
      expect(locationService.operationLog, isNot(contains('stopForegroundService')));
    });

    test('reconciliation stops service when profile says offDuty in Firestore', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      // Locally ON
      controller.updateProfile(approvedProfile);
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(locationService.serviceRunning, isTrue);

      // Profile comes in with isOnDuty: false
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));
      await controller.reconcileDutyState();

      expect(controller.isOnDuty, isFalse);
      expect(locationService.serviceRunning, isFalse);
      expect(controller.activeSession, isNull);
    });

    test('reconciliation with unapproved ON profile writes OFF and marks offDuty', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final unapprovedOn = approvedProfile.copyWith(
        verificationStatus: 'pending',
        isOnDuty: true,
        activeDutySessionId: 'sess_unapproved',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(unapprovedOn);

      await controller.reconcileDutyState();

      expect(controller.isOnDuty, isFalse);
      expect(locationService.dutyWrites.last, isFalse);
      expect(locationService.serviceRunning, isFalse);
    });

    test('reconciliation with unapproved ON profile keeps onDuty degraded when OFF write fails', () async {
      locationService.throwOnOffDutyTx = true;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final unapprovedOn = approvedProfile.copyWith(
        verificationStatus: 'pending',
        isOnDuty: true,
        activeDutySessionId: 'sess_unapproved',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(unapprovedOn);

      await controller.reconcileDutyState();

      // MUST NEVER infer offDuty on failed correction!
      expect(controller.isOnDuty, isTrue);
      expect(controller.trackingHealth, equals(TrackingHealth.reconciliationFailed));
      expect(controller.errorCategory, equals(HubErrorCategory.reconciliationFailed));
    });

    test('reconciliation with missing permissions writes OFF and sets permission error', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final onProfile = approvedProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_permissions',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(onProfile);

      // Revoke foreground permission
      locationService.checkPermResult = LocationPermissionStatus.denied;

      await controller.reconcileDutyState();

      expect(controller.isOnDuty, isFalse);
      expect(locationService.dutyWrites.last, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.foregroundPermissionDenied));
    });

    test('reconciliation with missing permissions keeps onDuty degraded when OFF write fails', () async {
      locationService.throwOnOffDutyTx = true;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final onProfile = approvedProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_permissions',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(onProfile);

      // Disable location services
      locationService.serviceEnabled = false;

      await controller.reconcileDutyState();

      // Fails closed: stays onDuty degraded
      expect(controller.isOnDuty, isTrue);
      expect(controller.trackingHealth, equals(TrackingHealth.reconciliationFailed));
      expect(controller.errorCategory, equals(HubErrorCategory.reconciliationFailed));
    });
  });

  group('Group 5: Notification Caching & Localization Parity', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    setUp(() {
      authService = TestAuthService(FakeUser('driver_test_123'));
      locationService = TestLocationService()
        ..currentPos = DriverPosition(
          latitude: 18.5204,
          longitude: 73.8567,
          timestamp: DateTime.utc(2026, 9, 13),
        );
      approvedProfile = const DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: false,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    test('requestGoOnDuty caches localized title & text and attaches to session', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
        notificationTitle: 'ऑन ड्यूटी टोइंग',
        notificationText: 'स्थान सामायिक केले जात आहे',
      );

      expect(result, isTrue);
      expect(controller.activeSession?.notificationTitle, equals('ऑन ड्यूटी टोइंग'));
      expect(controller.activeSession?.notificationText, equals('स्थान सामायिक केले जात आहे'));
    });

    test('reconciliation reuses cached notification title & text when resuming service', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
        notificationTitle: 'ऑन ड्यूटी टोइंग',
        notificationText: 'स्थान सामायिक केले जात आहे',
      );

      // Simulate app restart / reconciliation without re-passing strings
      final existingSession = controller.activeSession!;
      controller.updateProfile(approvedProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: existingSession.sessionId,
        dutyGeneration: existingSession.generation,
        lifecycleSeq: existingSession.lifecycleSeq,
        workerReady: true,
      ));
      locationService.currentSession = null; // simulate service killed
      locationService.serviceRunning = false;

      await controller.reconcileDutyState();

      expect(controller.activeSession?.notificationTitle, equals('ऑन ड्यूटी टोइंग'));
      expect(controller.activeSession?.notificationText, equals('स्थान सामायिक केले जात आहे'));
    });

    test('reconciliation marks reconciliationFailed if service startup fails', () async {
      locationService.startServiceResult = false;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_start_failure',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await controller.reconcileDutyState();

      expect(controller.isOnDuty, isTrue);
      expect(controller.trackingHealth, equals(TrackingHealth.reconciliationFailed));
      expect(controller.errorCategory, equals(HubErrorCategory.reconciliationFailed));
    });
  });

  group('Group 6: Live Profile Sync & Verification Downgrade', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    setUp(() {
      authService = TestAuthService(FakeUser('driver_test_123'));
      locationService = TestLocationService()
        ..currentPos = DriverPosition(
          latitude: 18.5204,
          longitude: 73.8567,
          timestamp: DateTime.utc(2026, 9, 13),
        );
      approvedProfile = const DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: false,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    test('updateProfile marks degraded attention state when verified ON driver is downgraded', () {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: true));

      // Verification downgraded
      final downgraded = approvedProfile.copyWith(
        verificationStatus: 'suspended',
        isOnDuty: true,
      );
      controller.updateProfile(downgraded);

      expect(controller.isOnDuty, isTrue);
      expect(controller.trackingHealth, equals(TrackingHealth.reconciliationFailed));
      expect(controller.errorCategory, equals(HubErrorCategory.reconciliationFailed));
    });

    test('clearError resets errorCategory and notifies listeners', () {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      // Trigger error
      locationService.serviceEnabled = false;
      controller.requestGoOnDuty(onShowDisclosure: () async => true);

      controller.clearError();
      expect(controller.errorCategory, isNull);
    });

    test('authStateChanges stream null user invalidates duty and stops service', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(locationService.serviceRunning, isTrue);

      authService.emitUser(null);
      await Future<void>.delayed(Duration.zero);

      expect(controller.activeSession, isNull);
      expect(locationService.serviceRunning, isFalse);
      expect(controller.authoritativeDutyState, equals(AuthoritativeDutyState.unknown));
      expect(controller.trackingHealth, equals(TrackingHealth.degraded));
    });

    test('authStateChanges stream UID change invalidates duty and stops service', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(locationService.serviceRunning, isTrue);

      authService.emitUser(FakeUser('driver_other_456'));
      await Future<void>.delayed(Duration.zero);

      expect(controller.activeSession, isNull);
      expect(locationService.serviceRunning, isFalse);
      expect(controller.authoritativeDutyState, equals(AuthoritativeDutyState.unknown));
      expect(controller.trackingHealth, equals(TrackingHealth.degraded));
    });
  });

  group('Group 7: Exhaustive Startup & Shutdown Failure Modes', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    setUp(() {
      authService = TestAuthService(FakeUser('driver_test_123'));
      locationService = TestLocationService()
        ..currentPos = DriverPosition(
          latitude: 18.5204,
          longitude: 73.8567,
          timestamp: DateTime.utc(2026, 9, 13),
        );
      approvedProfile = const DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: false,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    test('initial GPS position null fails closed with locationUnavailable', () async {
      locationService.currentPos = null;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.locationUnavailable));
      expect(locationService.serviceRunning, isFalse);
    });

    test('initial GPS position invalid coordinates fails closed with locationUnavailable', () async {
      locationService.currentPos = DriverPosition(
        latitude: 95.0,
        longitude: 73.0,
        timestamp: DateTime.now(),
      );
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.locationUnavailable));
      expect(locationService.serviceRunning, isFalse);
    });

    test('M2-FIX-1: main isolate go-on-duty completes without calling sendHeartbeat or reportHeartbeatCall', () async {
      locationService.throwOnHeartbeat = true;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      // Startup succeeds because controller never calls heartbeat
      expect(result, isTrue);
      expect(controller.isOnDuty, isTrue);
      expect(locationService.operationLog, isNot(contains('sendHeartbeat:18.5204,73.8567')));
      expect(locationService.heartbeatWrites, isEmpty);
      expect(locationService.serviceRunning, isTrue);
    });

    test('foreground service start failure sets serviceStartupFailed', () async {
      locationService.startServiceResult = false;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.serviceStartupFailed));
    });

    test('foreground permission denied forever sets foregroundPermissionDeniedForever', () async {
      locationService.checkPermResult = LocationPermissionStatus.deniedForever;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.foregroundPermissionDeniedForever));
    });

    test('foreground permission denied sets foregroundPermissionDenied', () async {
      locationService.checkPermResult = LocationPermissionStatus.denied;
      locationService.reqForegroundResult = LocationPermissionStatus.denied;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.foregroundPermissionDenied));
    });

    test('background permission deniedForever sets backgroundPermissionDenied', () async {
      locationService.reqBackgroundResult = LocationPermissionStatus.deniedForever;
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);

      expect(result, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.backgroundPermissionDenied));
    });
  });

  group('Group 8: Pass 4 Reconstruction, Localization, Truthful Authority & Stale Queue', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    setUp(() {
      authService = TestAuthService(FakeUser('driver_test_123'));
      locationService = TestLocationService()
        ..currentPos = DriverPosition(
          latitude: 18.5204,
          longitude: 73.8567,
          timestamp: DateTime.utc(2026, 9, 13),
        );
      approvedProfile = const DriverProfile(
        uid: 'driver_test_123',
        name: 'Sachin Tendulkar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: true,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    test('Fresh reconstruction recovers running foreground service and adopts session without restart', () async {
      // Simulate existing running service with durable session
      const existingSession = DutySession(
        uid: 'driver_test_123',
        sessionId: 'sess_running_reconstruct_1',
        generation: 5,
        lifecycleSeq: 1,
        notificationTitle: 'ऑन ड्युटी (मराठी)',
        notificationText: 'स्थान शेअर करत आहे',
        locale: 'mr',
      );
      locationService.durableSession = existingSession;
      locationService.serviceRunning = true;

      // Brand new controller instance simulating fresh process reconstruction
      final newController = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      newController.updateProfile(approvedProfile.copyWith(
        activeDutySessionId: 'sess_running_reconstruct_1',
        dutyGeneration: 5,
        lifecycleSeq: 1,
        workerReady: true,
      ));

      locationService.operationLog.clear();

      // Trigger reconciliation
      await newController.reconcileDutyState();

      // Must adopt existing running session without restarting service
      expect(newController.activeSession, equals(existingSession));
      expect(newController.authoritativeDutyState, equals(AuthoritativeDutyState.onDuty));
      expect(newController.trackingHealth, equals(TrackingHealth.healthy));
      expect(newController.cachedLocale, equals('mr'));
      expect(locationService.operationLog, isNot(contains('startForegroundService')));
      expect(locationService.operationLog, isNot(contains('stopForegroundService')));
    });

    test('Missing durable owner across reconstruction enters explicit reconciliationFailed', () async {
      // Service is not running and durable session is missing, but Firestore says isOnDuty == true
      locationService.durableSession = null;
      locationService.serviceRunning = false;

      final newController = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      newController.updateProfile(approvedProfile.copyWith(
        activeDutySessionId: 'sess_missing_owner',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      ));

      await newController.reconcileDutyState();

      expect(newController.authoritativeDutyState, equals(AuthoritativeDutyState.onDuty));
      expect(newController.trackingHealth, equals(TrackingHealth.reconciliationFailed));
      expect(newController.errorCategory, equals(HubErrorCategory.reconciliationFailed));
    });

    test('Notification strings in Hindi/Marathi/English recovered from durable session payload', () async {
      for (final locale in ['en', 'hi', 'mr']) {
        final title = 'Title_$locale';
        final text = 'Text_$locale';
        final session = DutySession(
          uid: 'driver_test_123',
          sessionId: 'sess_$locale',
          generation: 1,
          lifecycleSeq: 1,
          notificationTitle: title,
          notificationText: text,
          locale: locale,
        );

        locationService.durableSession = session;
        locationService.serviceRunning = true;

        final controller = FixtureDutyController(
          locationService: locationService,
          authService: authService,
        );
        controller.updateProfile(approvedProfile.copyWith(
          activeDutySessionId: 'sess_$locale',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          workerReady: true,
        ));

        await controller.reconcileDutyState();

        expect(controller.cachedLocale, equals(locale));
        expect(controller.activeSession?.notificationTitle, equals(title));
        expect(controller.activeSession?.notificationText, equals(text));
      }
    });

    test('Queued reconciliation validates latest desired state and drops stale OFF reconcile', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));

      // 1. Controller is OFF duty initially
      expect(controller.isOnDuty, isFalse);

      // 2. Enqueue an OFF reconciliation (e.g. from app resume while OFF)
      final staleReconcile = controller.reconcileDutyState();

      // 3. Driver immediately taps GO ON DUTY, going ON duty
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: true));
      final onResult = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(onResult, isTrue);
      expect(controller.isHealthyOnDuty, isTrue);

      // 4. Wait for stale reconcile to settle
      await staleReconcile;

      // Stale OFF reconcile MUST NOT have stopped the healthy ON session!
      expect(controller.isHealthyOnDuty, isTrue);
      expect(locationService.serviceRunning, isTrue);
      expect(controller.activeSession, isNotNull);
    });

    test('Truthful authority: unexpected auth loss while ON duty reports unknown, never false offDuty', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: true));
      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.isOnDuty, isTrue);

      // Auth unexpectedly becomes null without an authoritative OFF write
      authService.emitUser(null);
      await Future<void>.delayed(Duration.zero);

      // Must be unknown with degraded attention state, NEVER authoritative offDuty!
      expect(controller.authoritativeDutyState, equals(AuthoritativeDutyState.unknown));
      expect(controller.authoritativeDutyState, isNot(equals(AuthoritativeDutyState.offDuty)));
      expect(controller.trackingHealth, equals(TrackingHealth.degraded));
    });

    test('P2-C Path 1: Compensating STOP succeeds after STARTUP_TIMEOUT_CLEANUP_FAILED -> cleanupRequired is FALSE', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));
      locationService.throwOnStartService = PlatformException(
        code: 'STARTUP_TIMEOUT_CLEANUP_FAILED',
        message: 'Native start timed out and cleanup failed',
        details: {'timeout': 5000, 'reason': 'cleanup_timeout'},
      );

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(result, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.serviceStartupFailed));
      expect(controller.lastError, isNotNull);
      expect(controller.lastErrorCode, equals('STARTUP_TIMEOUT_CLEANUP_FAILED'));
      expect(controller.lastErrorMessage, contains('Native start timed out'));
      expect(controller.lastErrorDetails, equals({'timeout': 5000, 'reason': 'cleanup_timeout'}));
      expect(controller.lastError?.startupErrorCode, equals('STARTUP_TIMEOUT_CLEANUP_FAILED'));
      expect(controller.lastError?.cleanupErrorCode, isNull);
      expect(controller.lastError?.cancellationErrorCode, isNull);
      expect(controller.isCleanupRequired, isFalse);
    });

    test('P2-C Path 2: Compensating STOP fails after startup failure -> preserves startup error and sets cleanupRequired = true', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));
      locationService.throwOnStartService = PlatformException(
        code: 'STARTUP_CLEANUP_FAILED',
        message: 'Durable active record mismatch and rollback failed',
        details: {'state': 'FAILED_CLEANUP'},
      );
      locationService.throwOnStopService = PlatformException(
        code: 'NATIVE_STOP_FAILED',
        message: 'Compensating stop failed',
        details: {'stopped': false},
      );

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(result, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.serviceStartupFailed));
      expect(controller.lastError, isNotNull);
      expect(controller.lastErrorCode, equals('STARTUP_CLEANUP_FAILED'));
      expect(controller.lastErrorMessage, contains('mismatch and rollback failed'));
      expect(controller.lastErrorDetails, equals({'state': 'FAILED_CLEANUP'}));
      expect(controller.lastError?.startupErrorCode, equals('STARTUP_CLEANUP_FAILED'));
      expect(controller.lastError?.cleanupErrorCode, equals('NATIVE_STOP_FAILED'));
      expect(controller.isCleanupRequired, isTrue);
    });

    test('P2-C Path 3: Cancellation fails after startup failure -> records cancellation error and sets cleanupRequired = true', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));
      locationService.throwOnStartService = PlatformException(
        code: 'NATIVE_START_FAILED',
        message: 'Foreground service failed to start',
      );
      locationService.throwOnCancelActivation = PlatformException(
        code: 'ACTIVATION_CANCEL_FAILED',
        message: 'Server failed to cancel intent',
        details: {'error': 'network_unavailable'},
      );

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(result, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(controller.lastError, isNotNull);
      expect(controller.lastErrorCode, equals('NATIVE_START_FAILED'));
      expect(controller.startupErrorCode, equals('NATIVE_START_FAILED'));
      expect(controller.cleanupErrorCode, isNull);
      expect(controller.cancellationErrorCode, equals('ACTIVATION_CANCEL_FAILED'));
      expect(controller.cancellationErrorMessage, contains('Server failed to cancel intent'));
      expect(controller.cancellationErrorDetails, equals({'error': 'network_unavailable'}));
      expect(controller.isCancellationPending, isTrue);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.pendingCancelSessionId, isNotNull);
    });

    test('P2-C Path 4: Both compensating STOP and cancellation fail -> preserves startup error and both secondary failures', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));
      locationService.throwOnStartService = PlatformException(
        code: 'NATIVE_START_FAILED',
        message: 'Initial start failure',
      );
      locationService.throwOnStopService = PlatformException(
        code: 'NATIVE_STOP_FAILED',
        message: 'Compensating stop failed',
      );
      locationService.throwOnCancelActivation = PlatformException(
        code: 'ACTIVATION_CANCEL_FAILED',
        message: 'Cancellation failed',
      );

      final result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(result, isFalse);
      expect(controller.lastErrorCode, equals('NATIVE_START_FAILED'));
      expect(controller.startupErrorCode, equals('NATIVE_START_FAILED'));
      expect(controller.cleanupErrorCode, equals('NATIVE_STOP_FAILED'));
      expect(controller.cancellationErrorCode, equals('ACTIVATION_CANCEL_FAILED'));
      expect(controller.isCancellationPending, isTrue);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.pendingCleanupSession, isNotNull);
      expect(controller.pendingCancelSessionId, isNotNull);
    });

    test('P2-C Path 5: retryCleanup() clears cleanup error and sets cleanupRequired = false when retry succeeds', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));
      locationService.throwOnStartService = PlatformException(
        code: 'NATIVE_START_FAILED',
        message: 'Initial start failure',
      );
      locationService.throwOnStopService = PlatformException(
        code: 'NATIVE_STOP_FAILED',
        message: 'Initial stop failed',
      );

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.cleanupErrorCode, equals('NATIVE_STOP_FAILED'));
      expect(controller.startupErrorCode, equals('NATIVE_START_FAILED'));

      // Now clear the failure condition so retry succeeds
      locationService.throwOnStopService = null;
      final retrySuccess = await controller.retryCleanup();

      expect(retrySuccess, isTrue);
      expect(controller.isCleanupRequired, isFalse);
      expect(controller.cleanupErrorCode, isNull);
      // Startup error remains preserved for diagnostic history!
      expect(controller.startupErrorCode, equals('NATIVE_START_FAILED'));
      expect(controller.lastErrorCode, equals('NATIVE_START_FAILED'));
    });

    test('P2-C Path 6: retryCleanup() clears cancellation error and sets cleanupRequired = false when retry succeeds', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));
      locationService.throwOnStartService = PlatformException(
        code: 'NATIVE_START_FAILED',
        message: 'Initial start failure',
      );
      locationService.throwOnCancelActivation = PlatformException(
        code: 'ACTIVATION_CANCEL_FAILED',
        message: 'Initial cancel failure',
      );

      await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.isCancellationPending, isTrue);
      expect(controller.cancellationErrorCode, equals('ACTIVATION_CANCEL_FAILED'));

      // Clear cancel failure condition
      locationService.throwOnCancelActivation = null;
      final retrySuccess = await controller.retryCleanup();

      expect(retrySuccess, isTrue);
      expect(controller.isCleanupRequired, isFalse);
      expect(controller.isCancellationPending, isFalse);
      expect(controller.cancellationErrorCode, isNull);
      expect(controller.startupErrorCode, equals('NATIVE_START_FAILED'));
    });

    test('P2-C Path 7: requestGoOffDuty NATIVE_STOP_FAILED sets cleanupRequired = true and retryCleanup can resolve it', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));
      final onOk = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(onOk, isTrue);
      expect(controller.isOnDuty, isTrue);

      locationService.throwOnStopService = PlatformException(
        code: 'NATIVE_STOP_FAILED',
        message: 'Native stop failed: disk failure',
        details: {'success': false, 'reason': 'disk_failure'},
      );

      final offOk = await controller.requestGoOffDuty();
      expect(offOk, isFalse);
      expect(controller.lastErrorCode, equals('NATIVE_STOP_FAILED'));
      expect(controller.cleanupErrorCode, equals('NATIVE_STOP_FAILED'));
      expect(controller.isCleanupRequired, isTrue);

      // Now resolve stop failure and retry
      locationService.throwOnStopService = null;
      final retrySuccess = await controller.retryCleanup();

      expect(retrySuccess, isTrue);
      expect(controller.isCleanupRequired, isFalse);
      expect(controller.cleanupErrorCode, isNull);
    });

    test('P2-C Regression: Unresolved S1 cancellation authority is immutable across S2 start and retried as UID1/X', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );

      // Step 1: S1 UID1/X starts
      authService.mockUser = FakeUser('UID1');
      final s1Profile = approvedProfile.copyWith(uid: 'UID1', isOnDuty: false);
      controller.updateProfile(s1Profile);
      locationService.nextPreparedSessionId = 'SESSION_X';

      // S1 fails during startDutySessionCall, triggering compensating cleanup
      locationService.throwOnStartSessionCall = PlatformException(
        code: 'START_SESSION_FAILED',
        message: 'Backend session start failed',
      );
      // S1 cancellation fails
      locationService.throwOnCancelActivation = PlatformException(
        code: 'ACTIVATION_CANCEL_FAILED',
        message: 'Cancellation network timeout',
        details: {'failure': 'timeout'},
      );

      final s1Result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(s1Result, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(controller.isCancellationPending, isTrue);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.cancellationErrorCode, equals('ACTIVATION_CANCEL_FAILED'));
      expect(controller.cancellationErrorMessage, equals('Cancellation network timeout'));
      expect(controller.pendingCancelUid, equals('UID1'));
      expect(controller.pendingCancelSessionId, equals('SESSION_X'));

      // Check first attempt call arguments
      expect(locationService.cancelActivationCalls.length, equals(1));
      expect(locationService.cancelActivationCalls[0]['uid'], equals('UID1'));
      expect(locationService.cancelActivationCalls[0]['sessionId'], equals('SESSION_X'));

      // Step 2: S2 UID2/X starts successfully
      authService.mockUser = FakeUser('UID2');
      final s2Profile = approvedProfile.copyWith(uid: 'UID2', isOnDuty: false);
      controller.updateProfile(s2Profile);
      locationService.throwOnStartSessionCall = null;
      locationService.nextPreparedSessionId = 'SESSION_X'; // SAME sessionId X!

      final s2Result = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(s2Result, isTrue);
      expect(controller.isOnDuty, isTrue);
      expect(controller.isHealthyOnDuty, isTrue);
      expect(controller.activeSession?.uid, equals('UID2'));
      expect(controller.activeSession?.sessionId, equals('SESSION_X'));

      // Step 3: Confirm unresolved S1 cleanup is still visible across S2 start!
      expect(controller.isCancellationPending, isTrue);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.cancellationErrorCode, equals('ACTIVATION_CANCEL_FAILED'));
      expect(controller.cancellationErrorMessage, equals('Cancellation network timeout'));
      expect(controller.pendingCancelUid, equals('UID1'));
      expect(controller.pendingCancelSessionId, equals('SESSION_X'));

      // Step 4: Call retryCleanup() while throwOnCancelActivation is still failing
      final retry1 = await controller.retryCleanup();
      expect(retry1, isFalse);
      // S2 remains active throughout!
      expect(controller.isOnDuty, isTrue);
      expect(controller.isHealthyOnDuty, isTrue);
      expect(controller.activeSession?.uid, equals('UID2'));
      // S1 cleanup remains pending!
      expect(controller.isCancellationPending, isTrue);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.cancellationErrorCode, equals('ACTIVATION_CANCEL_FAILED'));

      // Step 5: Now resolve cancellation failure condition and retry again
      locationService.throwOnCancelActivation = null;
      final retry2 = await controller.retryCleanup();
      expect(retry2, isTrue);

      // Successful S1 retry clears ONLY S1's pending cleanup
      expect(controller.isCancellationPending, isFalse);
      expect(controller.isCleanupRequired, isFalse);
      expect(controller.cancellationErrorCode, isNull);
      expect(controller.pendingCancelUid, isNull);
      expect(controller.pendingCancelSessionId, isNull);

      // S2 remains completely active and untouched throughout!
      expect(controller.isOnDuty, isTrue);
      expect(controller.isHealthyOnDuty, isTrue);
      expect(controller.activeSession?.uid, equals('UID2'));
      expect(controller.activeSession?.sessionId, equals('SESSION_X'));

      // Step 6: Verify ALL cancellation call arguments:
      // First attempt: UID1 / SESSION_X
      // Retry 1: UID1 / SESSION_X
      // Retry 2: UID1 / SESSION_X
      // FORBIDDEN: UID2 / SESSION_X
      for (final call in locationService.cancelActivationCalls) {
        expect(call['uid'], equals('UID1'));
        expect(call['sessionId'], equals('SESSION_X'));
        expect(call['uid'], isNot(equals('UID2')));
      }
      expect(locationService.cancelActivationCalls.length, equals(3));
    });

    test('M2-R2-5: requestGoOnDuty fails closed without calling startDutySessionCall when native lifecycleSeq is null or <= 0', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile);

      // Simulate native service starting but failing to allocate lifecycle sequence
      locationService.mockLifecycleSeq = null;

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
      );

      expect(result, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(controller.isHealthyOnDuty, isFalse);
      expect(controller.errorCategory, equals(HubErrorCategory.serviceStartupFailed));
      expect(controller.lastError?.code, equals('NATIVE_LIFECYCLE_SEQ_UNAVAILABLE'));

      // startDutySessionCall MUST NEVER have been invoked
      expect(
        locationService.operationLog.any((entry) => entry.startsWith('startDutySessionCall:')),
        isFalse,
      );
      // Service must have been stopped via compensating cleanup
      expect(locationService.serviceRunning, isFalse);
    });

    test('M2-R3-10: DutyController compensating cleanup and retryCleanup carry authoritative attemptSeq', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));

      locationService.nextPreparedSessionId = 'sess_attempt_test';
      locationService.nextPreparedGeneration = 2;
      locationService.nextPreparedAttemptSeq = 3;

      // Fail startDutySessionCall to trigger compensating cleanup
      locationService.throwOnStartSessionCall = PlatformException(
        code: 'START_FAILED',
        message: 'Simulated start failure',
      );
      // Make cancel fail initially to trigger PendingActivationCancellation retention
      locationService.throwOnCancelActivation = PlatformException(
        code: 'NETWORK_TIMEOUT',
        message: 'Timeout cancelling activation intent',
      );

      final result = await controller.requestGoOnDuty(
        onShowDisclosure: () async => true,
      );

      expect(result, isFalse);
      expect(controller.isOnDuty, isFalse);
      expect(controller.pendingCancellation, isNotNull);
      expect(controller.pendingCancellation!.sessionId, equals('sess_attempt_test'));
      expect(controller.pendingCancellation!.generation, equals(2));
      expect(controller.pendingCancellation!.attemptSeq, equals(3));

      // Check first cancel call recorded attemptSeq: 3
      expect(locationService.cancelActivationCalls.isNotEmpty, isTrue);
      final firstCancel = locationService.cancelActivationCalls.first;
      expect(firstCancel['sessionId'], equals('sess_attempt_test'));
      expect(firstCancel['generation'], equals(2));
      expect(firstCancel['attemptSeq'], equals(3));

      // Now retry cleanup: clear error, invoke retryCleanup
      locationService.throwOnCancelActivation = null;
      final retrySuccess = await controller.retryCleanup();

      expect(retrySuccess, isTrue);
      expect(controller.pendingCancellation, isNull);
      expect(controller.isCleanupRequired, isFalse);

      // Check second cancel call from retryCleanup also carried attemptSeq: 3
      final retryCancel = locationService.cancelActivationCalls.last;
      expect(retryCancel['sessionId'], equals('sess_attempt_test'));
      expect(retryCancel['generation'], equals(2));
      expect(retryCancel['attemptSeq'], equals(3));
    });

    test('M2-R3-11: Controller queue serialization prevents out-of-order prepare race', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      controller.updateProfile(approvedProfile.copyWith(isOnDuty: false));

      // Verify DutyController enforces strict serialized FIFO transitions:
      // Sequential enqueueing runs in order without race
      final res1 = await controller.requestGoOnDuty(onShowDisclosure: () async => true);
      expect(res1, isTrue);
      expect(controller.isOnDuty, isTrue);

      final res2 = await controller.requestGoOffDuty();
      expect(res2, isTrue);
      expect(controller.isOnDuty, isFalse);
      expect(controller.authoritativeDutyState, equals(AuthoritativeDutyState.offDuty));
    });
  });

  group('Group 9: Milestone 3 — Recovery Adoption & Authority Fencing (M3-I)', () {
    late TestAuthService authService;
    late TestLocationService locationService;
    late DriverProfile approvedProfile;

    setUp(() {
      authService = TestAuthService(FakeUser('driver_123'));
      locationService = TestLocationService()
        ..currentPos = DriverPosition(
          latitude: 18.5204,
          longitude: 73.8567,
          timestamp: DateTime.utc(2026, 9, 28),
        );
      approvedProfile = const DriverProfile(
        uid: 'driver_123',
        name: 'Test Driver',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: true,
      );
    });

    tearDown(() {
      authService.dispose();
    });

    test('M3-I-1: Exact source epoch is forwarded to recovery callable', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final profile = approvedProfile.copyWith(
        isOnDuty: true,
        activeJobId: 'job_rec_1',
        activeDutySessionId: 'sess_s1_rec',
        dutyGeneration: 2,
        lifecycleSeq: 5,
      );
      controller.updateProfile(profile);

      await controller.reconcileDutyState();

      expect(locationService.recoverCalls.length, equals(1));
      final call = locationService.recoverCalls.first;
      expect(call['uid'], equals('driver_123'));
      expect(call['activeDutySessionId'], equals('sess_s1_rec'));
      expect(call['dutyGeneration'], equals(2));
      expect(call['lifecycleSeq'], equals(5));
      expect(call['expectedActiveJobId'], equals('job_rec_1'));
    });

    test('M3-I-2: Exact independent repro - held R1 released after server moved to S2 while controller cache remains stale -> foreground starts = 0, adoption = 0', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final profile = approvedProfile.copyWith(
        isOnDuty: true,
        activeJobId: 'job_rec_1',
        activeDutySessionId: 'sess_s1_stale',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      // Controller holds cached S1 profile
      controller.updateProfile(profile);

      locationService.recoveryResponse = {
        'sessionId': 'driver_123_rec_s1',
        'dutyGeneration': 2,
        'workerReady': false,
        'lifecycleSeq': null,
        'activeJobId': 'job_rec_1',
        'status': 'recovered',
      };

      // Server authority moves to S2 while controller cache is NOT updated
      locationService.serverDriverState = {
        'isOnDuty': true,
        'activeDutySessionId': 'sess_s2_newer',
        'dutyGeneration': 5,
        'activeJobId': 'job_rec_1',
        'workerReady': true,
        'lifecycleSeq': 10,
      };

      // R1 is released / reconcileDutyState runs
      await controller.reconcileDutyState();

      // Controller MUST NOT start foreground service or adopt S1
      expect(locationService.foregroundStartCount, equals(0));
      expect(controller.activeSession, isNull);
    });

    test('M3-I-3: Response missing generation -> foreground starts = 0', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final profile = approvedProfile.copyWith(
        isOnDuty: true,
        activeJobId: 'job_rec_3',
        activeDutySessionId: 'sess_s1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(profile);

      // Response missing dutyGeneration
      locationService.recoveryResponse = {
        'sessionId': 'driver_123_rec_3',
        'workerReady': false,
        'lifecycleSeq': null,
        'activeJobId': 'job_rec_3',
        'status': 'recovered',
      };

      locationService.serverDriverState = {
        'isOnDuty': true,
        'activeDutySessionId': 'driver_123_rec_3',
        'dutyGeneration': 2,
        'activeJobId': 'job_rec_3',
        'workerReady': false,
        'lifecycleSeq': null,
      };

      await controller.reconcileDutyState();

      expect(locationService.foregroundStartCount, equals(0));
      expect(controller.activeSession, isNull);
    });

    test('M3-I-4: Response session missing/malformed -> foreground starts = 0', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final profile = approvedProfile.copyWith(
        isOnDuty: true,
        activeJobId: 'job_rec_4',
        activeDutySessionId: 'sess_s1',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(profile);

      // Malformed whitespace-only sessionId
      locationService.recoveryResponse = {
        'sessionId': '   ',
        'dutyGeneration': 2,
        'workerReady': false,
        'lifecycleSeq': null,
        'activeJobId': 'job_rec_4',
        'status': 'recovered',
      };

      locationService.serverDriverState = {
        'isOnDuty': true,
        'activeDutySessionId': 'driver_123_rec_4',
        'dutyGeneration': 2,
        'activeJobId': 'job_rec_4',
        'workerReady': false,
        'lifecycleSeq': null,
      };

      await controller.reconcileDutyState();

      expect(locationService.foregroundStartCount, equals(0));
      expect(controller.activeSession, isNull);
    });

    test('M3-I-5: Exact current server result -> foreground start allowed (starts = 1)', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final profile = approvedProfile.copyWith(
        isOnDuty: true,
        activeJobId: 'job_rec_5',
        activeDutySessionId: 'sess_s1_adopt',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(profile);
      // Reconciliation first reads the current source epoch; recovery then
      // performs its own fresh confirmation of the recovered epoch.
      locationService.queuedServerDriverStates.add(
        await locationService.fetchServerDriverState(profile.uid),
      );

      locationService.recoveryResponse = {
        'sessionId': 'driver_123_rec_adopted',
        'dutyGeneration': 2,
        'workerReady': false,
        'lifecycleSeq': null,
        'activeJobId': 'job_rec_5',
        'status': 'recovered',
      };

      // Server authority exactly matches recovery outcome
      locationService.serverDriverState = {
        'isOnDuty': true,
        'activeDutySessionId': 'driver_123_rec_adopted',
        'dutyGeneration': 2,
        'activeJobId': 'job_rec_5',
        'workerReady': false,
        'lifecycleSeq': null,
      };

      await controller.reconcileDutyState();

      expect(locationService.foregroundStartCount, equals(1));
      expect(controller.isOnDuty, isTrue);
      expect(controller.activeSession?.sessionId, equals('driver_123_rec_adopted'));
      expect(controller.activeSession?.generation, equals(2));
    });

    test('M3-I-6: Authoritative verification unavailable/fails -> foreground starts = 0', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final profile = approvedProfile.copyWith(
        isOnDuty: true,
        activeJobId: 'job_rec_6',
        activeDutySessionId: 'sess_s1_fail',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(profile);

      locationService.recoveryResponse = {
        'sessionId': 'driver_123_rec_fail',
        'dutyGeneration': 2,
        'workerReady': false,
        'lifecycleSeq': null,
        'activeJobId': 'job_rec_6',
        'status': 'recovered',
      };

      // Server state fetch fails / returns null
      locationService.serverDriverState = null;
      locationService.useFixtureFreshProfile = false;

      await controller.reconcileDutyState();

      expect(locationService.foregroundStartCount, equals(0));
      expect(controller.activeSession, isNull);
    });

    test('M3-I-7: Missing source epoch fields prevents recovery call entirely', () async {
      final controller = FixtureDutyController(
        locationService: locationService,
        authService: authService,
      );
      final profile = approvedProfile.copyWith(
        isOnDuty: true,
        activeJobId: 'job_no_session',
        activeDutySessionId: null,
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      controller.updateProfile(profile);

      await controller.reconcileDutyState();

      expect(locationService.recoverCalls.isEmpty, isTrue);
    });
  });
}

// M4-E: a held reconciliation must not write after its operation token loses.
void m4EStaleReconciliationTests() {
  Map<String, dynamic> fresh(DriverProfile profile) => {
    'uid': profile.uid,
    'name': profile.name,
    'phone': profile.phone,
    'truckType': profile.truckType.backendValue,
    'vehicleNumber': profile.vehicleNumber,
    'verificationStatus': profile.verificationStatus,
    'isOnDuty': profile.isOnDuty,
    'activeJobId': profile.activeJobId,
    'activeDutySessionId': profile.activeDutySessionId,
    'dutyGeneration': profile.dutyGeneration,
    'lifecycleSeq': profile.lifecycleSeq,
    'workerReady': profile.workerReady,
  };
  group('M4-E stale reconciliation', () {
    late TestAuthService auth;
    late TestLocationService location;
    late FixtureDutyController controller;
    late DriverProfile offA;

    setUp(() {
      auth = TestAuthService(FakeUser('uid-a'));
      location = TestLocationService();
      controller = FixtureDutyController(locationService: location, authService: auth);
      offA = const DriverProfile(
        uid: 'uid-a', name: 'Driver A', phone: '+919876543210',
        truckType: TruckType.flatbed, vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved', isOnDuty: false,
      );
      controller.updateProfile(offA);
    });

    tearDown(() {
      controller.dispose();
      auth.dispose();
    });

    for (final fails in [true, false]) {
      test('old UID-A fresh ${fails ? 'failure' : 'success'} leaves UID-B clean OFF', () async {
        final entered = Completer<void>();
        final held = Completer<Map<String, dynamic>?>();
        location.fetchServerDriverStateOverride = (uid) {
          if (uid == 'uid-a') {
            entered.complete();
            return held.future;
          }
          return Future.value(fresh(offA.copyWith(uid: 'uid-b')));
        };
        final stale = controller.reconcileDutyState();
        await entered.future;
        auth.emitUser(FakeUser('uid-b'));
        await Future<void>.delayed(Duration.zero);
        controller.updateProfile(offA.copyWith(uid: 'uid-b'));
        expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
        final health = controller.trackingHealth;
        final error = controller.errorCategory;
        final canToggle = controller.canToggleDuty;
        if (fails) {
          held.completeError(StateError('old A read failed'));
        } else {
          held.complete(fresh(offA.copyWith(
            isOnDuty: true, activeDutySessionId: 'old-a', dutyGeneration: 1,
          )));
        }
        await stale;
        expect(controller.boundUid, 'uid-b');
        expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
        expect(controller.trackingHealth, health);
        expect(controller.errorCategory, error);
        expect(controller.canToggleDuty, canToggle);
        expect(location.operationLog.where((s) => s.startsWith('stopForegroundService')), isEmpty);
      });
    }

    test('same UID older success cannot heal newer UNKNOWN', () async {
      final entered = Completer<void>();
      final held = Completer<Map<String, dynamic>?>();
      var reads = 0;
      location.fetchServerDriverStateOverride = (_) {
        if (reads++ == 0) {
          entered.complete();
          return held.future;
        }
        return Future.value(null);
      };
      final old = controller.reconcileDutyState();
      await entered.future;
      final newer = controller.reconcileDutyState();
      held.complete(fresh(offA));
      await old;
      await newer;
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
    });

    test('same UID older failure cannot demote newer READY', () async {
      final ready = offA.copyWith(
        isOnDuty: true, activeDutySessionId: 'ready-session',
        dutyGeneration: 2, lifecycleSeq: 3, workerReady: true,
      );
      final entered = Completer<void>();
      final held = Completer<Map<String, dynamic>?>();
      var reads = 0;
      location.fetchServerDriverStateOverride = (_) {
        if (reads++ == 0) {
          entered.complete();
          return held.future;
        }
        return Future.value(fresh(ready));
      };
      final old = controller.reconcileDutyState();
      await entered.future;
      controller.updateProfile(ready);
      location.durableSession = const DutySession(
        uid: 'uid-a', sessionId: 'ready-session', generation: 2, lifecycleSeq: 3,
      );
      location.mockLifecycleSeq = 3;
      location.serviceRunning = true;
      final newer = controller.reconcileDutyState();
      held.completeError(StateError('old read failed'));
      await old;
      await newer;
      expect(controller.isReady, isTrue);
      expect(controller.trackingHealth, TrackingHealth.healthy);
    });

    test('late cleanup completion cannot clear newer cleanup required', () async {
      final session = const DutySession(
        uid: 'uid-a', sessionId: 'residual', generation: 1, lifecycleSeq: 1,
      );
      location.currentSession = session;
      location.durableSession = session;
      location.serviceRunning = true;
      final entered = Completer<void>();
      final held = Completer<void>();
      var stops = 0;
      location.stopServiceOverride = () async {
        if (stops++ == 0) {
          entered.complete();
          await held.future;
        } else {
          throw StateError('replacement cleanup failed');
        }
      };
      final old = controller.reconcileDutyState();
      await entered.future;
      final newer = controller.reconcileDutyState();
      held.complete();
      await old;
      await newer;
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.isCleanupRequired, isTrue);
      expect(controller.lastErrorCode, 'NATIVE_STOP_FAILED');
    });

    test('late recovery start cannot adopt into newer reconciliation', () async {
      final source = offA.copyWith(
        isOnDuty: true, activeJobId: 'job-1',
        activeDutySessionId: 'source', dutyGeneration: 1, lifecycleSeq: 1,
      );
      controller.updateProfile(source);
      location.recoveryResponse = {
        'sessionId': 'recovered', 'dutyGeneration': 2, 'status': 'recovered',
      };
      var reads = 0;
      location.fetchServerDriverStateOverride = (_) {
        reads++;
        if (reads == 1) {
          return Future.value(fresh(source));
        }
        if (reads == 2) {
          return Future.value({
            'isOnDuty': true, 'activeDutySessionId': 'recovered',
            'dutyGeneration': 2, 'activeJobId': 'job-1',
            'workerReady': false, 'lifecycleSeq': null,
          });
        }
        return Future.value(null);
      };
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async {
        entered.complete();
        await held.future;
      };
      final old = controller.reconcileDutyState();
      await entered.future;
      final newer = controller.reconcileDutyState();
      held.complete();
      await old;
      expect(controller.activeSession, isNull);
      await newer;
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.unknown);
      expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
      expect(controller.activeSession, isNull);
    });

    void prepareRecovery() {
      final source = offA.copyWith(
        isOnDuty: true, activeJobId: 'job-1',
        activeDutySessionId: 'source', dutyGeneration: 1, lifecycleSeq: 1,
      );
      controller.updateProfile(source);
      location.recoveryResponse = {
        'sessionId': 'recovered', 'dutyGeneration': 2, 'status': 'recovered',
      };
      var reads = 0;
      location.fetchServerDriverStateOverride = (_) {
        if (++reads == 1) return Future.value(fresh(source));
        return Future.value({
          'isOnDuty': true, 'activeDutySessionId': 'recovered',
          'dutyGeneration': 2, 'activeJobId': 'job-1',
          'workerReady': false, 'lifecycleSeq': null,
        });
      };
    }

    test('M4-E-7: delayed A start is compensated after B becomes clean OFF', () async {
      prepareRecovery();
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async { entered.complete(); await held.future; };
      final old = controller.reconcileDutyState();
      await entered.future;
      auth.emitUser(FakeUser('uid-b'));
      await Future<void>.delayed(Duration.zero);
      controller.updateProfile(offA.copyWith(uid: 'uid-b'));
      final health = controller.trackingHealth;
      final error = controller.errorCategory;
      final controls = controller.canToggleDuty;
      held.complete();
      await old;
      expect(controller.boundUid, 'uid-b');
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.activeSession, isNull);
      expect(controller.trackingHealth, health);
      expect(controller.errorCategory, error);
      expect(controller.canToggleDuty, controls);
      expect(location.serviceRunning, isFalse);
      expect(await location.getDurableOwnerRecord(), isNull);
      expect(location.operationLog, contains('stopForegroundService:recovered'));
    });

    test('M4-E-8: stale cleanup leaves newer UID-B native owner running', () async {
      prepareRecovery();
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async { entered.complete(); await held.future; };
      final old = controller.reconcileDutyState();
      await entered.future;
      auth.emitUser(FakeUser('uid-b'));
      await Future<void>.delayed(Duration.zero);
      controller.updateProfile(offA.copyWith(uid: 'uid-b'));
      final newer = const DutySession(uid: 'uid-b', sessionId: 'newer', generation: 3, lifecycleSeq: 2);
      location.durableOwnerOverride = () async {
        location.currentSession = newer;
        location.serviceRunning = true;
        location.durableOwnerOverride = null;
        return location.getDurableOwnerRecord();
      };
      held.complete();
      await old;
      expect(location.serviceRunning, isTrue);
      expect((await location.getDurableOwnerRecord())?.uid, 'uid-b');
      expect(location.operationLog.where((s) => s.startsWith('stopForegroundService')), isEmpty);
    });

    test('M4-E-9: stale cleanup leaves newer same-UID epoch running', () async {
      prepareRecovery();
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async { entered.complete(); await held.future; };
      final old = controller.reconcileDutyState();
      await entered.future;
      final newerReconcile = controller.reconcileDutyState();
      final newer = const DutySession(uid: 'uid-a', sessionId: 'recovered', generation: 3, lifecycleSeq: 2);
      location.durableOwnerOverride = () async {
        location.currentSession = newer;
        location.serviceRunning = true;
        location.durableOwnerOverride = null;
        return location.getDurableOwnerRecord();
      };
      held.complete();
      await old;
      await newerReconcile;
      expect(location.serviceRunning, isTrue);
      expect((await location.getDurableOwnerRecord())?.generation, 3);
      expect(location.operationLog.where((s) => s.startsWith('stopForegroundService')), isEmpty);
    });

    test('M4-E-11: current recovery start adopts without compensation', () async {
      prepareRecovery();
      await controller.reconcileDutyState();
      expect(controller.activeSession?.sessionId, 'recovered');
      expect(controller.trackingHealth, TrackingHealth.starting);
      expect(location.serviceRunning, isTrue);
      expect(location.operationLog.where((s) => s.startsWith('stopForegroundService')), isEmpty);
    });

    test('M4-E-12: normal recovery retains native allocated sequence', () async {
      prepareRecovery();
      location.allocatedLifecycleSeq = 7;
      await controller.reconcileDutyState();
      expect(controller.activeSession, const DutySession(
        uid: 'uid-a', sessionId: 'recovered', generation: 2, lifecycleSeq: 7,
      ));
      expect(controller.activeLifecycleSeq, 7);
      expect(controller.trackingHealth, TrackingHealth.starting);
      expect(controller.staleStartCleanupError, isNull);
      expect(location.exactStopRequests, isEmpty);
    });

    test('M4-E-13: stale compensation stops allocated sequence', () async {
      prepareRecovery();
      location.allocatedLifecycleSeq = 7;
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async { entered.complete(); await held.future; };
      final old = controller.reconcileDutyState();
      await entered.future;
      auth.emitUser(FakeUser('uid-b'));
      await Future<void>.delayed(Duration.zero);
      controller.updateProfile(offA.copyWith(uid: 'uid-b'));
      final health = controller.trackingHealth;
      final error = controller.errorCategory;
      held.complete();
      await old;
      expect(location.exactStopRequests, [const DutySession(
        uid: 'uid-a', sessionId: 'recovered', generation: 2, lifecycleSeq: 7,
      )]);
      expect(location.serviceRunning, isFalse);
      expect(await location.getDurableOwnerRecord(), isNull);
      expect(controller.boundUid, 'uid-b');
      expect(controller.activeSession, isNull);
      expect(controller.trackingHealth, health);
      expect(controller.errorCategory, error);
    });

    test('M4-E-14: stale L7 cannot stop same-UID newer L8', () async {
      prepareRecovery();
      location.allocatedLifecycleSeq = 7;
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async { entered.complete(); await held.future; };
      final old = controller.reconcileDutyState();
      await entered.future;
      final newerReconcile = controller.reconcileDutyState();
      const newer = DutySession(
        uid: 'uid-a', sessionId: 'recovered', generation: 2, lifecycleSeq: 8,
      );
      location.durableOwnerOverride = () async {
        location.currentSession = newer;
        location.serviceRunning = true;
        location.durableOwnerOverride = null;
        return location.getDurableOwnerRecord();
      };
      held.complete();
      await old;
      await newerReconcile;
      expect(location.serviceRunning, isTrue);
      expect((await location.getDurableOwnerRecord())?.lifecycleSeq, 8);
      expect(location.exactStopRequests, isEmpty);
    });

    test('M4-E-15: normal resume retains native allocated authority', () async {
      prepareRecovery();
      location.allocatedLifecycleSeq = 7;
      await controller.reconcileDutyState();
      final recovered = offA.copyWith(
        isOnDuty: true, activeDutySessionId: 'recovered',
        dutyGeneration: 2, lifecycleSeq: 7, workerReady: false,
      );
      controller.updateProfile(recovered);
      location.fetchServerDriverStateOverride = (_) => Future.value(fresh(recovered));
      location.currentSession = null;
      location.serviceRunning = false;
      location.allocatedLifecycleSeq = 8;
      await controller.reconcileDutyState();
      expect(controller.activeSession, const DutySession(
        uid: 'uid-a', sessionId: 'recovered', generation: 2, lifecycleSeq: 8,
      ));
      expect(controller.activeLifecycleSeq, 8);
      expect(controller.trackingHealth, TrackingHealth.starting);
      expect(location.exactStopRequests, isEmpty);
    });

    for (final nativeSeq in <int?>[7, null, 1]) {
      test('M4-EXACT-${nativeSeq == 7 ? '1/4 mismatch' : nativeSeq == null ? '3 unknown' : '2 exact L1'}: second durable read sequence $nativeSeq', () async {
        final server = offA.copyWith(
          isOnDuty: true, activeDutySessionId: 'same-session',
          dutyGeneration: 2, lifecycleSeq: 1, workerReady: true,
        );
        controller.updateProfile(server);
        location.fetchServerDriverStateOverride = (_) => Future.value(fresh(server));
        var ownerReads = 0;
        location.durableOwnerOverride = () async {
          ownerReads++;
          return null;
        };
        location.durableSession = DutySession(
          uid: 'uid-a', sessionId: 'same-session', generation: 2,
          lifecycleSeq: nativeSeq,
        );
        location.durableSessionOverride = () async {
          ownerReads++;
          return location.durableSession;
        };
        location.serviceRunning = true;
        await controller.reconcileDutyState();
        expect(ownerReads, 2);
        if (nativeSeq == 1) {
          expect(controller.isReady, isTrue);
          expect(controller.activeLifecycleSeq, 1);
        } else {
          expect(controller.isReady, isFalse);
          expect(controller.activeSession, isNull);
          expect(controller.activeLifecycleSeq, isNull);
          expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
        }
      });
    }

    test('M4-EXACT-2: second durable read adopts exact L7', () async {
      final server = offA.copyWith(
        isOnDuty: true, activeDutySessionId: 'same-session',
        dutyGeneration: 2, lifecycleSeq: 7, workerReady: true,
      );
      controller.updateProfile(server);
      location.fetchServerDriverStateOverride = (_) => Future.value(fresh(server));
      location.durableOwnerOverride = () async => null;
      location.durableSession = const DutySession(
        uid: 'uid-a', sessionId: 'same-session', generation: 2, lifecycleSeq: 7,
      );
      location.serviceRunning = true;
      await controller.reconcileDutyState();
      expect(controller.isReady, isTrue);
      expect(controller.activeLifecycleSeq, 7);
    });

    test('M4-E-10: stale throw after native side effect is compensated', () async {
      prepareRecovery();
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async { entered.complete(); await held.future; };
      location.throwAfterStartSideEffect = true;
      final old = controller.reconcileDutyState();
      await entered.future;
      auth.emitUser(FakeUser('uid-b'));
      await Future<void>.delayed(Duration.zero);
      controller.updateProfile(offA.copyWith(uid: 'uid-b'));
      held.complete();
      await old;
      expect(location.serviceRunning, isFalse);
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.activeSession, isNull);
    });

    test('stale compensation failure is isolated without changing B state', () async {
      prepareRecovery();
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async { entered.complete(); await held.future; };
      location.throwOnStopService = Exception('exact stop failed');
      final old = controller.reconcileDutyState();
      await entered.future;
      auth.emitUser(FakeUser('uid-b'));
      await Future<void>.delayed(Duration.zero);
      controller.updateProfile(offA.copyWith(uid: 'uid-b'));
      held.complete();
      await old;
      expect(controller.authoritativeDutyState, AuthoritativeDutyState.offDuty);
      expect(controller.activeSession, isNull);
      expect(controller.staleStartCleanupError, isNull);
    });

    test('stale compensation failure is recorded in forensic diagnostic when Auth is null', () async {
      prepareRecovery();
      final entered = Completer<void>();
      final held = Completer<void>();
      location.startServiceOverride = () async { entered.complete(); await held.future; };
      location.throwOnStopService = Exception('exact stop failed');
      final old = controller.reconcileDutyState();
      await entered.future;
      auth.emitUser(null);
      await Future<void>.delayed(Duration.zero);
      held.complete();
      await old;
      expect(controller.staleStartCleanupError, contains('exact stop failed'));
    });
  });
}
