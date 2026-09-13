// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:driver_app/app/session_resolver.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/auth_service.dart';
import 'package:driver_app/core/services/profile_service.dart';
import 'package:driver_app/features/profile/screens/profile_setup_screen.dart';
import 'package:firebase_auth/firebase_auth.dart';
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

class MockAuthService extends AuthService {
  User? mockUser;
  bool signOutCalled = false;

  @override
  Stream<User?> get authStateChanges => Stream.value(mockUser);

  @override
  Future<void> signOut() async {
    signOutCalled = true;
  }
}

class MockProfileService extends ProfileService {
  ProfileState stateToEmit;
  MockProfileService(this.stateToEmit);

  @override
  Stream<ProfileState> streamProfileState(String uid) {
    return Stream.value(stateToEmit);
  }
}

void main() {
  group('SessionResolver Profile Routing Matrix', () {
    late MockAuthService authService;
    final testUser = FakeUser(uid: 'test_driver_1', phoneNumber: '+919876543210');

    setUp(() {
      authService = MockAuthService();
      authService.mockUser = testUser;
    });

    testWidgets('missing profile (ProfileNotFound) routes to ProfileSetupScreen', (tester) async {
      final profileService = MockProfileService(const ProfileNotFound());

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(ProfileSetupScreen), findsOneWidget);
      expect(find.text('+919876543210'), findsOneWidget);
    });

    testWidgets('incomplete canonical profile routes to ProfileSetupScreen', (tester) async {
      const incompleteProfile = DriverProfile(
        uid: 'test_driver_1',
        name: '',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: '',
      );
      final profileService = MockProfileService(const ProfileIncomplete(incompleteProfile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(ProfileSetupScreen), findsOneWidget);
    });

    testWidgets('completed profile routes to Stage1HomeScreen', (tester) async {
      const completedProfile = DriverProfile(
        uid: 'test_driver_1',
        name: 'Suresh Raina',
        phone: '+919876543210',
        truckType: TruckType.hydraulic,
        vehicleNumber: 'MH 14 CC 1234',
        isOnDuty: false,
        verificationStatus: 'approved',
      );
      final profileService = MockProfileService(const ProfileCompleted(completedProfile));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver app setup complete'), findsOneWidget);
      expect(find.text('Suresh Raina'), findsOneWidget);
    });

    testWidgets('stream error routes to explicit retry error screen', (tester) async {
      final profileService = MockProfileService(ProfileError(Exception('Network timeout')));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Failed to load driver profile. Please try again.'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.text('Driver Profile Setup'), findsNothing);
    });

    testWidgets('live transition: completed profile encountering stream error replaces HomeScreen with ProfileErrorScreen', (tester) async {
      final streamController = StreamController<ProfileState>.broadcast();
      final profileService = ControllableMockProfileService(streamController);

      const completedProfile = DriverProfile(
        uid: 'test_driver_1',
        name: 'Suresh Raina',
        phone: '+919876543210',
        truckType: TruckType.hydraulic,
        vehicleNumber: 'MH 14 CC 1234',
        isOnDuty: false,
        verificationStatus: 'approved',
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      // Allow authStream to deliver user and mount profile StreamBuilder
      await tester.pump();

      // Emit completed profile
      streamController.add(const ProfileCompleted(completedProfile));
      await tester.pump();

      expect(find.text('Driver app setup complete'), findsOneWidget);
      expect(find.text('Suresh Raina'), findsOneWidget);

      // Stream error arrives dynamically
      streamController.add(ProfileError(Exception('Firestore stream disconnection')));
      await tester.pump();

      // Home screen must be replaced by localized error screen
      expect(find.text('Driver app setup complete'), findsNothing);
      expect(find.text('Failed to load driver profile. Please try again.'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);

      await streamController.close();
    });

    testWidgets('tapping Retry resubscribes to profile stream and restores HomeScreen upon recovery', (tester) async {
      StreamController<ProfileState> currentController = StreamController<ProfileState>.broadcast();
      late ControllableMockProfileService profileService;

      const completedProfile = DriverProfile(
        uid: 'test_driver_1',
        name: 'Suresh Raina',
        phone: '+919876543210',
        truckType: TruckType.hydraulic,
        vehicleNumber: 'MH 14 CC 1234',
        isOnDuty: false,
        verificationStatus: 'approved',
      );

      profileService = ControllableMockProfileService(
        currentController,
        onResubscribe: () {
          currentController = StreamController<ProfileState>.broadcast();
          return currentController;
        },
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      // Allow authStream to deliver user and mount profile StreamBuilder
      await tester.pump();

      // Initially emit stream error
      currentController.add(ProfileError(Exception('Initial connection error')));
      await tester.pump();

      expect(find.text('Failed to load driver profile. Please try again.'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(profileService.subscriptionCount, equals(1));

      // Tap Retry
      await tester.tap(find.text('Retry'));
      await tester.pump(); // Triggers onPressed -> _retryProfileStream -> setState
      await tester.pump(); // Rebuilds SessionResolver -> mounts new StreamBuilder -> subscribes

      // Verifies fresh resubscription was triggered
      expect(profileService.subscriptionCount, equals(2));

      // New stream emits recovered profile
      currentController.add(const ProfileCompleted(completedProfile));
      await tester.pump(); // Delivers event to StreamBuilder -> rebuilds with Stage1HomeScreen

      // Home screen is restored
      expect(find.text('Driver app setup complete'), findsOneWidget);
      expect(find.text('Suresh Raina'), findsOneWidget);
      expect(find.text('Failed to load driver profile. Please try again.'), findsNothing);

      await currentController.close();
    });

    testWidgets('live transition: incomplete profile encountering stream error replaces ProfileSetupScreen', (tester) async {
      final streamController = StreamController<ProfileState>.broadcast();
      final profileService = ControllableMockProfileService(streamController);

      const incompleteProfile = DriverProfile(
        uid: 'test_driver_1',
        name: '',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: '',
        isOnDuty: false,
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      // Allow authStream to deliver user and mount profile StreamBuilder
      await tester.pump();

      // Emit incomplete profile
      streamController.add(const ProfileIncomplete(incompleteProfile));
      await tester.pump();

      expect(find.byType(ProfileSetupScreen), findsOneWidget);

      // Stream error arrives dynamically
      streamController.add(ProfileError(Exception('Network timeout during setup')));
      await tester.pump();

      expect(find.byType(ProfileSetupScreen), findsNothing);
      expect(find.text('Failed to load driver profile. Please try again.'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);

      await streamController.close();
    });

    testWidgets('tapping Logout from ProfileErrorScreen invokes authService.signOut', (tester) async {
      final profileService = MockProfileService(ProfileError(Exception('Network error')));

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: profileService,
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('Failed to load driver profile. Please try again.'), findsOneWidget);
      expect(find.text('Logout'), findsOneWidget);

      await tester.tap(find.text('Logout'));
      await tester.pump();

      expect(authService.signOutCalled, isTrue);
    });

    testWidgets('malformed profile routes to fail-closed error screen without setup overwrite option', (tester) async {
      const profileService = ProfileMalformed('Corrupted field data');
      final mockProfileService = MockProfileService(profileService);

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: mockProfileService,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Driver profile data is invalid. Please contact support.'), findsOneWidget);
      expect(find.text('Retry'), findsNothing); // Fail-closed, no retry/overwrite
      expect(find.text('Driver Profile Setup'), findsNothing);
    });
  });

  group('End-to-End Production Chain: Raw Firestore Document -> Parser -> ProfileService -> SessionResolver', () {
    late MockAuthService authService;
    final testUser = FakeUser(uid: 'driver_test_999', phoneNumber: '+919876543210');

    setUp(() {
      authService = MockAuthService();
      authService.mockUser = testUser;
    });

    testWidgets('production chain: raw document with uid: null fails closed to ProfileMalformed (NOT Home, NOT Setup)', (tester) async {
      final docStreamController = StreamController<DocumentSnapshot<Map<String, dynamic>>>.broadcast();
      final realProfileService = ProfileService(
        firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(docStreamController.stream))),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: realProfileService,
          ),
        ),
      );
      await tester.pump();

      // Raw document with uid: null
      final rawDoc = {
        'uid': null,
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
      };

      docStreamController.add(FakeDocumentSnapshot('driver_test_999', rawDoc, true));
      await tester.pump();

      // Must fail closed to localized malformed-profile screen
      expect(find.text('Driver profile data is invalid. Please contact support.'), findsOneWidget);
      expect(find.text('Driver app setup complete'), findsNothing);
      expect(find.byType(ProfileSetupScreen), findsNothing);
      expect(find.text('Retry'), findsNothing);

      await docStreamController.close();
    });

    testWidgets('production chain: raw document with missing uid fails closed to ProfileMalformed', (tester) async {
      final docStreamController = StreamController<DocumentSnapshot<Map<String, dynamic>>>.broadcast();
      final realProfileService = ProfileService(
        firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(docStreamController.stream))),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: realProfileService,
          ),
        ),
      );
      await tester.pump();

      final rawDocMissingUid = {
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
      };

      docStreamController.add(FakeDocumentSnapshot('driver_test_999', rawDocMissingUid, true));
      await tester.pump();

      expect(find.text('Driver profile data is invalid. Please contact support.'), findsOneWidget);
      expect(find.text('Driver app setup complete'), findsNothing);
      expect(find.byType(ProfileSetupScreen), findsNothing);
      expect(find.text('Retry'), findsNothing);

      await docStreamController.close();
    });

    testWidgets('production chain: raw document with wrong-type uid (integer) fails closed to ProfileMalformed', (tester) async {
      final docStreamController = StreamController<DocumentSnapshot<Map<String, dynamic>>>.broadcast();
      final realProfileService = ProfileService(
        firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(docStreamController.stream))),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: realProfileService,
          ),
        ),
      );
      await tester.pump();

      final rawDocWrongType = {
        'uid': 999,
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
      };

      docStreamController.add(FakeDocumentSnapshot('driver_test_999', rawDocWrongType, true));
      await tester.pump();

      expect(find.text('Driver profile data is invalid. Please contact support.'), findsOneWidget);
      expect(find.text('Driver app setup complete'), findsNothing);
      expect(find.byType(ProfileSetupScreen), findsNothing);
      expect(find.text('Retry'), findsNothing);

      await docStreamController.close();
    });

    testWidgets('production chain: raw document with mismatched uid fails closed to ProfileMalformed', (tester) async {
      final docStreamController = StreamController<DocumentSnapshot<Map<String, dynamic>>>.broadcast();
      final realProfileService = ProfileService(
        firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(docStreamController.stream))),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: realProfileService,
          ),
        ),
      );
      await tester.pump();

      final rawDocMismatched = {
        'uid': 'other_driver_uid',
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
      };

      docStreamController.add(FakeDocumentSnapshot('driver_test_999', rawDocMismatched, true));
      await tester.pump();

      expect(find.text('Driver profile data is invalid. Please contact support.'), findsOneWidget);
      expect(find.text('Driver app setup complete'), findsNothing);
      expect(find.byType(ProfileSetupScreen), findsNothing);
      expect(find.text('Retry'), findsNothing);

      await docStreamController.close();
    });

    testWidgets('production chain: canonical valid document routes to Home screen', (tester) async {
      final docStreamController = StreamController<DocumentSnapshot<Map<String, dynamic>>>.broadcast();
      final realProfileService = ProfileService(
        firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(docStreamController.stream))),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: realProfileService,
          ),
        ),
      );
      await tester.pump();

      final canonicalDoc = {
        'uid': 'driver_test_999',
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
        'verificationStatus': 'approved',
      };

      docStreamController.add(FakeDocumentSnapshot('driver_test_999', canonicalDoc, true));
      await tester.pump();

      expect(find.text('Driver app setup complete'), findsOneWidget);
      expect(find.text('Suresh Raina'), findsOneWidget);
      expect(find.byType(ProfileSetupScreen), findsNothing);

      await docStreamController.close();
    });

    testWidgets('production chain: valid document with legal server-owned fields routes to Home screen', (tester) async {
      final docStreamController = StreamController<DocumentSnapshot<Map<String, dynamic>>>.broadcast();
      final realProfileService = ProfileService(
        firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(docStreamController.stream))),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: realProfileService,
          ),
        ),
      );
      await tester.pump();

      final serverOwnedDoc = {
        'uid': 'driver_test_999',
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
        'walletBalance': 10000,
        'canFlatbed': true,
        'canPulling': true,
        'activeJobId': null,
        'verificationStatus': 'approved',
      };

      docStreamController.add(FakeDocumentSnapshot('driver_test_999', serverOwnedDoc, true));
      await tester.pump();

      expect(find.text('Driver app setup complete'), findsOneWidget);
      expect(find.text('Suresh Raina'), findsOneWidget);

      await docStreamController.close();
    });

    testWidgets('production chain: legacy verificationStatus "verified" fails closed to ProfileMalformed', (tester) async {
      final docStreamController = StreamController<DocumentSnapshot<Map<String, dynamic>>>.broadcast();
      final realProfileService = ProfileService(
        firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(docStreamController.stream))),
      );

      await tester.pumpWidget(
        createTestWidget(
          child: SessionResolver(
            authService: authService,
            profileService: realProfileService,
          ),
        ),
      );
      await tester.pump();

      final legacyDoc = {
        'uid': 'driver_test_999',
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
        'verificationStatus': 'verified',
      };

      docStreamController.add(FakeDocumentSnapshot('driver_test_999', legacyDoc, true));
      await tester.pump();

      expect(find.text('Driver profile data is invalid. Please contact support.'), findsOneWidget);
      expect(find.text('Driver app setup complete'), findsNothing);
      expect(find.byType(ProfileSetupScreen), findsNothing);
      expect(find.text('Retry'), findsNothing);

      await docStreamController.close();
    });
  });
}

