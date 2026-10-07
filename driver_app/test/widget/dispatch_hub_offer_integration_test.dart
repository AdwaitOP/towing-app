// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/job_offer.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/offer_service.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:driver_app/features/hub/screens/dispatch_hub_screen.dart';
import 'package:driver_app/features/hub/widgets/incoming_offer_sheet.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'test_helper.dart';

class FakeUser implements User {
  @override
  final String uid;
  @override
  final String? phoneNumber;
  FakeUser({required this.uid, this.phoneNumber});

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class FakeAuthService extends AuthService {
  final User? user;
  FakeAuthService([this.user]);

  @override
  User? get currentUser => user;

  @override
  Stream<User?> get authStateChanges => Stream.value(user);
}

class FakeLocationService extends LocationService {
  DriverPosition? currentPos;

  FakeLocationService({this.currentPos});

  @override
  Future<DriverPosition?> getCurrentPosition() async => currentPos;

  @override
  Stream<DriverPosition> getPositionStream() => const Stream.empty();

  @override
  Future<Map<String, dynamic>> fetchServerDriverState(String uid) async {
    return {
      'isOnDuty': true,
      'hasActiveJob': false,
      'hasActiveOffer': false,
    };
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeIntegrationOfferService extends OfferService {
  final Map<String, StreamController<JobOffer?>> offerStreams = {};
  int acceptCalls = 0;
  int declineCalls = 0;

  StreamController<JobOffer?> getController(String offerId) {
    return offerStreams.putIfAbsent(offerId, () => StreamController<JobOffer?>.broadcast());
  }

  @override
  Stream<JobOffer?> streamActiveOffer({
    required String driverId,
    required String? activeOfferId,
  }) {
    if (activeOfferId == null || activeOfferId.isEmpty) {
      return Stream.value(null);
    }
    return getController(activeOfferId).stream;
  }

  @override
  Future<AcceptJobResult> acceptOffer({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    acceptCalls++;
    return AcceptJobResult(
      accepted: true,
      jobId: jobId,
      offerId: offerId,
      driverId: 'driver_123',
    );
  }

  @override
  Future<DeclineJobResult> declineOffer({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    declineCalls++;
    return DeclineJobResult(
      declined: true,
      jobId: jobId,
      offerId: offerId,
      driverId: 'driver_123',
    );
  }
}

class ControllableDutyController extends DutyController {
  final bool _mockIsOnDuty;
  final AuthoritativeDutyState _mockDutyState;
  final TrackingHealth _mockTrackingHealth;

  ControllableDutyController({
    required super.locationService,
    required super.authService,
    bool isOnDuty = true,
  })  : _mockIsOnDuty = isOnDuty,
        _mockDutyState = isOnDuty ? AuthoritativeDutyState.onDuty : AuthoritativeDutyState.offDuty,
        _mockTrackingHealth = isOnDuty ? TrackingHealth.healthy : TrackingHealth.off;

  @override
  bool get isOnDuty => _mockIsOnDuty;

  @override
  AuthoritativeDutyState get authoritativeDutyState => _mockDutyState;

  @override
  TrackingHealth get trackingHealth => _mockTrackingHealth;

  @override
  bool get isReady => _mockIsOnDuty;

  @override
  bool get canToggleDuty => true;

  @override
  Future<void> reconcileDutyState({bool notify = true}) async {}
}

void main() {
  group('DispatchHubScreen Offer Integration Tests', () {
    final now = DateTime(2026, 10, 6, 12, 0, 0);

    const baseProfile = DriverProfile(
      uid: 'driver_123',
      name: 'Rohan Sharma',
      phone: '+919876543210',
      truckType: TruckType.flatbed,
      vehicleNumber: 'MH 12 AB 1234',
      isOnDuty: true,
      verificationStatus: 'approved',
      activeOfferId: 'offer_100',
    );

    JobOffer createOffer({
      required String id,
      required String jobId,
      JobOfferStatus status = JobOfferStatus.offered,
    }) {
      return JobOffer(
        id: id,
        jobId: jobId,
        driverId: 'driver_123',
        dispatchGeneration: 1,
        status: status,
        offeredAt: now,
        expiresAt: now.add(const Duration(seconds: 45)),
        pickupCoords: const OfferCoordinates(lat: 18.5204, lng: 73.8567),
        destCoords: const OfferCoordinates(lat: 18.5500, lng: 73.8800),
        requestedTruckType: 'flatbed',
        estimatedFarePaise: 250000,
        driverCommissionPaise: 37500,
      );
    }

    testWidgets('incoming offer sheet renders in DispatchHub when on duty and activeOfferId exists (Gate A1, B1)', (tester) async {
      final fakeAuth = FakeAuthService(FakeUser(uid: 'driver_123'));
      final fakeLoc = FakeLocationService();
      final fakeOfferService = FakeIntegrationOfferService();
      final controller = ControllableDutyController(
        locationService: fakeLoc,
        authService: fakeAuth,
        isOnDuty: true,
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: baseProfile,
            authService: fakeAuth,
            locationService: fakeLoc,
            controller: controller,
            offerService: fakeOfferService,
            clock: () => now,
            mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
          ),
        ),
      );
      await tester.pump();

      // Initially no offer received on the stream
      expect(find.byType(IncomingOfferSheet), findsNothing);

      // Stream delivers the authoritative offer
      final offer = createOffer(id: 'offer_100', jobId: 'job_200');
      fakeOfferService.getController('offer_100').add(offer);
      await tester.pump(const Duration(milliseconds: 100));

      // IncomingOfferSheet is rendered above the map view!
      expect(find.byType(IncomingOfferSheet), findsOneWidget);
      expect(find.text('Incoming Job Offer'), findsOneWidget);
      expect(find.text('₹2500.00'), findsOneWidget);
    });

    testWidgets('superseded offer updates immediately when activeOfferId changes (Gate B3)', (tester) async {
      final fakeAuth = FakeAuthService(FakeUser(uid: 'driver_123'));
      final fakeLoc = FakeLocationService();
      final fakeOfferService = FakeIntegrationOfferService();
      final controller = ControllableDutyController(
        locationService: fakeLoc,
        authService: fakeAuth,
        isOnDuty: true,
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: baseProfile,
            authService: fakeAuth,
            locationService: fakeLoc,
            controller: controller,
            offerService: fakeOfferService,
            clock: () => now,
            mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
          ),
        ),
      );
      await tester.pump();

      // Deliver first offer
      final offer1 = createOffer(id: 'offer_100', jobId: 'job_200');
      fakeOfferService.getController('offer_100').add(offer1);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const ValueKey('incoming_offer_offer_100')), findsOneWidget);

      // Now profile updates with superseded/new activeOfferId 'offer_200'
      const updatedProfile = DriverProfile(
        uid: 'driver_123',
        name: 'Rohan Sharma',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        isOnDuty: true,
        verificationStatus: 'approved',
        activeOfferId: 'offer_200',
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: updatedProfile,
            authService: fakeAuth,
            locationService: fakeLoc,
            controller: controller,
            offerService: fakeOfferService,
            clock: () => now,
            mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
          ),
        ),
      );
      await tester.pump();

