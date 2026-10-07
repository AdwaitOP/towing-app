import 'dart:async';
import 'dart:ui' as ui;
import 'package:firebase_auth/firebase_auth.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:driver_app/features/hub/models/hub_error_category.dart';
import 'package:driver_app/features/hub/screens/dispatch_hub_screen.dart';
import 'package:driver_app/features/hub/widgets/battery_optimization_card.dart';
import 'package:driver_app/features/hub/widgets/driver_map_view.dart';
import 'package:driver_app/features/hub/widgets/duty_toggle_button.dart';
import 'package:driver_app/features/hub/widgets/temporary_ban_banner.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helper.dart';
import '../unit/duty_controller_test.dart' as f;

class MockAuthService extends AuthService {
  bool signOutCalled = false;
  final StreamController<User?> _authStateController =
      StreamController<User?>.broadcast();

  @override
  User? get currentUser => null;

  @override
  Stream<User?> get authStateChanges => _authStateController.stream;

  @override
  Future<void> signOut() async {
    signOutCalled = true;
  }
}

class FakeLocationService implements LocationService {
  final StreamController<DriverPosition> _controller =
      StreamController<DriverPosition>.broadcast();
  DutySession? currentSession;
  bool serviceEnabled = true;

  @override
  DutySession? get currentServiceSession => currentSession;
  @override
  int? get currentLifecycleSeq => null;
  @override
  int? get currentGeneration => null;
  @override
  Future<DutySession?> getDurableSession() async => currentSession;
  @override
  Future<DurableDutyOwnerRecord?> getDurableOwnerRecord() async {
    final s = currentSession;
    if (s == null) return null;
    return DurableDutyOwnerRecord(
      sessionId: s.sessionId,
      uid: s.uid,
      generation: s.generation,
      lifecycleSeq: 1,
      startedAt: DateTime.now(),
    );
  }
  @override
  Future<bool> isForegroundServiceRunning() async => currentSession != null;
  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;
  @override
  Future<LocationPermissionStatus> checkPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestForegroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestBackgroundPermission() async => LocationPermissionStatus.granted;
  @override
  Future<LocationPermissionStatus> requestNotificationPermission() async => LocationPermissionStatus.granted;
  @override
  Future<bool> hasRequiredPermissions() async => true;
  @override
  Future<DriverPosition?> getCurrentPosition() async => null;
  @override
  Stream<DriverPosition> getPositionStream() => _controller.stream;
  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    onAuthorityAllocated?.call(session);
    currentSession = session;
    return true;
  }
  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    currentSession = null;
  }
  @override
  DriverPosition? get lastKnownPosition => null;
  @override
  Future<Map<String, dynamic>?> fetchServerDriverState(String uid) async => null;
  @override
  Future<void> sendHeartbeat({required String uid, required DriverPosition position}) async {}
  @override
  Future<void> executeGoOnDutyTransaction({required String uid}) async {}
  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {}
  @override
  Future<DutyActivationPreparation> prepareDutyActivation({required String uid, String? clientRequestId}) async =>
      DutyActivationPreparation(sessionId: '${uid}_${DateTime.now().microsecondsSinceEpoch}', generation: 1);
  @override
  Future<Map<String, dynamic>> startDutySessionCall({
    required String uid,
    required String sessionId,
    required DriverPosition initialLocation,
    int? lifecycleSeq,
    int? generation,
    int? attemptSeq,
  }) async =>
      {'status': 'activated', 'dutyGeneration': generation ?? 1, 'lifecycleSeq': lifecycleSeq ?? 1, 'workerReady': true};
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
  }) async {}
  @override
  Future<void> reportHeartbeatCall({
    required String uid,
    required String sessionId,
    required DriverPosition position,
    int? generation,
    int? lifecycleSeq,
  }) async {}
  @override
  Future<Map<String, dynamic>> recoverActiveJobSessionCall({
    required String uid,
    required String activeDutySessionId,
    required int dutyGeneration,
    required int lifecycleSeq,
    required String expectedActiveJobId,
    String? clientRequestId,
    DriverPosition? initialLocation,
  }) async =>
      {
        'sessionId': '${uid}_recovered',
        'dutyGeneration': 1,
        'workerReady': false,
        'lifecycleSeq': null,
        'activeJobId': expectedActiveJobId,
        'status': 'recovered',
      };
  @override
  Future<bool> openAppSettings() async => true;
  @override
  void dispose() {
    _controller.close();
  }
}