class FakeDocumentSnapshot implements DocumentSnapshot<Map<String, dynamic>> {
  final String _id;
  final Map<String, dynamic>? _data;
  final bool _exists;

  FakeDocumentSnapshot(this._id, this._data, [this._exists = true]);

  @override
  String get id => _id;

  @override
  Map<String, dynamic>? data() => _data;

  @override
  bool get exists => _exists;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeDocRef implements DocumentReference<Map<String, dynamic>> {
  final Stream<DocumentSnapshot<Map<String, dynamic>>> _snapshotsStream;
  FakeDocRef(this._snapshotsStream);

  @override
  Stream<DocumentSnapshot<Map<String, dynamic>>> snapshots({
    bool includeMetadataChanges = false,
    ListenSource source = ListenSource.defaultSource,
  }) => _snapshotsStream;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeCollectionRef implements CollectionReference<Map<String, dynamic>> {
  final FakeDocRef docRef;
  FakeCollectionRef(this.docRef);

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) => docRef;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeFirestore implements FirebaseFirestore {
  final FakeCollectionRef colRef;
  FakeFirestore(this.colRef);

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) => colRef;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class ControllableMockProfileService extends ProfileService {
  StreamController<ProfileState> controller;
  int subscriptionCount = 0;
  final StreamController<ProfileState> Function()? onResubscribe;

  ControllableMockProfileService(this.controller, {this.onResubscribe});

  @override
  Stream<ProfileState> streamProfileState(String uid) {
    subscriptionCount++;
    if (subscriptionCount > 1 && onResubscribe != null) {
      controller = onResubscribe!();
    }
    return controller.stream;
  }
}