      // Deliver new offer
      final offer2 = createOffer(id: 'offer_200', jobId: 'job_300');
      fakeOfferService.getController('offer_200').add(offer2);
      await tester.pump(const Duration(milliseconds: 100));

      // Sheet updates to offer_200
      expect(find.byKey(const ValueKey('incoming_offer_offer_200')), findsOneWidget);
      expect(find.byKey(const ValueKey('incoming_offer_offer_100')), findsNothing);
    });

    testWidgets('offer is not shown when driver is off duty', (tester) async {
      final fakeAuth = FakeAuthService();
      final fakeLoc = FakeLocationService();
      final fakeOfferService = FakeIntegrationOfferService();
      final controller = ControllableDutyController(
        locationService: fakeLoc,
        authService: fakeAuth,
        isOnDuty: false, // OFF DUTY
      );

      const offDutyProfile = DriverProfile(
        uid: 'driver_123',
        name: 'Rohan Sharma',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        isOnDuty: false,
        verificationStatus: 'approved',
        activeOfferId: 'offer_100',
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: offDutyProfile,
            authService: fakeAuth,
            locationService: fakeLoc,
            controller: controller,
            offerService: fakeOfferService,
            clock: () => now,
            mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
          ),
        ),
      );
      await tester.pump();

      // Deliver offer
      final offer = createOffer(id: 'offer_100', jobId: 'job_200');
      fakeOfferService.getController('offer_100').add(offer);
      await tester.pump();

      // Because isOnDuty is false, IncomingOfferSheet is NOT displayed!
      expect(find.byType(IncomingOfferSheet), findsNothing);
    });

    testWidgets('decline cascade: clearing activeOfferId removes offer sheet (Gate B4)', (tester) async {
      final fakeAuth = FakeAuthService(FakeUser(uid: 'driver_123'));
      final fakeLoc = FakeLocationService();
      final fakeOfferService = FakeIntegrationOfferService();
      final controller = ControllableDutyController(
        locationService: fakeLoc,
        authService: fakeAuth,
        isOnDuty: true,
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: baseProfile,
            authService: fakeAuth,
            locationService: fakeLoc,
            controller: controller,
            offerService: fakeOfferService,
            clock: () => now,
            mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
          ),
        ),
      );
      await tester.pump();

      // Deliver offer
      final offer = createOffer(id: 'offer_100', jobId: 'job_200');
      fakeOfferService.getController('offer_100').add(offer);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(IncomingOfferSheet), findsOneWidget);

      // Backend cascades decline / redispatch by clearing activeOfferId on driver profile
      const clearedProfile = DriverProfile(
        uid: 'driver_123',
        name: 'Rohan Sharma',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        isOnDuty: true,
        verificationStatus: 'approved',
        activeOfferId: null, // cleared
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: clearedProfile,
            authService: fakeAuth,
            locationService: fakeLoc,
            controller: controller,
            offerService: fakeOfferService,
            clock: () => now,
            mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));

      // Sheet is completely dismissed
      expect(find.byType(IncomingOfferSheet), findsNothing);
    });

    testWidgets('stale offer synchronization: expired status dismisses sheet (Gate B5)', (tester) async {
      final fakeAuth = FakeAuthService(FakeUser(uid: 'driver_123'));
      final fakeLoc = FakeLocationService();
      final fakeOfferService = FakeIntegrationOfferService();
      final controller = ControllableDutyController(
        locationService: fakeLoc,
        authService: fakeAuth,
        isOnDuty: true,
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: baseProfile,
            authService: fakeAuth,
            locationService: fakeLoc,
            controller: controller,
            offerService: fakeOfferService,
            clock: () => now,
            mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
          ),
        ),
      );
      await tester.pump();

      // Deliver active offer
      final offer = createOffer(id: 'offer_100', jobId: 'job_200', status: JobOfferStatus.offered);
      fakeOfferService.getController('offer_100').add(offer);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(IncomingOfferSheet), findsOneWidget);

      // Offer stream updates to expired
      final expiredOffer = createOffer(id: 'offer_100', jobId: 'job_200', status: JobOfferStatus.expired);
      fakeOfferService.getController('offer_100').add(expiredOffer);
      await tester.pump(const Duration(milliseconds: 100));

      // Sheet is dismissed immediately according to server authority
      expect(find.byType(IncomingOfferSheet), findsNothing);
    });

    testWidgets('F05: replacing activeOfferId hides prior offer before new snapshot arrives', (tester) async {
      final fakeAuth = FakeAuthService(FakeUser(uid: 'driver_123'));
      final fakeLoc = FakeLocationService();
      final fakeOfferService = FakeIntegrationOfferService();
      final controller = ControllableDutyController(
        locationService: fakeLoc,
        authService: fakeAuth,
        isOnDuty: true,
      );

      Widget buildHub(String? offerId) => createTestWidget(
        child: DispatchHubScreen(
          profile: DriverProfile(
            uid: 'driver_123',
            name: 'Rohan Sharma',
            phone: '+919876543210',
            truckType: TruckType.flatbed,
            vehicleNumber: 'MH 12 AB 1234',
            isOnDuty: true,
            verificationStatus: 'approved',
            activeOfferId: offerId,
          ),
          authService: fakeAuth,
          locationService: fakeLoc,
          controller: controller,
          offerService: fakeOfferService,
          clock: () => now,
          mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
        ),
      );

      await tester.pumpWidget(buildHub('offer_first'));
      await tester.pump();
      final firstOffer = createOffer(id: 'offer_first', jobId: 'job_1', status: JobOfferStatus.offered);
      fakeOfferService.getController('offer_first').add(firstOffer);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const ValueKey('incoming_offer_offer_first')), findsOneWidget);

      // Re-pump with new activeOfferId before new offer stream emits
      await tester.pumpWidget(buildHub('offer_second'));
      await tester.pump();

      // Old offer must be hidden immediately
      expect(find.byKey(const ValueKey('incoming_offer_offer_first')), findsNothing,
          reason: 'old offer is no longer authoritative activeOfferId');
    });

    testWidgets('F05: controller profile update with null activeOfferId clears incoming offer', (tester) async {
      final fakeAuth = FakeAuthService(FakeUser(uid: 'driver_123'));
      final fakeLoc = FakeLocationService();
      final fakeOfferService = FakeIntegrationOfferService();
      final controller = ControllableDutyController(
        locationService: fakeLoc,
        authService: fakeAuth,
        isOnDuty: true,
      );

      const profileWithOffer = DriverProfile(
        uid: 'driver_123',
        name: 'Rohan Sharma',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        isOnDuty: true,
        verificationStatus: 'approved',
        activeOfferId: 'offer_100',
      );

      await tester.pumpWidget(
        createTestWidget(
          child: DispatchHubScreen(
            profile: profileWithOffer,
            authService: fakeAuth,
            locationService: fakeLoc,
            controller: controller,
            offerService: fakeOfferService,
            clock: () => now,
            mapWidgetBuilder: (context, snapshot) => const SizedBox(key: ValueKey('map_mock')),
          ),
        ),
      );
      await tester.pump();

      final offer = createOffer(id: 'offer_100', jobId: 'job_200', status: JobOfferStatus.offered);
      fakeOfferService.getController('offer_100').add(offer);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(IncomingOfferSheet), findsOneWidget);

      // Controller updates with activeOfferId: null (authoritative clearing)
      controller.updateProfile(const DriverProfile(
        uid: 'driver_123',
        name: 'Rohan Sharma',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        isOnDuty: true,
        verificationStatus: 'approved',
        activeOfferId: null,
      ));
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.byType(IncomingOfferSheet), findsNothing,
          reason: 'controller cleared activeOfferId must dismiss offer sheet');
    });
  });
}