class FakeDutyController extends DutyController {
  bool onDutyRequested = false;
  bool offDutyRequested = false;
  HubErrorCategory? forcedError;
  AuthoritativeDutyState? forcedAuthoritative;

  FakeDutyController()
      : super(
          locationService: FakeLocationService(),
          authService: MockAuthService(),
        );

  @override
  HubErrorCategory? get errorCategory => forcedError;

  @override
  AuthoritativeDutyState get authoritativeDutyState =>
      forcedAuthoritative ?? super.authoritativeDutyState;

  @override
  bool get isOnDuty =>
      (forcedAuthoritative ?? super.authoritativeDutyState) ==
      AuthoritativeDutyState.onDuty;

  @override
  bool get canToggleDuty =>
      forcedAuthoritative != null ? true : super.canToggleDuty;

  @override
  Future<bool> requestGoOnDuty({
    required Future<bool> Function() onShowDisclosure,
    String? notificationTitle,
    String? notificationText,
    String? locale,
  }) async {
    onDutyRequested = true;
    return true;
  }

  @override
  Future<bool> requestGoOffDuty() async {
    offDutyRequested = true;
    return true;
  }
}

void main() {
  group('DispatchHubScreen Widget Tests', () {
    const approvedProfile = DriverProfile(
      uid: 'driver_test_999',
      name: 'Sunil Gavaskar',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH 12 AB 1234',
      verificationStatus: 'approved',
      isOnDuty: false,
    );

    testWidgets('renders all core UI elements on load', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: approvedProfile,
            authService: MockAuthService(),
            locationService: FakeLocationService(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Dispatch Hub'), findsOneWidget);
      expect(find.byKey(const ValueKey('duty_status_card')), findsOneWidget);
      expect(find.byKey(const ValueKey('duty_toggle_button')), findsOneWidget);
      expect(find.byKey(const ValueKey('driver_summary_card')), findsOneWidget);
      expect(find.byType(BatteryOptimizationCard), findsOneWidget);
      expect(find.text('Sunil Gavaskar'), findsOneWidget);
      expect(find.text('MH 12 AB 1234 • Flatbed Tow Truck'), findsOneWidget);
    });

    testWidgets('tapping duty toggle when OFF triggers requestGoOnDuty', (tester) async {
      final fakeController = FakeDutyController();
      fakeController.updateProfile(approvedProfile);

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: approvedProfile,
            authService: MockAuthService(),
            locationService: FakeLocationService(),
            controller: fakeController,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('duty_toggle_button')));
      await tester.pump();

      expect(fakeController.onDutyRequested, isTrue);
    });

    testWidgets('tapping duty toggle when ON triggers requestGoOffDuty', (tester) async {
      final fakeController = FakeDutyController();
      fakeController.forcedAuthoritative = AuthoritativeDutyState.onDuty;
      final onDutyProfile = approvedProfile.copyWith(isOnDuty: true);
      fakeController.updateProfile(onDutyProfile);

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: onDutyProfile,
            authService: MockAuthService(),
            locationService: FakeLocationService(),
            controller: fakeController,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('duty_toggle_button')));
      await tester.pump();

      expect(fakeController.offDutyRequested, isTrue);
    });

    testWidgets('renders temporary ban banner when driver is banned', (tester) async {
      final futureDate = DateTime.utc(2026, 9, 14, 18, 0, 0);
      final bannedProfile = approvedProfile.copyWith(bannedUntil: futureDate);

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: bannedProfile,
            authService: MockAuthService(),
            locationService: FakeLocationService(),
            clock: () => DateTime.utc(2026, 9, 14, 12, 0, 0),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(TemporaryBanBanner), findsOneWidget);
    });

    testWidgets('error card renders localized message and settings button when denied', (tester) async {
      final fakeController = FakeDutyController();
      fakeController.updateProfile(approvedProfile);
      fakeController.forcedError = HubErrorCategory.foregroundPermissionDeniedForever;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: approvedProfile,
            authService: MockAuthService(),
            locationService: FakeLocationService(),
            controller: fakeController,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('hub_error_card')), findsOneWidget);
      expect(find.text('Open Settings'), findsOneWidget);
    });
  });

  group('Astra Widget Audit Probes', () {
    final raw = <String, dynamic>{
      'uid': 'A',
      'name': 'Audit Driver',
      'phone': '+919876543210',
      'truckType': 'flatbed',
      'vehicleNumber': 'MH12AB1234',
      'isOnDuty': false,
      'verificationStatus': 'approved',
      'activeJobId': null,
    };
    final approved = DriverProfile.fromMap(raw, 'A');

    Future<bool> go(DutyController c) => c.requestGoOnDuty(onShowDisclosure: () async => true);

    testWidgets('AUDIT OFF hub acquires no location before disclosure', (t) async {
      final a = f.TestAuthService(f.FakeUser('A'));
      final io = _AuditIO();
      await t.pumpWidget(createTestWidget(child: DispatchHubScreen(profile: approved, authService: a, locationService: io)));
      await t.pumpAndSettle();
      final observed = [io.reads, io.streams];
      await t.pumpWidget(const SizedBox());
      a.dispose();
      expect(observed, [0, 0]);
    });

    testWidgets('AUDIT live approval loss during startup cancels ON', (t) async {
      final a = f.TestAuthService(f.FakeUser('A'));
      final io = _AuditIO('gps');
      final c = DutyController(locationService: io, authService: a);
      c.updateProfile(approved);

      Widget hub(DriverProfile p) => createTestWidget(child: DispatchHubScreen(profile: p, authService: a, locationService: io, controller: c));
      await t.pumpWidget(hub(approved));
      await t.pump();
      final pending = go(c);
      await t.pump();
      c.updateProfile(approved.copyWith(verificationStatus: 'pending'));
      await t.pumpWidget(hub(approved.copyWith(verificationStatus: 'pending')));
      io.release.complete();
      await t.pump();
      final result = await pending;
      await t.pumpWidget(const SizedBox());
      c.dispose();
      a.dispose();
      expect(result, false);
    });

    testWidgets('AUDIT active job arrives during OFF cancels stale OFF', (t) async {
      final a = f.TestAuthService(f.FakeUser('A'));
      final io = _AuditIO('off');
      final c = DutyController(locationService: io, authService: a);
      final on = approved.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_audit_off',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        workerReady: true,
      );
      io.fixtureFreshProfile = on;
      io.serviceRunning = true;
      io.durableOwnerRecord = DurableDutyOwnerRecord(
        uid: 'A',
        sessionId: 'sess_audit_off',
        generation: 1,
        lifecycleSeq: 1,
        startedAt: DateTime.now(),
      );
      c.updateProfile(on);

      Widget hub(DriverProfile p) => createTestWidget(child: DispatchHubScreen(profile: p, authService: a, locationService: io, controller: c));
      await t.pumpWidget(hub(on));
      await t.pumpAndSettle();
      final pending = c.requestGoOffDuty();
      await t.pump();
      c.updateProfile(on.copyWith(activeJobId: 'job-1'));
      await t.pumpWidget(hub(on.copyWith(activeJobId: 'job-1')));
      io.release.complete();
      await t.pump();
      final result = await pending;
      await t.pumpWidget(const SizedBox());
      c.dispose();
      a.dispose();
      expect(result, false);
    });

    testWidgets('AUDIT resume reconciles revoked permission', (t) async {
      final a = f.TestAuthService(f.FakeUser('A'));
      final io = _AuditIO();
      final c = DutyController(locationService: io, authService: a);
      final onProfile = approved.copyWith(
        isOnDuty: true,
        activeDutySessionId: 'sess_audit_resume',
        dutyGeneration: 1,
        lifecycleSeq: 1,
      );
      io.fixtureFreshProfile = onProfile;
      c.updateProfile(onProfile);

      await t.pumpWidget(createTestWidget(child: DispatchHubScreen(profile: onProfile, authService: a, locationService: io, controller: c)));
      await t.pumpAndSettle();
      io.checkPermResult = LocationPermissionStatus.deniedForever;
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      final corrected = io.dutyWrites.contains(false);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      a.dispose();
      expect(corrected, true);
    });

    for (final locale in ['en', 'hi', 'mr']) {
      testWidgets('AUDIT $locale 360px fallback touch target live ban', (t) async {
        t.view.physicalSize = const Size(360, 800);
        t.view.devicePixelRatio = 1;
        addTearDown(t.view.resetPhysicalSize);
        addTearDown(t.view.resetDevicePixelRatio);
        final a = f.TestAuthService(f.FakeUser('A'));
        final io = _AuditIO();
        final c = DutyController(locationService: io, authService: a);
        final now = DateTime.utc(2026, 9, 13);
        c.updateProfile(approved);

        Widget hub(DriverProfile p) => createTestWidget(
          locale: Locale(locale),
          child: DispatchHubScreen(
            profile: p,
            authService: a,
            locationService: io,
            controller: c,
            onLocaleChanged: (_) {},
            clock: () => now,
          ),
        );

        await t.pumpWidget(hub(approved));
        await t.pumpAndSettle();
        expect(find.byKey(const ValueKey('map_fallback_container')), findsOneWidget);
        expect(t.getSize(find.byType(DutyToggleButton)).height, greaterThanOrEqualTo(48));

        c.updateProfile(approved.copyWith(bannedUntil: now.add(const Duration(hours: 1))));
        await t.pumpWidget(hub(approved.copyWith(bannedUntil: now.add(const Duration(hours: 1)))));
        await t.pumpAndSettle();
        expect(find.byType(TemporaryBanBanner), findsOneWidget);

        expect(await c.requestGoOnDuty(onShowDisclosure: () async => true), true);
        await t.pumpAndSettle();

        c.updateProfile(approved);
        await t.pumpWidget(hub(approved));
        await t.pumpAndSettle();
        expect(find.byType(TemporaryBanBanner), findsNothing);

        await t.pumpWidget(const SizedBox());
        c.dispose();
        a.dispose();
      });
    }
  });

  group('Section 19: Required UI Tests', () {
    test('valid/decodeable runtime marker PNG', () async {
      final bytes = await createDriverMarkerPng(size: 48);
      expect(bytes, isNotEmpty);
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      expect(frame.image.width, 48);
      expect(frame.image.height, 48);
    });

    testWidgets('reconciliation failed shows degraded state and does NOT say AVAILABLE', (tester) async {
      final auth = MockAuthService();
      final loc = FakeLocationService();
      final controller = DutyController(locationService: loc, authService: auth);

      const onProfile = DriverProfile(
        uid: 'driver_test_999',
        name: 'Sunil Gavaskar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: true,
      );
      controller.updateProfile(onProfile);

      // Simulate reconciliation failure while isOnDuty remains true in Firestore
      loc.serviceEnabled = false;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: onProfile,
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Must NOT display healthy AVAILABLE text
      expect(find.text('You are ON DUTY and available for towing requests.'), findsNothing);
      expect(find.text('Duty status needs attention — live location unavailable'), findsOneWidget);

      controller.dispose();
    });

    testWidgets('background permission denied exposes settings recovery button', (tester) async {
      final auth = MockAuthService();
      final loc = FakeLocationService();
      final controller = FakeDutyController();
      controller.forcedError = HubErrorCategory.backgroundPermissionDenied;

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: const DriverProfile(
              uid: 'driver_test_999',
              name: 'Sunil Gavaskar',
              phone: '+919876543210',
              truckType: TruckType.flatbed,
              vehicleNumber: 'MH 12 AB 1234',
              verificationStatus: 'approved',
              isOnDuty: false,
            ),
            authService: auth,
            locationService: loc,
            controller: controller,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('hub_open_settings_button')), findsOneWidget);
    });

    for (final loc in ['en', 'hi', 'mr']) {
      testWidgets('$loc 360x800 ON DUTY fallback renders without RenderFlex overflow', (tester) async {
        tester.view.physicalSize = const Size(360, 800);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);

        final auth = MockAuthService();
        final locService = FakeLocationService();

        const onProfile = DriverProfile(
          uid: 'driver_test_999',
          name: 'Sunil Gavaskar',
          phone: '+919876543210',
          truckType: TruckType.flatbed,
          vehicleNumber: 'MH 12 AB 1234',
          verificationStatus: 'approved',
          isOnDuty: true,
        );

        await tester.pumpWidget(
          createTestWidget(
            locale: Locale(loc),
            child: DispatchHubScreen(
              profile: onProfile,
              authService: auth,
              locationService: locService,
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('map_fallback_container')), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('AuthoritativeDutyState.unknown renders attention required card', (tester) async {
      const profile = DriverProfile(
        uid: 'driver_test_999',
        name: 'Sunil Gavaskar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: false,
      );
      final fakeController = FakeDutyController();
      fakeController.forcedAuthoritative = AuthoritativeDutyState.unknown;
      final auth = MockAuthService();
      final locService = FakeLocationService();

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: profile,
            authService: auth,
            locationService: locService,
            controller: fakeController,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('duty_status_card')), findsOneWidget);
      expect(find.textContaining('Duty status needs attention'), findsWidgets);
    });

    testWidgets('DriverMapView handles rapid position updates sequentially without exceptions', (tester) async {
      final pos1 = DriverPosition(latitude: 18.5204, longitude: 73.8567, timestamp: DateTime.utc(2026));
      final pos2 = DriverPosition(latitude: 18.5210, longitude: 73.8570, timestamp: DateTime.utc(2026));
      final pos3 = DriverPosition(latitude: 18.5220, longitude: 73.8580, timestamp: DateTime.utc(2026));

      await tester.pumpWidget(
        createTestWidget(
          child: DriverMapView(
            currentPosition: pos1,
            accessToken: '',
          ),
        ),
      );
      await tester.pump();

      await tester.pumpWidget(
        createTestWidget(
          child: DriverMapView(
            currentPosition: pos2,
            accessToken: '',
          ),
        ),
      );
      await tester.pump();

      await tester.pumpWidget(
        createTestWidget(
          child: DriverMapView(
            currentPosition: pos3,
            accessToken: '',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });
  });
}

class _AuditIO extends f.TestLocationService {
  final String? pause;
  final reached = Completer<void>(), release = Completer<void>();
  int starts = 0, loops = 0, reads = 0, streams = 0;

  _AuditIO([this.pause]) {
    currentPos = DriverPosition(latitude: 18, longitude: 73, timestamp: DateTime.utc(2026));
  }

  Future<void> gate(String s) async {
    operationLog.add(s);
    if (pause == s) {
      if (!reached.isCompleted) reached.complete();
      await release.future;
    }
  }

  @override
  Future<LocationPermissionStatus> checkPermission() async {
    await gate('permission');
    return checkPermResult;
  }

  @override
  Future<DriverPosition?> getCurrentPosition() async {
    reads++;
    await gate('gps');
    return currentPos;
  }

  @override
  Stream<DriverPosition> getPositionStream() {
    streams++;
    return const Stream.empty();
  }

  @override
  Future<void> sendHeartbeat({required String uid, required DriverPosition position}) async {
    await gate('heartbeat');
    await super.sendHeartbeat(uid: uid, position: position);
  }

  @override
  Future<bool> startForegroundService({
    required DutySession session,
    String? notificationTitle,
    String? notificationText,
    void Function(DutySession authority)? onAuthorityAllocated,
  }) async {
    starts++;
    await gate('start');
    return super.startForegroundService(
      session: session,
      notificationTitle: notificationTitle,
      notificationText: notificationText,
      onAuthorityAllocated: onAuthorityAllocated,
    );
  }

  @override
  Future<void> stopForegroundService({
    String? expectedUid,
    required String expectedSessionId,
    int? expectedLifecycleSeq,
    int? expectedGeneration,
  }) async {
    await gate('stop');
    await super.stopForegroundService(
      expectedUid: expectedUid,
      expectedSessionId: expectedSessionId,
      expectedLifecycleSeq: expectedLifecycleSeq,
      expectedGeneration: expectedGeneration,
    );
  }

  @override
  Future<void> executeGoOnDutyTransaction({required String uid}) async {
    await gate('on');
    await super.executeGoOnDutyTransaction(uid: uid);
  }

  @override
  Future<void> executeGoOffDutyTransaction({required String uid}) async {
    await gate('off');
    await super.executeGoOffDutyTransaction(uid: uid);
  }
}
