// ignore_for_file: subtype_of_sealed_class, must_be_immutable
import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

class FakeUser implements User {
  @override
  final String uid;
  FakeUser(this.uid);

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeFirebaseAuth implements FirebaseAuth {
  User? _currentUser;
  bool throwOnCurrentUser = false;

  FakeFirebaseAuth(this._currentUser);

  @override
  User? get currentUser {
    if (throwOnCurrentUser) throw StateError('Auth unavailable');
    return _currentUser;
  }

  set currentUser(User? user) {
    _currentUser = user;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeDocumentSnapshot implements DocumentSnapshot<Map<String, dynamic>> {
  @override
  final bool exists;
  final Map<String, dynamic>? _data;
  FakeDocumentSnapshot(this.exists, this._data);

  @override
  Map<String, dynamic>? data() => _data;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeDocumentReference implements DocumentReference<Map<String, dynamic>> {
  @override
  final String id;
  final Map<String, dynamic> documents;
  FakeDocumentReference(this.id, this.documents);

  @override
  Future<DocumentSnapshot<Map<String, dynamic>>> get([GetOptions? options]) async {
    return FakeDocumentSnapshot(true, documents[id] ?? {
      'isOnDuty': true,
      'verificationStatus': 'approved',
    });
  }

  @override
  Future<void> update(Map<Object, Object?> data) async {
    final existing = documents[id] is Map<String, dynamic>
        ? documents[id] as Map<String, dynamic>
        : <String, dynamic>{};
    final merged = Map<String, dynamic>.from(existing);
    data.forEach((k, v) {
      merged[k.toString()] = v;
    });
    documents[id] = merged;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeCollectionReference implements CollectionReference<Map<String, dynamic>> {
  final Map<String, dynamic> documents;
  FakeCollectionReference(this.documents);

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) {
    return FakeDocumentReference(path ?? 'unknown', documents);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeTransaction implements Transaction {
  final Map<String, dynamic> documents;
  FakeTransaction(this.documents);

  @override
  Future<DocumentSnapshot<T>> get<T extends Object?>(DocumentReference<T> documentReference) async {
    final id = (documentReference as FakeDocumentReference).id;
    return FakeDocumentSnapshot(true, documents[id] is Map<String, dynamic> ? documents[id] as Map<String, dynamic> : {}) as DocumentSnapshot<T>;
  }

  @override
  Transaction update(DocumentReference documentReference, Map<Object, Object?> data) {
    final id = (documentReference as FakeDocumentReference).id;
    final existing = documents[id] is Map<String, dynamic>
        ? documents[id] as Map<String, dynamic>
        : <String, dynamic>{};
    final merged = Map<String, dynamic>.from(existing);
    data.forEach((k, v) {
      merged[k.toString()] = v;
    });
    documents[id] = merged;
    return this;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeFirebaseFirestore implements FirebaseFirestore {
  final Map<String, dynamic> documents = {};

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) {
    return FakeCollectionReference(documents);
  }

  @override
  Future<T> runTransaction<T>(
    TransactionHandler<T> transactionHandler, {
    Duration timeout = const Duration(seconds: 30),
    int maxAttempts = 5,
  }) async {
    final tx = FakeTransaction(documents);
    return transactionHandler(tx);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class MockLocationService implements LocationService {
  bool serviceEnabled = true;
  LocationPermissionStatus permissionStatus = LocationPermissionStatus.granted;
  DriverPosition? nextPosition;
  bool isServiceRunning = false;
  DutySession? currentSession;
  DutySession? durableSession;
  DriverPosition? _lastPos;

  final List<DriverPosition> recordedPositions = [];
  final List<bool> dutyHistory = [];
  final StreamController<DriverPosition> _positionStreamController =
      StreamController<DriverPosition>.broadcast();

  @override
  DutySession? get currentServiceSession => currentSession;

  @override
  int? get currentLifecycleSeq => null;

  @override
  int? get currentGeneration => null;

  @override
  Future<DutySession?> getDurableSession() async => durableSession ?? currentSession;

  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    final ds = durableSession ?? currentSession;
    if (ds == null) return null;
    return DurableDutyOwnerRecord(
      sessionId: ds.sessionId,
      uid: ds.uid,
      generation: ds.generation,
      lifecycleSeq: 1,
      startedAt: DateTime.now(),
    );
  }

  @override
  Future<bool> isForegroundServiceRunning() async => isServiceRunning;

  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;

  @override
  Future<LocationPermissionStatus> checkPermission() async => permissionStatus;

  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async => permissionStatus;

  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async => permissionStatus;

  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async => permissionStatus;

  @override
  Future<bool> hasRequiredPermissions() async =>
      serviceEnabled && permissionStatus == LocationPermissionStatus.granted;

  @override
  Future<DriverPosition?> getCurrentPosition() async => nextPosition;

  @override
  Stream<DriverPosition> getPositionStream() => _positionStreamController.stream;

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    onAuthorityAllocated?.call(session);
    currentSession = session;
    isServiceRunning = true;
    return true;
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    if (currentSession != null && currentSession!.sessionId != expectedSessionId) {
      return;
    }
    currentSession = null;
    isServiceRunning = false;
  }

  @override
  DriverPosition? get lastKnownPosition => _lastPos;

  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => null;

  @override
  Future<void> sendHeartbeat({
    required String uid,
    required DriverPosition position,
  }) async {
    recordedPositions.add(position);
  }

  @override
  Future<void> executeGoOnDutyTransaction({required String uid}) async {
    dutyHistory.add(true);
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    dutyHistory.add(false);
  }

  @override
  Future<DutyActivationPreparation> prepareDutyActivation({
    required String uid,
    String? clientRequestId,
  }) async {
    return DutyActivationPreparation(
      sessionId: '${uid}_${DateTime.now().microsecondsSinceEpoch}',
      generation: 1,
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
    await executeGoOnDutyTransaction(uid: uid);
    return {'status': 'activated', 'dutyGeneration': generation ?? 1, 'lifecycleSeq': lifecycleSeq ?? 1, 'workerReady': true};
  }

  @override
  Future<void> cancelDutyActivationCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
    int? attemptSeq,
  }) async {}

  @override
  Future<void> endDutySessionCall({
    required String uid,
    required String sessionId,
    int? generation,
    int? lifecycleSeq,
  }) async {
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
    return {
      'sessionId': '${uid}_recovered',
      'dutyGeneration': 1,
      'workerReady': false,
      'lifecycleSeq': null,
      'activeJobId': expectedActiveJobId,
      'status': 'recovered',
    };
  }

  @override
  Future<bool> openAppSettings() async => true;

  @override
  void dispose() {
    _positionStreamController.close();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  group('DriverPosition and Location Validation Tests', () {
    test('validates correct coordinates within global boundaries', () {
      final pos = DriverPosition(
        latitude: 18.5204,
        longitude: 73.8567,
        timestamp: DateTime.utc(2026),
      );
      expect(pos.isValid, isTrue);
      expect(() => DriverPosition.validateCoordinates(18.5204, 73.8567), returnsNormally);
    });

    test('validates coordinates on exact boundary limits (-90, 90, -180, 180)', () {
      expect(DriverPosition(latitude: 90.0, longitude: 180.0, timestamp: DateTime.utc(2026)).isValid, isTrue);
      expect(DriverPosition(latitude: -90.0, longitude: -180.0, timestamp: DateTime.utc(2026)).isValid, isTrue);
      expect(() => DriverPosition.validateCoordinates(90.0, 180.0), returnsNormally);
      expect(() => DriverPosition.validateCoordinates(-90.0, -180.0), returnsNormally);
    });

    test('validates coordinates at (0, 0)', () {
      final pos = DriverPosition(latitude: 0.0, longitude: 0.0, timestamp: DateTime.utc(2026));
      expect(pos.isValid, isTrue);
      expect(() => DriverPosition.validateCoordinates(0.0, 0.0), returnsNormally);
    });

    test('rejects out of bounds latitude', () {
      final pos = DriverPosition(
        latitude: 95.0,
        longitude: 73.8567,
        timestamp: DateTime.utc(2026),
      );
      expect(pos.isValid, isFalse);
      expect(() => DriverPosition.validateCoordinates(95.0, 73.8567), throwsArgumentError);
    });

    test('rejects out of bounds negative latitude', () {
      final pos = DriverPosition(
        latitude: -90.001,
        longitude: 73.8567,
        timestamp: DateTime.utc(2026),
      );
      expect(pos.isValid, isFalse);
      expect(() => DriverPosition.validateCoordinates(-90.001, 73.8567), throwsArgumentError);
    });

    test('rejects out of bounds longitude', () {
      final pos = DriverPosition(
        latitude: 18.5204,
        longitude: 195.0,
        timestamp: DateTime.utc(2026),
      );
      expect(pos.isValid, isFalse);
      expect(() => DriverPosition.validateCoordinates(18.5204, 195.0), throwsArgumentError);
    });

    test('rejects out of bounds negative longitude', () {
      final pos = DriverPosition(
        latitude: 18.5204,
        longitude: -180.001,
        timestamp: DateTime.utc(2026),
      );
      expect(pos.isValid, isFalse);
      expect(() => DriverPosition.validateCoordinates(18.5204, -180.001), throwsArgumentError);
    });

    test('rejects NaN and infinite coordinates', () {
      expect(() => DriverPosition.validateCoordinates(double.nan, 73.0), throwsArgumentError);
      expect(() => DriverPosition.validateCoordinates(18.0, double.infinity), throwsArgumentError);
    });

    test('validates equality, hashCode, and toString format', () {
      final pos1 = DriverPosition(latitude: 18.5, longitude: 73.8, timestamp: DateTime.utc(2026));
      final pos2 = DriverPosition(latitude: 18.5, longitude: 73.8, timestamp: DateTime.utc(2026));
      final pos3 = DriverPosition(latitude: 19.5, longitude: 73.8, timestamp: DateTime.utc(2026));

      expect(pos1, equals(pos2));
      expect(pos1.hashCode, equals(pos2.hashCode));
      expect(pos1, isNot(equals(pos3)));
      expect(pos1.toString(), contains('DriverPosition(lat: 18.5, lng: 73.8'));
    });

    test('factory DriverPosition.fromGeolocator correctly maps all fields', () {
      final geoPos = Position(
        latitude: 18.5204,
        longitude: 73.8567,
        timestamp: DateTime.utc(2026, 9, 13),
        altitude: 500.0,
        altitudeAccuracy: 5.0,
        accuracy: 10.0,
        heading: 90.0,
        headingAccuracy: 2.0,
        speed: 15.0,
        speedAccuracy: 1.0,
      );
      final driverPos = DriverPosition.fromGeolocator(geoPos);
      expect(driverPos.latitude, equals(18.5204));
      expect(driverPos.longitude, equals(73.8567));
      expect(driverPos.accuracy, equals(10.0));
      expect(driverPos.altitude, equals(500.0));
      expect(driverPos.heading, equals(90.0));
      expect(driverPos.speed, equals(15.0));
      expect(driverPos.timestamp, equals(geoPos.timestamp));
    });
  });

  group('Group 2: Foreground Service Session Ownership in DriverLocationService', () {
    const channel = MethodChannel('flutter_foreground_task/methods');
    const prefChannel = MethodChannel('plugins.flutter.io/shared_preferences');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final Map<String, dynamic> storedData = {};
    final Map<String, Object> prefData = {};
    final List<String> channelCalls = [];

    bool isRunning = false;
    String? storedOwnerJson;
    int monotonicSeq = 0;
    bool failNativeStop = false;

    setUp(() {
      isRunning = false;
      storedOwnerJson = null;
      monotonicSeq = 0;
      failNativeStop = false;
      storedData.clear();
      prefData.clear();
      channelCalls.clear();
      messenger.setMockMethodCallHandler(prefChannel, (call) async {
        if (call.method == 'getAll') {
          return prefData;
        }
        if (call.method == 'setString') {
          final key = call.arguments['key'] as String;
          final value = call.arguments['value'] as String;
          prefData[key] = value;
          return true;
        }
        if (call.method == 'setInt') {
          final key = call.arguments['key'] as String;
          final value = call.arguments['value'] as int;
          prefData[key] = value;
          return true;
        }
        if (call.method == 'setBool') {
          final key = call.arguments['key'] as String;
          final value = call.arguments['value'] as bool;
          prefData[key] = value;
          return true;
        }
        if (call.method == 'remove') {
          final key = call.arguments['key'] as String;
          prefData.remove(key);
          return true;
        }
        if (call.method == 'clear') {
          prefData.clear();
          return true;
        }
        return null;
      });
      messenger.setMockMethodCallHandler(channel, (call) async {
        channelCalls.add(call.method);
        switch (call.method) {
          case 'isRunningService':
            return isRunning;
          case 'startService':
            isRunning = true;
            return true;
          case 'stopService':
            isRunning = false;
            return true;
          case 'saveData':
            final args = call.arguments as Map;
            storedData[args['key'] as String] = args['value'];
            return true;
          case 'getData':
            final args = call.arguments as Map;
            return storedData[args['key'] as String];
          default:
            return null;
        }
      });
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        channelCalls.add(call.method);
        switch (call.method) {
          case 'isServiceRunning':
            return isRunning;
          case 'getDurableOwner':
            return storedOwnerJson;
          case 'getWorkerPayload':
            return storedOwnerJson;
          case 'getMonotonicSequence':
            return monotonicSeq;
          case 'atomicStartService':
            final args = call.arguments as Map;
            storedOwnerJson = args['sessionPayloadJson'] as String;
            monotonicSeq = args['lifecycleSeq'] as int;
            isRunning = true;
            return {'success': true, 'active': true, 'sessionId': args['sessionId'], 'lifecycleSeq': monotonicSeq};
          case 'atomicStopService':
            if (failNativeStop) {
              return {'success': false, 'stopped': false, 'error': 'STOP_FAILED'};
            }
            final args = call.arguments as Map;
            if (storedOwnerJson != null) {
              final owner = DurableDutyOwnerRecord.fromJson(storedOwnerJson!);
              if (owner.sessionId == args['expectedSessionId']) {
                storedOwnerJson = null;
                isRunning = false;
                channelCalls.add('stopService');
                return {'success': true, 'stopped': true};
              }
            }
            return {'success': false, 'stopped': false, 'reason': 'ownership_transferred'};
          case 'atomicRemoveOwner':
            storedOwnerJson = null;
            return {'success': true, 'removed': true};
          case 'confirmWorkerBootstrapReadiness':
            return {'success': true, 'granted': true};
          case 'reportWorkerBootstrapFailed':
            return {'success': true, 'cleaned': true};
          default:
            return null;
        }
      });
    });

    tearDown(() {
      messenger.setMockMethodCallHandler(channel, null);
      messenger.setMockMethodCallHandler(prefChannel, null);
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, null);
      NativeOwnershipCoordinator.resetTestSimulation();
    });

    test('M4-EXACT: second durable native read preserves L7 and rejects missing lifecycleSeq', () async {
      final service = DriverLocationService(auth: FakeFirebaseAuth(FakeUser('uid-a')));
      var reads = 0;
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'getDurableOwner') {
          reads++;
          if (reads == 1) {
            return null;
          }
          return jsonEncode({
            'uid': 'uid-a', 'sessionId': 'same-session',
            'generation': 2, 'lifecycleSeq': 7,
            'state': 'ACTIVE', 'startedAt': DateTime.now().toIso8601String(),
          });
        }
        return null;
      });
      expect(await NativeOwnershipCoordinator.getDurableOwner(), isNull);
      final second = await service.getDurableSession();
      expect(reads, 2);
      expect(second?.lifecycleSeq, 7);
      expect(second?.generation, 2);

      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'getDurableOwner') {
          return jsonEncode({
            'uid': 'uid-a', 'sessionId': 'same-session',
            'generation': 2, 'state': 'ACTIVE',
            'startedAt': DateTime.now().toIso8601String(),
          });
        }
        return null;
      });
      await expectLater(service.getDurableSession(), throwsFormatException);
    });

    test('P2-E: Production Dart behavior waits for authoritative outcome and does not interpret intermediate active=false as terminal failure', () async {
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_p2e'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(
        uid: 'driver_p2e',
        sessionId: 'sess_p2e',
        generation: 1,
      );

      // Simulate native returning intermediate pending state (active=false, state=PENDING_START)
      // while Android queues and delivers START
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'atomicStartService') {
          final args = call.arguments as Map;
          storedOwnerJson = jsonEncode({
            'sessionId': args['sessionId'],
            'uid': args['uid'],
            'generation': args['dutyGeneration'],
            'lifecycleSeq': args['lifecycleSeq'],
            'state': 'PENDING_START',
            'startedAt': DateTime.now().toIso8601String(),
          });
          monotonicSeq = args['lifecycleSeq'] as int;
          isRunning = false;
          // Intermediate response before Android activates service
          return {
            'success': true,
            'active': false,
            'state': 'PENDING_START',
            'sessionId': args['sessionId'],
            'lifecycleSeq': monotonicSeq,
          };
        }
        if (call.method == 'isServiceRunning') return isRunning;
        if (call.method == 'getDurableOwner') return storedOwnerJson;
        return null;
      });

      // Service activates asynchronously 50ms later
      Future.delayed(const Duration(milliseconds: 50), () {
        isRunning = true;
        storedOwnerJson = jsonEncode({
          'sessionId': 'sess_p2e',
          'uid': 'driver_p2e',
          'generation': 1,
          'lifecycleSeq': 1,
          'state': 'ACTIVE',
          'startedAt': DateTime.now().toIso8601String(),
        });
      });

      final started = await service.startForegroundService(session: session);
      expect(started, isTrue, reason: 'Dart caller must wait for authoritative outcome and not interpret intermediate active=false as terminal failure');
    });

    test('P2: START-timeout cleanup failure is surfaced and preserves cleanup token for retry', () async {
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_p2_timeout'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(
        uid: 'driver_p2_timeout',
        sessionId: 'sess_p2_timeout',
        generation: 1,
      );

      Map<dynamic, dynamic>? capturedStopArgs;

      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'atomicStartService') {
          final args = call.arguments as Map;
          return {
            'success': true,
            'active': false,
            'state': 'PENDING_START',
            'sessionId': args['sessionId'],
            'lifecycleSeq': args['lifecycleSeq'],
          };
        }
        if (call.method == 'isServiceRunning') return false; // never activates -> triggers timeout
        if (call.method == 'getDurableOwner') return null;
        if (call.method == 'atomicStopService') {
          capturedStopArgs = call.arguments as Map?;
          // First attempt at cleanup fails!
          return {
            'success': false,
            'stopped': false,
            'reason': 'cleanup_commit_failed',
          };
        }
        return null;
      });

      // 1. Must surface actionable failure when cleanup fails
      await expectLater(
        () => service.startForegroundService(session: session),
        throwsA(isA<PlatformException>().having(
          (e) => e.message,
          'message',
          contains('cleanup_commit_failed'),
        )),
      );

      // 2. Retry with only expectedSessionId must use preserved token and succeed
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'atomicStopService') {
          capturedStopArgs = call.arguments as Map?;
          return {'success': true, 'stopped': true};
        }
        return null;
      });

      await service.stopForegroundService(expectedSessionId: 'sess_p2_timeout');
      expect(capturedStopArgs, isNotNull);
      expect(capturedStopArgs?['expectedUid'], equals('driver_p2_timeout'));
      expect(capturedStopArgs?['expectedSessionId'], equals('sess_p2_timeout'));
      expect(capturedStopArgs?['expectedGeneration'], equals(1));
    });

    test('startForegroundService saves serialized payload and session ID', () async {
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_123'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(
        uid: 'driver_123',
        sessionId: 'sess_abc_1',
        generation: 1,
        notificationTitle: 'Towing Service Active',
        notificationText: 'Sharing location with dispatch',
      );

      final started = await service.startForegroundService(
        session: session,
        notificationTitle: session.notificationTitle,
        notificationText: session.notificationText,
      );

      expect(started, isTrue);
      expect(service.currentServiceSession, equals(session));

      final savedOwner = await NativeOwnershipCoordinator.getDurableOwner();
      final savedPayload = await NativeOwnershipCoordinator.getWorkerPayload();

      expect(savedOwner?.sessionId, equals('sess_abc_1'));
      expect(savedPayload, isNotNull);

      final decoded = DutySession.tryDecode(savedPayload!);
      expect(decoded?.sessionId, equals('sess_abc_1'));
      expect(decoded?.notificationTitle, equals('Towing Service Active'));
    });

    test('stopForegroundService with matching session ID stops native service and clears session', () async {
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_123'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(uid: 'driver_123', sessionId: 'sess_match', generation: 1);

      await service.startForegroundService(session: session);
      expect(service.currentServiceSession, isNotNull);

      await service.stopForegroundService(expectedSessionId: 'sess_match');
      expect(service.currentServiceSession, isNull);
      expect(channelCalls, contains('stopService'));
    });

    test('stopForegroundService with mismatched session ID is a NO-OP', () async {
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_123'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(uid: 'driver_123', sessionId: 'sess_active', generation: 1);

      await service.startForegroundService(session: session);
      channelCalls.clear();

      await service.stopForegroundService(expectedSessionId: 'sess_stale_old');
      expect(service.currentServiceSession, equals(session));
      expect(channelCalls, isNot(contains('stopService')));
    });

    test('stopForegroundService with null currentServiceSession does not call native stop', () async {
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_123'));
      final service = DriverLocationService(auth: fakeAuth);
      channelCalls.clear();

      await service.stopForegroundService(expectedSessionId: 'any_session');
      expect(channelCalls, isNot(contains('stopService')));
    });

    test('production service surfaces native stop failure', () async {
      failNativeStop = true;
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_123'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(uid: 'driver_123', sessionId: 'sess_fail', generation: 1);
      await service.startForegroundService(session: session);

      Object? error;
      try {
        await service.stopForegroundService(expectedSessionId: 'sess_fail');
      } catch (e) {
        error = e;
      }
      expect(error, isNotNull);
    });

    test('production service surfaces native stop failure with commit_failed reason', () async {
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_123'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(uid: 'driver_123', sessionId: 'sess_commit_fail', generation: 1);
      await service.startForegroundService(session: session);

      // Override mock to return commit_failed
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'atomicStopService') {
          return {'success': false, 'stopped': false, 'reason': 'commit_failed'};
        }
        return null;
      });

      expect(
        () => service.stopForegroundService(expectedSessionId: 'sess_commit_fail'),
        throwsA(isA<PlatformException>().having(
          (e) => e.message,
          'message',
          contains('commit_failed'),
        )),
      );
    });
  });

  group('Group 3: DriverLocationTaskHandler Isolate Serialization & Session Binding', () {
    test('worker deserializes valid JSON payload onStart and binds permanently to session', () async {
      const session = DutySession(
        uid: 'driver_A',
        sessionId: 'sess_A_1',
        generation: 1,
        notificationTitle: 'Active',
      );
      final jsonPayload = session.encode();
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => jsonPayload,
        authProvider: () => fakeAuth,
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);

      expect(handler.workerSession, isNotNull);
      expect(handler.workerSession?.uid, equals('driver_A'));
      expect(handler.workerSession?.sessionId, equals('sess_A_1'));
      expect(handler.workerSession?.notificationTitle, equals('Active'));
    });

    test('worker onStart fails closed and stops service when payload is missing', () async {
      bool serviceStopped = false;
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => null,
        authProvider: () => fakeAuth,
        serviceStopper: () async {
          serviceStopped = true;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);

      expect(handler.workerSession, isNull);
      expect(serviceStopped, isTrue);
    });

    test('worker onStart fails closed and stops service when payload JSON is corrupt', () async {
      bool serviceStopped = false;
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => '<<< NOT VALID JSON >>>',
        authProvider: () => fakeAuth,
        serviceStopper: () async {
          serviceStopped = true;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);

      expect(handler.workerSession, isNull);
      expect(serviceStopped, isTrue);
    });

    test('worker onStart fails closed when payload missing required fields', () async {
      bool serviceStopped = false;
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => '{"uid": "d1"}',
        authProvider: () => fakeAuth,
        serviceStopper: () async {
          serviceStopped = true;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);

      expect(handler.workerSession, isNull);
      expect(serviceStopped, isTrue);
    });

    test('worker bound to session A never adopts session B', () async {
      const sessionA = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      const sessionB = DutySession(uid: 'driver_B', sessionId: 'sess_B', generation: 2);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => sessionA.encode(),
        authProvider: () => fakeAuth,
      );
      await handler.onStart(DateTime.now(), TaskStarter.developer);

      expect(handler.workerSession?.sessionId, equals('sess_A'));
      expect(handler.workerSession?.uid, equals('driver_A'));

      expect(handler.workerSession, equals(sessionA));
      expect(handler.workerSession, isNot(equals(sessionB)));
    });

    test('worker onDestroy clears workerSession and in-flight flag', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
      );
      await handler.onStart(DateTime.now(), TaskStarter.developer);
      expect(handler.workerSession, isNotNull);

      await handler.onDestroy(DateTime.now(), true);
      expect(handler.workerSession, isNull);
      expect(handler.isHeartbeatInFlight, isFalse);
    });

    test('worker stops and does NOT write heartbeat if auth throws', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'))..throwOnCurrentUser = true;
      final fakeFirestore = FakeFirebaseFirestore();
      bool stopped = false;

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
        locationProvider: () async => Position(
          latitude: 18.5,
          longitude: 73.8,
          timestamp: DateTime.now(),
          altitude: 0,
          altitudeAccuracy: 0,
          accuracy: 5,
          heading: 0,
          headingAccuracy: 0,
          speed: 0,
          speedAccuracy: 0,
        ),
        serviceStopper: () async {
          stopped = true;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);
      await handler.executeHeartbeat(DateTime.now());

      expect(stopped, isTrue);
      expect(fakeFirestore.documents, isEmpty);
    });

    test('P5: worker _stopService and heartbeat propagate cleanup failure, preserve token, and retry succeeds', () async {
      const session = DutySession(
        uid: 'driver_p5',
        sessionId: 'sess_p5',
        generation: 1,
      );
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_p5'));
      final fakeFirestore = FakeFirebaseFirestore();
      fakeFirestore.documents['driver_p5'] = {
        'isOnDuty': false, // Driver is off duty, triggers retirement in executeHeartbeat!
        'verificationStatus': 'approved',
      };

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        durableOwnerLoader: () async => jsonEncode({
          'sessionId': 'sess_p5',
          'uid': 'driver_p5',
          'generation': 1,
          'lifecycleSeq': 1,
          'state': 'ACTIVE',
          'startedAt': DateTime.now().toIso8601String(),
        }),
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);
      expect(handler.isInitialized, isTrue);
      expect(handler.tokenUid, equals('driver_p5'));

      // 1. Injected stop failure on atomicStopService: returns commit_failed
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      int stopCallCount = 0;
      bool stopShouldFail = true;
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'atomicStopService') {
          stopCallCount++;
          if (stopShouldFail) {
            return {'success': false, 'stopped': false, 'reason': 'commit_failed'};
          } else {
            return {'success': true, 'stopped': true};
          }
        }
        return null;
      });

      // 2. Execute heartbeat: driver is off duty -> triggers _stopService()
      // Defective code swallows the error, wipes _workerSession, and considers itself retired!
      Object? heartbeatError;
      try {
        await handler.executeHeartbeat(DateTime.now());
      } catch (e) {
        heartbeatError = e;
      }

      // Check A: Unresolved cleanup must be propagated or reported (not silently swallowed)
      expect(heartbeatError, isNotNull, reason: 'Failed STOP in worker must not be silently swallowed as successful retirement');

      // Check B: Immutable cleanup token must be PRESERVED for retry
      expect(handler.tokenUid, equals('driver_p5'), reason: 'Worker must preserve immutable cleanup token for retry');

      // Check C: Worker must not claim successful retirement
      expect(handler.isInitialized, isTrue, reason: 'Worker must not claim successful retirement when stop failed');

      // 3. Retry cleanup (e.g. next heartbeat or retry stop)
      stopShouldFail = false;
      await handler.executeHeartbeat(DateTime.now());

      // Check D: Retry succeeds, stopService was called again, and worker cleanly retired
      expect(stopCallCount, greaterThanOrEqualTo(2), reason: 'Subsequent heartbeat must retry cleanup with preserved token');
      expect(handler.isInitialized, isFalse, reason: 'Worker successfully retires only after stop succeeds');
    });
  });

  group('Group 4: Single-Flight Heartbeat Concurrency & Fault Tolerance', () {
    test('real single-flight test: heartbeat #1 blocks inside GPS/Firestore, #2 skipped', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final fakeFirestore = FakeFirebaseFirestore();
      fakeFirestore.documents['driver_A'] = {
        'isOnDuty': true,
        'verificationStatus': 'approved',
      };

      final gpsCompleter = Completer<Position>();
      int gpsCallCount = 0;

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
        locationProvider: () {
          gpsCallCount++;
          return gpsCompleter.future;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);

      // Heartbeat 1 starts and blocks waiting on GPS
      final heartbeat1 = handler.executeHeartbeat(DateTime.now());
      await Future<void>.delayed(Duration.zero);
      expect(handler.isHeartbeatInFlight, isTrue);
      expect(gpsCallCount, equals(1));

      // Heartbeat 2 is triggered concurrently while heartbeat 1 is in flight
      final heartbeat2 = handler.executeHeartbeat(DateTime.now());

      // Heartbeat 2 should return immediately without making a GPS call
      await heartbeat2;
      expect(gpsCallCount, equals(1)); // Did NOT enter GPS provider
      expect(handler.isHeartbeatInFlight, isTrue); // Heartbeat 1 is still in flight

      // Unblock GPS for heartbeat 1
      gpsCompleter.complete(Position(
        latitude: 18.5204,
        longitude: 73.8567,
        timestamp: DateTime.now(),
        altitude: 100,
        altitudeAccuracy: 5,
        accuracy: 10,
        heading: 0,
        headingAccuracy: 0,
        speed: 0,
        speedAccuracy: 0,
      ));

      await heartbeat1;

      expect(handler.isHeartbeatInFlight, isFalse);
      expect(fakeFirestore.documents.containsKey('driver_A'), isTrue);
      expect(fakeFirestore.documents['driver_A']['location'], isA<GeoPoint>());
    });

    test('sequential heartbeats: two non-overlapping repeat events both execute', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final fakeFirestore = FakeFirebaseFirestore();
      fakeFirestore.documents['driver_A'] = {
        'isOnDuty': true,
        'verificationStatus': 'approved',
      };
      int heartbeatCount = 0;

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
        locationProvider: () async {
          heartbeatCount++;
          return Position(
            latitude: 18.5 + (heartbeatCount * 0.01),
            longitude: 73.8,
            timestamp: DateTime.now(),
            altitude: 0,
            altitudeAccuracy: 0,
            accuracy: 5,
            heading: 0,
            headingAccuracy: 0,
            speed: 0,
            speedAccuracy: 0,
          );
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);

      await handler.executeHeartbeat(DateTime.now());
      expect(heartbeatCount, equals(1));
      expect(handler.isHeartbeatInFlight, isFalse);

      await handler.executeHeartbeat(DateTime.now());
      expect(heartbeatCount, equals(2));
      expect(handler.isHeartbeatInFlight, isFalse);
    });

    test('heartbeat stops service if auth user becomes null during run', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final fakeFirestore = FakeFirebaseFirestore();
      bool stopped = false;

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
        serviceStopper: () async {
          stopped = true;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);
      // Now user becomes null
      fakeAuth.currentUser = null;
      await handler.executeHeartbeat(DateTime.now());

      expect(stopped, isTrue);
      expect(fakeFirestore.documents, isEmpty);
    });

    test('heartbeat stops service if auth user changes to mismatched UID B', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final fakeFirestore = FakeFirebaseFirestore();
      bool stopped = false;

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
        serviceStopper: () async {
          stopped = true;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);
      // User switches to B
      fakeAuth.currentUser = FakeUser('driver_B');
      await handler.executeHeartbeat(DateTime.now());

      expect(stopped, isTrue);
      expect(fakeFirestore.documents, isEmpty);
    });

    test('GPS failure catches exception, does not write heartbeat, and resets single-flight', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final fakeFirestore = FakeFirebaseFirestore();
      fakeFirestore.documents['driver_A'] = {
        'isOnDuty': true,
        'verificationStatus': 'approved',
      };

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
        locationProvider: () async => throw StateError('GPS timeout'),
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);
      await handler.executeHeartbeat(DateTime.now());

      expect(handler.isHeartbeatInFlight, isFalse);
      expect(fakeFirestore.documents['driver_A'].containsKey('location'), isFalse);
    });

    test('Firestore write failure catches exception and resets single-flight', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
        firestoreProvider: () => throw StateError('Firestore connection lost'),
        locationProvider: () async => Position(
          latitude: 18.5,
          longitude: 73.8,
          timestamp: DateTime.now(),
          altitude: 0,
          altitudeAccuracy: 0,
          accuracy: 5,
          heading: 0,
          headingAccuracy: 0,
          speed: 0,
          speedAccuracy: 0,
        ),
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);
      await handler.executeHeartbeat(DateTime.now());

      expect(handler.isHeartbeatInFlight, isFalse);
    });

    test('heartbeat skips write when GPS returns invalid coordinates', () async {
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_A', generation: 1);
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final fakeFirestore = FakeFirebaseFirestore();
      fakeFirestore.documents['driver_A'] = {
        'isOnDuty': true,
        'verificationStatus': 'approved',
      };

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
        locationProvider: () async => Position(
          latitude: 95.0,
          longitude: 73.8,
          timestamp: DateTime.now(),
          altitude: 0,
          altitudeAccuracy: 0,
          accuracy: 5,
          heading: 0,
          headingAccuracy: 0,
          speed: 0,
          speedAccuracy: 0,
        ),
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);
      await handler.executeHeartbeat(DateTime.now());

      expect(fakeFirestore.documents['driver_A'].containsKey('location'), isFalse);
      expect(handler.isHeartbeatInFlight, isFalse);
    });
  });

  group('Group 5: Permissions & Native Channels', () {
    test('background permission rejects native whileInUse', () async {
      const channel = MethodChannel('flutter.baseflow.com/geolocator');
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async => call.method == 'isLocationServiceEnabled' ? true : 2);
      final actual = await DriverLocationService().requestBackgroundPermission();
      messenger.setMockMethodCallHandler(channel, null);
      expect(actual, isNot(LocationPermissionStatus.granted));
    });

    test('foreground permission deniedForever mapped correctly', () async {
      const channel = MethodChannel('flutter.baseflow.com/geolocator');
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'isLocationServiceEnabled') return true;
        if (call.method == 'requestPermission') return 1;
        return 1;
      });
      final actual = await DriverLocationService().requestForegroundPermission();
      messenger.setMockMethodCallHandler(channel, null);
      expect(actual, equals(LocationPermissionStatus.deniedForever));
    });

    test('isLocationServiceEnabled surfaces native channel boolean', () async {
      const channel = MethodChannel('flutter.baseflow.com/geolocator');
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async => false);
      final enabled = await DriverLocationService().isLocationServiceEnabled();
      messenger.setMockMethodCallHandler(channel, null);
      expect(enabled, isFalse);
    });
  });

  group('Group 6: Pass 4 Final Ownership & Isolation Invariants', () {
    const channel = MethodChannel('flutter_foreground_task/methods');
    const prefChannel = MethodChannel('plugins.flutter.io/shared_preferences');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final Map<String, dynamic> storedData = {};
    final Map<String, Object> prefData = {};
    final List<String> channelCalls = [];
    bool isRunning = false;

    setUp(() {
      isRunning = false;
      storedData.clear();
      prefData.clear();
      channelCalls.clear();

      messenger.setMockMethodCallHandler(prefChannel, (call) async {
        if (call.method == 'getAll') return prefData;
        if (call.method == 'setString') {
          prefData[call.arguments['key'] as String] = call.arguments['value'] as String;
          return true;
        }
        if (call.method == 'setInt') {
          prefData[call.arguments['key'] as String] = call.arguments['value'] as int;
          return true;
        }
        if (call.method == 'setBool') {
          prefData[call.arguments['key'] as String] = call.arguments['value'] as bool;
          return true;
        }
        if (call.method == 'remove') {
          prefData.remove(call.arguments['key'] as String);
          return true;
        }
        if (call.method == 'clear') {
          prefData.clear();
          return true;
        }
        return null;
      });

      messenger.setMockMethodCallHandler(channel, (call) async {
        channelCalls.add(call.method);
        switch (call.method) {
          case 'isRunningService':
            return isRunning;
          case 'startService':
            isRunning = true;
            return true;
          case 'stopService':
            isRunning = false;
            return true;
          case 'saveData':
            final args = call.arguments as Map;
            storedData[args['key'] as String] = args['value'];
            return true;
          case 'getData':
            final args = call.arguments as Map;
            return storedData[args['key'] as String];
          default:
            return null;
        }
      });
      NativeOwnershipCoordinator.useTestSimulation = true;
    });

    tearDown(() {
      messenger.setMockMethodCallHandler(channel, null);
      messenger.setMockMethodCallHandler(prefChannel, null);
      NativeOwnershipCoordinator.resetTestSimulation();
    });

    test('Cross-instance stop isolation: instance B cannot stop instance A session', () async {
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final serviceA = DriverLocationService(auth: fakeAuth);
      final serviceB = DriverLocationService(auth: fakeAuth);

      const sessionA = DutySession(uid: 'driver_A', sessionId: 'sess_A_99', generation: 1);
      final started = await serviceA.startForegroundService(session: sessionA);
      expect(started, isTrue);
      expect(serviceA.currentServiceSession, equals(sessionA));

      channelCalls.clear();
      // Instance B attempts to stop with mismatched session ID
      await serviceB.stopForegroundService(expectedSessionId: 'sess_B_mismatch');

      // Native stopService MUST NOT be called, and durable session must be preserved
      expect(channelCalls, isNot(contains('stopService')));
      final durable = await serviceA.getDurableSession();
      expect(durable?.sessionId, equals('sess_A_99'));
    });

    test('P2-C: Stale S1 cleanup cannot borrow S2 token when session ID is reused, preserving active S2', () async {
      DriverLocationService.resetPendingCleanupTokensForTesting();
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_p2c'));
      final service = DriverLocationService(auth: fakeAuth);

      // 1. S1 starts but readback fails because isRunning is false
      // S1 cleanup is attempted in startForegroundService, but atomicStopService returns false
      // This leaves S1's cleanup token in _pendingCleanupTokens
      NativeOwnershipCoordinator.simulatedCommitFailure = (op) => op == 'stop_removal';
      NativeOwnershipCoordinator.testHook = (action) async {
        if (action == 'before_get_owner') {
          NativeOwnershipCoordinator.simulatedIsRunningService = false;
        }
      };
      const sessionS1 = DutySession(uid: 'driver_p2c', sessionId: 'sess_reused', generation: 1);
      try {
        await service.startForegroundService(session: sessionS1);
        fail('Expected startForegroundService to fail for S1');
      } catch (e) {
        expect(e, isA<PlatformException>());
        expect((e as PlatformException).code, equals('STARTUP_CLEANUP_FAILED'));
      }
      expect(service.currentServiceSession, isNull);
      final s1Seq = await NativeOwnershipCoordinator.getMonotonicSequence();

      // 2. Now S2 starts successfully with the SAME sessionId 'sess_reused' but generation 2
      NativeOwnershipCoordinator.testHook = null;
      NativeOwnershipCoordinator.simulatedCommitFailure = null;
      NativeOwnershipCoordinator.simulatedIsRunningService = true;
      const sessionS2 = DutySession(uid: 'driver_p2c', sessionId: 'sess_reused', generation: 2);
      final s2Started = await service.startForegroundService(session: sessionS2);
      expect(s2Started, isTrue);
      expect(service.currentServiceSession, equals(sessionS2));
      final s2Seq = await NativeOwnershipCoordinator.getMonotonicSequence();
      expect(s2Seq, greaterThan(s1Seq));

      // 3. Stale S1 cleanup is retried: native coordinator sees generation_mismatch (S2 is active with gen 2)
      // S1 cleanup throws PlatformException, and S2 must remain active!
      await expectLater(
        service.stopForegroundService(
          expectedUid: 'driver_p2c',
          expectedSessionId: 'sess_reused',
          expectedGeneration: 1,
        ),
        throwsA(isA<PlatformException>()),
      );
      expect(service.currentServiceSession, equals(sessionS2), reason: 'Failed S1 cleanup must not clear active S2 session');

      // 4. Stale S1 cleanup is retried while atomicStopService throws an RPC error
      NativeOwnershipCoordinator.simulatedNativeStopException = () => StateError('Simulated RPC stop error');
      await expectLater(
        service.stopForegroundService(
          expectedUid: 'driver_p2c',
          expectedSessionId: 'sess_reused',
          expectedGeneration: 1,
        ),
        throwsA(isA<PlatformException>()),
      );
      expect(service.currentServiceSession, equals(sessionS2), reason: 'Throwing S1 cleanup must not clear active S2 session');
      NativeOwnershipCoordinator.simulatedNativeStopException = null;

      // 5. If S1 cleanup succeeds natively, S2 still remains active and untouched!
      // Temporarily mock channel to return success for S1 stop
      NativeOwnershipCoordinator.useTestSimulation = false;
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'atomicStopService') {
          final args = call.arguments as Map;
          expect(args['expectedGeneration'], equals(1), reason: 'S1 cleanup must send only S1 token, never S2 generation');
          expect(args['expectedLifecycleSeq'], equals(s1Seq), reason: 'S1 cleanup must send only S1 sequence, never S2 sequence');
          return {'success': true, 'stopped': true};
        }
        return null;
      });

      await service.stopForegroundService(
        expectedUid: 'driver_p2c',
        expectedSessionId: 'sess_reused',
        expectedGeneration: 1,
      );
      expect(service.currentServiceSession, equals(sessionS2), reason: 'Successful S1 cleanup must not clear active S2 session');

      // 6. Further cleanup attempt for S1 no longer has a token and must not touch S2
      int stopCallCount = 0;
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (call) async {
        if (call.method == 'atomicStopService') {
          stopCallCount++;
          return {'success': true, 'stopped': true};
        }
        return null;
      });
      await service.stopForegroundService(
        expectedUid: 'driver_p2c',
        expectedSessionId: 'sess_reused',
        expectedGeneration: 1,
      );
      expect(stopCallCount, equals(0), reason: 'Consumed S1 token must not borrow S2 sequence or make native stop calls');
      expect(service.currentServiceSession, equals(sessionS2));

      NativeOwnershipCoordinator.useTestSimulation = true;
    });

    test('Failed payload persistence aborts native start with zero native calls', () async {
      NativeOwnershipCoordinator.simulatedCommitFailure = (op) => op == 'start_payload';

      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final service = DriverLocationService(auth: fakeAuth);
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_fail_persist', generation: 1);

      channelCalls.clear();
      final started = await service.startForegroundService(session: session);

      expect(started, isFalse);
      expect(channelCalls, isNot(contains('startService')));
      expect(service.currentServiceSession, isNull);
    });

    test('Worker onStart rejects stale payload mismatched against current durable owner', () async {
      bool serviceStopped = false;
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      const sessionStale = DutySession(uid: 'driver_A', sessionId: 'sess_stale', generation: 1);
      const sessionCurrent = DutySession(uid: 'driver_A', sessionId: 'sess_current', generation: 2);

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => sessionStale.encode(),
        durableOwnerLoader: () async => sessionCurrent.encode(),
        authProvider: () => fakeAuth,
        serviceStopper: () async {
          serviceStopped = true;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);

      expect(handler.workerSession, isNull);
      expect(handler.isInitialized, isFalse);
      expect(serviceStopped, isTrue);
    });

    test('Worker retires on Firebase initialization failure with zero writes', () async {
      bool serviceStopped = false;
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_A'));
      final fakeFirestore = FakeFirebaseFirestore();
      const session = DutySession(uid: 'driver_A', sessionId: 'sess_init_fail', generation: 1);

      final handler = DriverLocationTaskHandler(
        payloadLoader: () async => session.encode(),
        firebaseInitializer: () async {
          throw StateError('Firebase initialization failed');
        },
        authProvider: () => fakeAuth,
        firestoreProvider: () => fakeFirestore,
        serviceStopper: () async {
          serviceStopped = true;
        },
      );

      await handler.onStart(DateTime.now(), TaskStarter.developer);

      expect(handler.workerSession, isNull);
      expect(handler.isInitialized, isFalse);
      expect(serviceStopped, isTrue);

      // Repeat tick callback must be inert and make 0 writes
      await handler.executeHeartbeat(DateTime.now());
      expect(fakeFirestore.documents.isEmpty, isTrue);
    });

    test('Strict activeJobId in executeGoOffDutyTransaction: null proceeds, canonical throws StateError, malformed throws FormatException', () async {
      final fakeFirestore = FakeFirebaseFirestore();
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_test'));
      final service = DriverLocationService(
        firestore: fakeFirestore,
        auth: fakeAuth,
      );

      // Case 1: activeJobId is null -> proceeds successfully
      fakeFirestore.documents['driver_test'] = {
        'uid': 'driver_test',
        'isOnDuty': true,
        'activeJobId': null,
      };
      await service.executeGoOffDutyTransaction(uid: 'driver_test');
      expect(fakeFirestore.documents['driver_test']['isOnDuty'], isFalse);

      // Case 2: activeJobId is canonical non-empty String -> throws StateError
      fakeFirestore.documents['driver_test'] = {
        'uid': 'driver_test',
        'isOnDuty': true,
        'activeJobId': 'job_active_123',
      };
      expect(
        () => service.executeGoOffDutyTransaction(uid: 'driver_test'),
        throwsStateError,
      );

      // Case 3: activeJobId is empty string -> throws FormatException
      fakeFirestore.documents['driver_test'] = {
        'uid': 'driver_test',
        'isOnDuty': true,
        'activeJobId': '',
      };
      expect(
        () => service.executeGoOffDutyTransaction(uid: 'driver_test'),
        throwsFormatException,
      );

      // Case 4: activeJobId is whitespace-only string -> throws FormatException
      fakeFirestore.documents['driver_test'] = {
        'uid': 'driver_test',
        'isOnDuty': true,
        'activeJobId': '   ',
      };
      expect(
        () => service.executeGoOffDutyTransaction(uid: 'driver_test'),
        throwsFormatException,
      );

      // Case 5: activeJobId is whitespace-padded string -> throws FormatException
      fakeFirestore.documents['driver_test'] = {
        'uid': 'driver_test',
        'isOnDuty': true,
        'activeJobId': ' job_123 ',
      };
      expect(
        () => service.executeGoOffDutyTransaction(uid: 'driver_test'),
        throwsFormatException,
      );

      // Case 6: activeJobId is non-String (int, bool, map) -> throws FormatException
      fakeFirestore.documents['driver_test'] = {
        'uid': 'driver_test',
        'isOnDuty': true,
        'activeJobId': 12345,
      };
      expect(
        () => service.executeGoOffDutyTransaction(uid: 'driver_test'),
        throwsFormatException,
      );

      fakeFirestore.documents['driver_test'] = {
        'uid': 'driver_test',
        'isOnDuty': true,
        'activeJobId': true,
      };
      expect(
        () => service.executeGoOffDutyTransaction(uid: 'driver_test'),
        throwsFormatException,
      );
    });

    test('M2-R2-5: DriverLocationService startDutySessionCall throws StateError if lifecycleSeq is null or <= 0', () async {
      final fakeFirestore = FakeFirebaseFirestore();
      final fakeAuth = FakeFirebaseAuth(FakeUser('driver_test'));
      final service = DriverLocationService(
        firestore: fakeFirestore,
        auth: fakeAuth,
      );

      final dummyPos = DriverPosition(
        latitude: 18.5204,
        longitude: 73.8567,
        timestamp: DateTime.now(),
      );

      // Null lifecycleSeq with no active service session
      expect(
        () => service.startDutySessionCall(
          uid: 'driver_test',
          sessionId: 'sess_1',
          initialLocation: dummyPos,
          lifecycleSeq: null,
        ),
        throwsStateError,
      );

      // Zero lifecycleSeq
      expect(
        () => service.startDutySessionCall(
          uid: 'driver_test',
          sessionId: 'sess_1',
          initialLocation: dummyPos,
          lifecycleSeq: 0,
        ),
        throwsStateError,
      );

      // Negative lifecycleSeq
      expect(
        () => service.startDutySessionCall(
          uid: 'driver_test',
          sessionId: 'sess_1',
          initialLocation: dummyPos,
          lifecycleSeq: -1,
        ),
        throwsStateError,
      );
    });
  });
}
